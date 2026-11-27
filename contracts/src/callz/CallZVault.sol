// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ECDSA} from "solady/utils/ECDSA.sol";
import {EIP712} from "solady/utils/EIP712.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

/// @notice A verified callout, signed by the attester (EIP-712).
/// @param holder       Who posted the link and earns from it.
/// @param token        The token the callout is about.
/// @param epoch        The round the approval is for. It only counts in that round.
/// @param kind         0 X, 1 pump.fun, 2 fomo.family, 3 callz.fun.
/// @param linkHash     keccak256 of the link's canonical text. A link counts once, for one holder, ever.
/// @param profileHash  keccak256 of the poster's profile on that site, or zero when the site has none.
/// @param mcap         The token's market cap in whole US dollars when the callout was posted.
/// @param held         What the holder's wallet held of the token when the callout was posted.
/// @param nonce        The review record's id. Signed so two approvals never share a digest.
/// @param deadline     Last second the approval can be recorded.
struct Submission {
    address holder;
    address token;
    uint256 epoch;
    uint8 kind;
    bytes32 linkHash;
    bytes32 profileHash;
    uint256 mcap;
    uint256 held;
    uint256 nonce;
    uint256 deadline;
}

/// @title CallZVault
/// @notice Holds every fee CallZ collects, in BNB, and pays it to the people who call a token out. One contract
///         keeps a separate book per token.
///
///         Fees arrive through `deposit(token)`: the launch fee from a CallZ mint and the trading fee from the
///         CallZ router. Each deposit is split three ways on arrival:
///
///           45%  holder share      shared between the holders whose callouts are already recorded in the
///                                  round when the fee arrives, by weight
///           30%  callout pool      split equally per verified callout of that round
///           25%  platform          sent to the team wallet as it arrives
///
///         A caller's weight is what they held when their callout was recorded (their snapshot) divided by the
///         token's market cap when they posted it. So the same holdings called at half the market cap weigh
///         twice as much: the weight follows the gain since the call. And because a fee is shared only between
///         the callers already in the round, a caller earns from the trading that comes after their callout:
///         the earlier the call, the more volume it earns from. A fee that arrives before the round has any
///         caller goes to the round's callout pool.
///
///         Nothing is staked or locked here: the vault never holds anyone's tokens. A holder's tokens stay in
///         their wallet, and the vault reads the wallet's balance when their first callout of the round is
///         recorded. That snapshot is their weight in the round's holder share.
///
///         After the round ends, the balances of all the round's callers are read once more, together, in one
///         transaction: the checkpoint. A caller's holder share is paid on what they still hold then. Because
///         every wallet is read at the same moment, tokens passed from one caller's wallet to another's are
///         counted once, in the wallet that holds them at the checkpoint.
///
///         A round is one UTC day. A callout counts when the attester signed it for the running round and it is
///         recorded here before the round ends. Every recorded link is emitted in full, so the list of rewarded
///         links is public. A round's rewards can be claimed during the 24 hours after the round ends. Whatever
///         is not claimed by then goes to the team wallet.
///
///         Nobody signs for the team's money: the platform share is forwarded on every deposit, and every
///         deposit also sweeps up to two finished rounds, so rounds are settled by the fees that keep
///         arriving. A holder collects everything owed for a token with one `claim`.
///
///         Solvency: every token has a ledger of what its fees brought in for its callers and what has been paid
///         out of that. A payout that would take a token's ledger past what the token produced reverts, so one
///         token's rewards can never be paid with another token's fees, whatever else happens.
///
/// @dev Trust: the attester can approve any link, which mints callout claims and a place in the holder share,
///      within the per-round cap on links per holder. The guardian can replace the attester and move the split
///      (the platform share can never exceed 25%), but only by scheduling the change and waiting `CHANGE_DELAY`:
///      the pending change is public for that time and anyone can apply it afterwards. The guardian can stop new
///      callouts from being recorded at once, which is the answer to an attester key that has leaked. It can also
///      replace the team wallet and change the round rules. None of this can touch amounts already owed.
///
///      The holder share is cut down in proportion when the holder holds less at the round's checkpoint than
///      their snapshot, so buying, calling out and selling earns nothing from it.
contract CallZVault is EIP712, ReentrancyGuard {
    using SafeTransferLib for address;

    /// @notice Length of a round. Round `n` runs from `n * EPOCH` to `(n + 1) * EPOCH`, unix time.
    uint256 public constant EPOCH = 1 days;
    /// @notice How long a round's rewards stay claimable after the round ends.
    uint256 public constant CLAIM_WINDOW = 24 hours;
    /// @notice Gas given to the team wallet when money is forwarded to it inside a deposit. A wallet that needs
    ///         more is not paid then: the amount waits in `platformAccrued` for `collect`.
    uint256 public constant TEAM_SEND_GAS = 30_000;
    /// @notice A deposit smaller than this opens no round: it goes to the team wallet. Keeps dust from filling the
    ///         queue of rounds waiting to be swept.
    uint256 public constant MIN_ROUND_FEE = 1e12;
    /// @notice The platform share can be lowered, never raised past this.
    uint16 public constant MAX_PLATFORM_BPS = 2500;
    uint256 public constant MAX_LINK_BYTES = 256;
    /// @notice How long a new attester or a new split waits between being scheduled and taking effect.
    uint256 public constant CHANGE_DELAY = 2 days;
    /// @notice The most holders one round's holder share can have for one token. It bounds the checkpoint, which
    ///         reads every one of them in a single transaction.
    uint256 public constant MAX_ROUND_CALLERS = 256;
    uint8 public constant MAX_KIND = 3;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant PPM = 1_000_000;
    /// @dev A weight is `holdings * WEIGHT_SCALE / mcap`.
    uint256 internal constant WEIGHT_SCALE = 1e6;
    /// @dev Fixed-point scale of a round's holder share per unit of weight.
    uint256 internal constant ACC_SCALE = 1e36;

    bytes32 public constant SUBMISSION_TYPEHASH = keccak256(
        "Submission(address holder,address token,uint256 epoch,uint8 kind,bytes32 linkHash,bytes32 profileHash,uint256 mcap,uint256 held,uint256 nonce,uint256 deadline)"
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Roles and rules
    // ─────────────────────────────────────────────────────────────────────────

    address public guardian;
    address public pendingGuardian;
    /// @notice Signs verified callouts.
    address public attester;
    /// @notice Receives the platform share and rewards nobody claimed in time.
    address public teamWallet;

    /// @notice The attester that takes over at `attesterEta`, once someone applies it. Zero when none is scheduled.
    address public pendingAttester;
    /// @notice The first second the scheduled attester can be applied.
    uint64 public attesterEta;
    /// @notice The split that takes over at `splitEta`, once someone applies it.
    uint16 public pendingHoldersBps;
    uint16 public pendingCalloutBps;
    uint16 public pendingPlatformBps;
    /// @notice The first second the scheduled split can be applied. Zero when none is scheduled.
    uint64 public splitEta;
    /// @notice While set, no callout can be recorded. Claims, sweeps and deposits are not affected.
    bool public submissionsPaused;

    /// @notice Share of every fee that goes to the round's holder share, in bps.
    uint16 public holdersBps = 4500;
    /// @notice Share of every fee that goes to the round's callout pool, in bps.
    uint16 public calloutBps = 3000;
    /// @notice Share of every fee that goes to the team wallet, in bps.
    uint16 public platformBps = 2500;

    /// @notice Verified links a holder needs in a round to join that round's holder share.
    uint8 public requiredLinks = 1;
    /// @notice The most links one holder can record for one token in one round.
    uint8 public maxLinksPerEpoch = 3;
    /// @notice The least a holder must hold to record a callout, in parts per million of the token's supply.
    ///         100 is 0.01%.
    uint32 public minHoldPpm = 100;

    // ─────────────────────────────────────────────────────────────────────────
    // Books
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice BNB owed to the team wallet that could not be sent to it when it fell due. `collect` sends it.
    uint256 public platformAccrued;

    /// @dev What a token's fees brought in for its callers (everything but the platform share), and what has
    ///      been paid out of it.
    struct Ledger {
        uint128 received;
        uint128 paid;
    }

    struct Round {
        /// @dev The holder share: paid to the round's verified callers by their snapshot of holdings.
        uint128 pot;
        /// @dev The callout pool: paid per verified link.
        uint128 pool;
        uint104 claimedPot;
        uint104 claimedPool;
        /// @dev Verified links recorded in the round.
        uint24 links;
        /// @dev In the sweep queue.
        bool listed;
        bool swept;
        /// @dev The round's callers' balances have been read, together, after the round ended.
        bool checkpointed;
        /// @dev Sum of the weights of the holders in the holder share.
        uint256 totalWeight;
        /// @dev Holder share paid so far per unit of weight, scaled by ACC_SCALE.
        uint256 acc;
    }

    /// @dev A round waiting to be swept once its claim window has passed.
    struct RoundRef {
        address token;
        uint64 epoch;
    }

    struct Entry {
        uint8 links;
        /// @dev In the round's holder share.
        bool unlocked;
        bool claimedHolder;
        bool claimedCallout;
        /// @dev What the holder still held of their snapshot at the round's checkpoint. The holder share is paid
        ///      on this.
        uint128 kept;
        /// @dev The snapshot: tokens in the holder's wallet when they joined the holder share.
        uint256 held;
        /// @dev `held * WEIGHT_SCALE / mcap`.
        uint256 weight;
        /// @dev The round's `acc` when they joined: they earn from fees that arrive after it.
        uint256 accAtJoin;
    }

    mapping(address token => mapping(uint256 epoch => Round)) internal _rounds;
    mapping(address token => mapping(uint256 epoch => mapping(address holder => Entry))) internal _entries;
    /// @dev The holders in each round's holder share, in the order they joined: the wallets the checkpoint reads.
    mapping(address token => mapping(uint256 epoch => address[])) internal _callers;
    mapping(address token => Ledger) internal _ledgers;
    /// @dev Every round that received a fee, in the order they opened. Rounds open in time order, so the ones
    ///      whose claim window has passed are always at the front.
    RoundRef[] internal _queue;
    /// @notice How many rounds of the queue have been swept.
    uint256 public sweepCursor;
    /// @notice Whether a link has been recorded. One link, one holder, ever.
    mapping(bytes32 linkHash => bool) public usedLink;

    // ─────────────────────────────────────────────────────────────────────────
    // Events and errors
    // ─────────────────────────────────────────────────────────────────────────

    event Deposited(address indexed token, address indexed from, uint256 indexed epoch, uint256 amount);
    event Submitted(
        address indexed holder, address indexed token, uint256 indexed epoch, uint8 kind, bytes32 linkHash, string link
    );
    /// @notice `holder` joined the round's holder share: `held` tokens in their wallet, called at a market cap of
    ///         `mcap` US dollars.
    event Snapshot(
        address indexed holder, address indexed token, uint256 indexed epoch, uint256 held, uint256 mcap, uint256 weight
    );
    /// @param bucket 1 holder share, 2 callout pool.
    event Claimed(address indexed holder, address indexed token, uint256 epoch, uint8 bucket, uint256 amount);
    /// @notice A round's claim window passed: what nobody claimed of its holder share and its callout pool went
    ///         to the team wallet.
    event UnclaimedSwept(address indexed token, uint256 indexed epoch, uint256 amount, address teamWallet);
    event TeamPaid(uint256 amount, address teamWallet);
    /// @notice A finished round's callers were read together: `callers` wallets, in one transaction.
    event Checkpointed(address indexed token, uint256 indexed epoch, uint256 callers);
    event AttesterSet(address attester);
    /// @notice `attester` takes over at `eta` once someone applies it. Zero and zero when a schedule is cancelled.
    event AttesterScheduled(address attester, uint256 eta);
    /// @notice The split takes over at `eta` once someone applies it. All zero when a schedule is cancelled.
    event SplitScheduled(uint16 holdersBps, uint16 calloutBps, uint16 platformBps, uint256 eta);
    event SubmissionsPausedSet(bool paused);
    event TeamWalletSet(address teamWallet);
    event SplitSet(uint16 holdersBps, uint16 calloutBps, uint16 platformBps);
    event RulesSet(uint8 requiredLinks, uint8 maxLinksPerEpoch, uint32 minHoldPpm);
    event GuardianTransferStarted(address indexed pendingGuardian);
    event GuardianChanged(address indexed guardian);

    error ZeroAddress();
    error NotGuardian();
    error InvalidSplit();
    error InvalidRules();
    error WrongEpoch();
    error Expired();
    error InvalidKind();
    error LinkTooLong();
    error LinkMismatch();
    error LinkUsed();
    error BadSignature();
    error TooManyLinks();
    error BelowMinHold();
    error ZeroMarketCap();
    error NothingToClaim();
    error BnbTransferFailed();
    error Insolvent();
    error NothingScheduled();
    error TooEarly();
    error SubmissionsPaused();
    error RoundRunning();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(address guardian_, address attester_, address teamWallet_) {
        if (guardian_ == address(0) || attester_ == address(0) || teamWallet_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        attester = attester_;
        teamWallet = teamWallet_;
        emit GuardianChanged(guardian_);
        emit AttesterSet(attester_);
        emit TeamWalletSet(teamWallet_);
    }

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("CallZ Vault", "1");
    }

    /// @notice The running round.
    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH;
    }

    /// @notice The last second a round's rewards can be claimed: 24 hours after the round ends.
    function claimDeadline(uint256 epoch) public pure returns (uint256) {
        return (epoch + 1) * EPOCH + CLAIM_WINDOW;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fees in
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Pay a fee for `token` into the vault. Anyone can; the CallZ router and the CallZ mints do.
    /// @dev Splits the value into the three buckets, forwards the platform share to the team wallet, and sweeps
    ///      up to two finished rounds. No loop, and nothing here can revert the trade or launch that
    ///      pays it: if the team wallet does not take the money, it waits in `platformAccrued`.
    function deposit(address token) external payable {
        uint256 value = msg.value;
        if (value == 0) return;
        if (value < MIN_ROUND_FEE) {
            _forwardToTeam(value);
            return;
        }

        uint256 toHolders = (value * holdersBps) / BPS;
        uint256 toCallouts = (value * calloutBps) / BPS;
        uint256 epoch = currentEpoch();

        _ledgers[token].received += uint128(toHolders + toCallouts);
        Round storage r = _rounds[token][epoch];
        uint256 totalWeight = r.totalWeight;
        if (totalWeight == 0) {
            // Nobody has called the token out this round yet: the holder share joins the callout pool.
            r.pool += uint128(toHolders + toCallouts);
        } else {
            r.pot += uint128(toHolders);
            r.pool += uint128(toCallouts);
            r.acc += (toHolders * ACC_SCALE) / totalWeight;
        }
        if (!r.listed) {
            r.listed = true;
            _queue.push(RoundRef(token, uint64(epoch)));
        }
        emit Deposited(token, msg.sender, epoch, value);

        // The platform takes its share and whatever the divisions above rounded off, plus the unclaimed rewards of
        // up to two finished rounds.
        _forwardToTeam(value - toHolders - toCallouts + _sweepNext() + _sweepNext());
    }

    /// @notice BNB sent without naming a token has no book to go to, so it is the team's.
    receive() external payable {
        platformAccrued += msg.value;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The team's money: platform share and unclaimed rewards
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Sweeps the round at the front of the queue if its claim window has passed, and returns what it held
    ///      unclaimed. The amount leaves the token's ledger here and is never more than the ledger has left.
    function _sweepNext() private returns (uint256 amount) {
        uint256 cursor = sweepCursor;
        if (cursor >= _queue.length) return 0;
        RoundRef memory ref = _queue[cursor];
        if (block.timestamp <= claimDeadline(ref.epoch)) return 0;
        sweepCursor = cursor + 1;

        Round storage r = _rounds[ref.token][ref.epoch];
        r.swept = true;
        amount = uint256(r.pot) - r.claimedPot + uint256(r.pool) - r.claimedPool;
        Ledger storage l = _ledgers[ref.token];
        uint256 left = uint256(l.received) - l.paid;
        if (amount > left) amount = left;
        l.paid += uint128(amount);
        emit UnclaimedSwept(ref.token, ref.epoch, amount, teamWallet);
    }

    /// @dev Sends `amount` to the team wallet with a fixed amount of gas. If the wallet does not take it, the
    ///      amount is kept for `collect` instead of failing whatever paid the fee.
    function _forwardToTeam(uint256 amount) private {
        if (amount == 0) return;
        address to = teamWallet;
        (bool ok,) = to.call{value: amount, gas: TEAM_SEND_GAS}("");
        if (ok) emit TeamPaid(amount, to);
        else platformAccrued += amount;
    }

    /// @notice Settle up to `maxRounds` finished rounds and send everything owed to the team wallet. Anyone can
    ///         call it; it is only needed when fees have stopped arriving, or the team wallet could not be paid
    ///         inside a deposit.
    function collect(uint256 maxRounds) external nonReentrant returns (uint256 amount) {
        for (uint256 i; i < maxRounds; ++i) {
            uint256 cursor = sweepCursor;
            amount += _sweepNext();
            if (sweepCursor == cursor) break;
        }
        amount += platformAccrued;
        platformAccrued = 0;
        if (amount == 0) revert NothingToClaim();
        address to = teamWallet;
        emit TeamPaid(amount, to);
        _sendBnb(to, amount);
    }

    /// @notice Finished rounds waiting to be swept, looking at up to `maxScan` of them, and the BNB they would
    ///         send to the team wallet, on top of `platformAccrued`.
    function pendingSweep(uint256 maxScan) external view returns (uint256 rounds, uint256 amount) {
        uint256 length = _queue.length;
        for (uint256 i = sweepCursor; i < length && rounds < maxScan; ++i) {
            RoundRef memory ref = _queue[i];
            if (block.timestamp <= claimDeadline(ref.epoch)) break;
            Round storage r = _rounds[ref.token][ref.epoch];
            amount += uint256(r.pot) - r.claimedPot + uint256(r.pool) - r.claimedPool;
            ++rounds;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Callouts
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice What `holder` holds of `token` right now, read from the token. Nothing is staked or locked.
    function holdingOf(address token, address holder) public view returns (uint256) {
        return token.balanceOf(holder);
    }

    /// @notice Record a callout the attester verified. Anyone can send it; it counts for `s.holder`.
    /// @dev The holder's first callout of the round (the `requiredLinks`-th, if more are required) takes their
    ///      snapshot: the balance of the token in their wallet at this moment, and never more than the attested
    ///      balance they had when they posted the callout.
    /// @param link The link's canonical text. Emitted, so every rewarded link is public.
    function submitAttested(Submission calldata s, string calldata link, bytes calldata signature) external {
        if (submissionsPaused) revert SubmissionsPaused();
        uint256 epoch = currentEpoch();
        if (s.epoch != epoch) revert WrongEpoch();
        if (block.timestamp > s.deadline) revert Expired();
        if (s.kind > MAX_KIND) revert InvalidKind();
        if (s.mcap == 0) revert ZeroMarketCap();
        if (bytes(link).length == 0 || bytes(link).length > MAX_LINK_BYTES) revert LinkTooLong();
        if (keccak256(bytes(link)) != s.linkHash) revert LinkMismatch();
        if (usedLink[s.linkHash]) revert LinkUsed();
        if (!_signedByAttester(_digest(s), signature)) revert BadSignature();

        Entry storage e = _entries[s.token][epoch][s.holder];
        if (e.links >= maxLinksPerEpoch) revert TooManyLinks();
        // The snapshot is the smaller of what the wallet held when the callout was posted (attested) and what
        // it holds now. Tokens moved in only for the moment of recording therefore add nothing.
        uint256 holding = holdingOf(s.token, s.holder);
        if (s.held < holding) holding = s.held;
        if (holding == 0 || holding * PPM < _totalSupply(s.token) * minHoldPpm) revert BelowMinHold();
        // The checkpoint keeps what is still held in 128 bits: far above any real supply.
        if (holding > type(uint128).max) holding = type(uint128).max;

        usedLink[s.linkHash] = true;
        Round storage r = _rounds[s.token][epoch];
        e.links += 1;
        r.links += 1;
        emit Submitted(s.holder, s.token, epoch, s.kind, s.linkHash, link);

        // A round's holder share takes at most MAX_ROUND_CALLERS holders, so that its checkpoint fits in one
        // transaction. A callout recorded after that still earns from the callout pool.
        address[] storage callers = _callers[s.token][epoch];
        if (!e.unlocked && e.links >= requiredLinks && callers.length < MAX_ROUND_CALLERS) {
            uint256 weight = FixedPointMathLib.fullMulDiv(holding, WEIGHT_SCALE, s.mcap);
            if (weight != 0) {
                callers.push(s.holder);
                e.unlocked = true;
                e.held = holding;
                e.weight = weight;
                e.accAtJoin = r.acc;
                r.totalWeight += weight;
                emit Snapshot(s.holder, s.token, epoch, holding, s.mcap, weight);
            }
        }
    }

    function _digest(Submission calldata s) private view returns (bytes32) {
        return _hashTypedData(
            keccak256(
                abi.encode(
                    SUBMISSION_TYPEHASH,
                    s.holder,
                    s.token,
                    s.epoch,
                    s.kind,
                    s.linkHash,
                    s.profileHash,
                    s.mcap,
                    s.held,
                    s.nonce,
                    s.deadline
                )
            )
        );
    }

    /// @dev A plain wallet signature is checked first, by recovery: it stands whether or not the wallet carries
    ///      delegated code (EIP-7702), which a check that looks at the wallet's code first would turn away. Only
    ///      if that does not match is the attester asked as a contract (ERC-1271), so it can also be a multisig.
    function _signedByAttester(bytes32 digest, bytes calldata signature) private view returns (bool) {
        address signer = attester;
        if (signature.length == 65 && ECDSA.tryRecoverCalldata(digest, signature) == signer) return true;
        return signer.code.length != 0 && SignatureCheckerLib.isValidSignatureNowCalldata(signer, digest, signature);
    }

    function _totalSupply(address token) private view returns (uint256 supply) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("totalSupply()"));
        if (!ok || data.length < 32) revert BelowMinHold();
        supply = abi.decode(data, (uint256));
    }

    /// @notice Collect everything `token` owes the caller for the listed rounds, in one transaction: their part
    ///         of each round's holder share and their callout rewards.
    /// @dev A listed round that is still running, or whose 24-hour claim window has passed, is skipped.
    ///      The holder share is paid on what the caller still held of their snapshot at the round's checkpoint;
    ///      what that cuts off stays in the round and is swept. The first claim of a round takes its checkpoint.
    function claim(address token, uint256[] calldata epochs) external nonReentrant returns (uint256 total) {
        for (uint256 i; i < epochs.length; ++i) {
            total += _claimRound(token, epochs[i]);
        }
        if (total == 0) revert NothingToClaim();
        _book(token, total);
        _sendBnb(msg.sender, total);
    }

    /// @notice Collect everything several tokens owe the caller for the listed rounds, in one transaction. A
    ///         token that owes nothing is skipped.
    function claimMany(address[] calldata tokens, uint256[] calldata epochs)
        external
        nonReentrant
        returns (uint256 total)
    {
        for (uint256 t; t < tokens.length; ++t) {
            address token = tokens[t];
            uint256 owed;
            for (uint256 i; i < epochs.length; ++i) {
                owed += _claimRound(token, epochs[i]);
            }
            if (owed != 0) {
                _book(token, owed);
                total += owed;
            }
        }
        if (total == 0) revert NothingToClaim();
        _sendBnb(msg.sender, total);
    }

    /// @notice Read the balances of all the callers of a finished round, together, and fix what each still holds
    ///         of their snapshot. Anyone can call it, once per round; the round's first claim does it otherwise.
    function checkpoint(address token, uint256 epoch) external nonReentrant {
        if (epoch >= currentEpoch()) revert RoundRunning();
        _checkpoint(token, epoch, _rounds[token][epoch]);
    }

    /// @dev Every caller's wallet is read in this one call, so tokens cannot be in two of them: a bag passed
    ///      between callers' wallets counts where it is now and nowhere else. The read is a static call.
    function _checkpoint(address token, uint256 epoch, Round storage r) private {
        if (r.checkpointed) return;
        r.checkpointed = true;
        address[] storage callers = _callers[token][epoch];
        uint256 count = callers.length;
        for (uint256 i; i < count; ++i) {
            address holder = callers[i];
            Entry storage e = _entries[token][epoch][holder];
            uint256 holding = holdingOf(token, holder);
            uint256 held = e.held;
            e.kept = uint128(holding < held ? holding : held);
        }
        emit Checkpointed(token, epoch, count);
    }

    function _claimRound(address token, uint256 epoch) private returns (uint256 total) {
        if (epoch >= currentEpoch() || block.timestamp > claimDeadline(epoch)) return 0;
        Round storage r = _rounds[token][epoch];
        if (r.swept) return 0;
        _checkpoint(token, epoch, r);
        Entry storage e = _entries[token][epoch][msg.sender];

        if (e.unlocked && !e.claimedHolder) {
            e.claimedHolder = true;
            uint256 payout = _holderPayout(r, e, e.kept);
            r.claimedPot += uint104(payout);
            total += payout;
            emit Claimed(msg.sender, token, epoch, 1, payout);
        }
        if (e.links != 0 && !e.claimedCallout) {
            e.claimedCallout = true;
            uint256 payout = (uint256(r.pool) / r.links) * e.links;
            r.claimedPool += uint104(payout);
            total += payout;
            emit Claimed(msg.sender, token, epoch, 2, payout);
        }
    }

    /// @dev What the holder share owes an entry: its weight's part of every fee that arrived after it joined,
    ///      cut down in proportion if `holding`, what the holder kept at the checkpoint, is less than their
    ///      snapshot.
    function _holderPayout(Round storage r, Entry storage e, uint256 holding) private view returns (uint256 payout) {
        payout = FixedPointMathLib.fullMulDiv(e.weight, r.acc - e.accAtJoin, ACC_SCALE);
        if (holding < e.held) payout = FixedPointMathLib.fullMulDiv(payout, holding, e.held);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A token's ledger: BNB its fees brought in for its callers, and BNB paid out of that. `paid` can
    ///         never pass `received`.
    function ledgerOf(address token) external view returns (uint256 received, uint256 paid) {
        Ledger storage l = _ledgers[token];
        return (l.received, l.paid);
    }

    /// @notice A round's book. Its rewards can be claimed from the end of the round until `deadline`.
    function roundOf(address token, uint256 epoch)
        external
        view
        returns (
            uint256 holderShare,
            uint256 calloutPool,
            uint256 claimedHolderShare,
            uint256 claimedCalloutPool,
            uint256 totalWeight,
            uint256 links,
            uint256 deadline,
            bool swept
        )
    {
        Round storage r = _rounds[token][epoch];
        holderShare = r.pot;
        calloutPool = r.pool;
        claimedHolderShare = r.claimedPot;
        claimedCalloutPool = r.claimedPool;
        totalWeight = r.totalWeight;
        links = r.links;
        deadline = claimDeadline(epoch);
        swept = r.swept;
    }

    /// @notice What `holder` did in a round, and what `claim` would pay for it right now. `snapshot` is the
    ///         token balance recorded for them, zero until they are in the holder share. Both payouts are zero
    ///         while the round is running and once its claim window has passed.
    function progress(address token, uint256 epoch, address holder)
        external
        view
        returns (
            uint256 links,
            bool inHolderShare,
            uint256 snapshot,
            bool claimedHolder,
            bool claimedCallout,
            uint256 holderPayout,
            uint256 calloutPayout
        )
    {
        Entry storage e = _entries[token][epoch][holder];
        links = e.links;
        inHolderShare = e.unlocked;
        snapshot = e.held;
        claimedHolder = e.claimedHolder;
        claimedCallout = e.claimedCallout;
        (holderPayout, calloutPayout) = _payouts(token, epoch, holder);
    }

    function _payouts(address token, uint256 epoch, address holder)
        private
        view
        returns (uint256 holderPayout, uint256 calloutPayout)
    {
        Round storage r = _rounds[token][epoch];
        if (epoch >= currentEpoch() || block.timestamp > claimDeadline(epoch) || r.swept) return (0, 0);
        Entry storage e = _entries[token][epoch][holder];
        // Before the checkpoint this is an estimate from the wallet's balance now; after it, the amount is fixed.
        if (e.unlocked && !e.claimedHolder) {
            holderPayout = _holderPayout(r, e, r.checkpointed ? e.kept : holdingOf(token, holder));
        }
        if (e.links != 0 && !e.claimedCallout) calloutPayout = (uint256(r.pool) / r.links) * e.links;
    }

    /// @notice The holders in a round's holder share, and whether the round's checkpoint has been taken.
    function callersOf(address token, uint256 epoch)
        external
        view
        returns (address[] memory callers, bool checkpointed)
    {
        return (_callers[token][epoch], _rounds[token][epoch].checkpointed);
    }

    /// @notice How many rounds have ever received a fee. `sweepCursor` of them have been swept.
    function roundCount() external view returns (uint256) {
        return _queue.length;
    }

    /// @notice The EIP-712 digest the attester signs for `s`.
    function submissionDigest(Submission calldata s) external view returns (bytes32) {
        return _digest(s);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Guardian
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Schedule a new attester. It can be applied `CHANGE_DELAY` later, and until then the current one
    ///         keeps signing. Scheduling again replaces the pending one and restarts the wait.
    function scheduleAttester(address attester_) external onlyGuardian {
        if (attester_ == address(0)) revert ZeroAddress();
        uint256 eta = block.timestamp + CHANGE_DELAY;
        pendingAttester = attester_;
        attesterEta = uint64(eta);
        emit AttesterScheduled(attester_, eta);
    }

    /// @notice Drop the scheduled attester.
    function cancelAttester() external onlyGuardian {
        if (attesterEta == 0) revert NothingScheduled();
        pendingAttester = address(0);
        attesterEta = 0;
        emit AttesterScheduled(address(0), 0);
    }

    /// @notice Put the scheduled attester in place once its wait is over. Anyone can call it.
    function applyAttester() external {
        uint256 eta = attesterEta;
        if (eta == 0) revert NothingScheduled();
        if (block.timestamp < eta) revert TooEarly();
        address next = pendingAttester;
        attester = next;
        pendingAttester = address(0);
        attesterEta = 0;
        emit AttesterSet(next);
    }

    /// @notice Stop callouts from being recorded, or let them be recorded again. Takes effect at once: it is how
    ///         an attester whose key has leaked is stopped while its replacement waits out the delay.
    function setSubmissionsPaused(bool paused) external onlyGuardian {
        submissionsPaused = paused;
        emit SubmissionsPausedSet(paused);
    }

    function setTeamWallet(address teamWallet_) external onlyGuardian {
        if (teamWallet_ == address(0)) revert ZeroAddress();
        teamWallet = teamWallet_;
        emit TeamWalletSet(teamWallet_);
    }

    /// @notice Schedule a change to how future deposits are split. The three shares add up to 100% and the
    ///         platform share can only be 25% or less. It can be applied `CHANGE_DELAY` later. Scheduling again
    ///         replaces the pending split and restarts the wait.
    function scheduleSplit(uint16 holders, uint16 callouts, uint16 platform) external onlyGuardian {
        if (uint256(holders) + callouts + platform != BPS || platform > MAX_PLATFORM_BPS) revert InvalidSplit();
        uint256 eta = block.timestamp + CHANGE_DELAY;
        pendingHoldersBps = holders;
        pendingCalloutBps = callouts;
        pendingPlatformBps = platform;
        splitEta = uint64(eta);
        emit SplitScheduled(holders, callouts, platform, eta);
    }

    /// @notice Drop the scheduled split.
    function cancelSplit() external onlyGuardian {
        if (splitEta == 0) revert NothingScheduled();
        splitEta = 0;
        emit SplitScheduled(0, 0, 0, 0);
    }

    /// @notice Put the scheduled split in place once its wait is over. Anyone can call it.
    function applySplit() external {
        uint256 eta = splitEta;
        if (eta == 0) revert NothingScheduled();
        if (block.timestamp < eta) revert TooEarly();
        splitEta = 0;
        holdersBps = pendingHoldersBps;
        calloutBps = pendingCalloutBps;
        platformBps = pendingPlatformBps;
        emit SplitSet(holdersBps, calloutBps, platformBps);
    }

    function setRules(uint8 requiredLinks_, uint8 maxLinksPerEpoch_, uint32 minHoldPpm_) external onlyGuardian {
        if (requiredLinks_ == 0 || maxLinksPerEpoch_ < requiredLinks_ || minHoldPpm_ > PPM) revert InvalidRules();
        requiredLinks = requiredLinks_;
        maxLinksPerEpoch = maxLinksPerEpoch_;
        minHoldPpm = minHoldPpm_;
        emit RulesSet(requiredLinks_, maxLinksPerEpoch_, minHoldPpm_);
    }

    /// @notice Hand the guardian role over in two steps, so it cannot go to an address nobody controls.
    function transferGuardian(address next) external onlyGuardian {
        pendingGuardian = next;
        emit GuardianTransferStarted(next);
    }

    function acceptGuardian() external {
        if (msg.sender != pendingGuardian) revert NotGuardian();
        guardian = msg.sender;
        pendingGuardian = address(0);
        emit GuardianChanged(msg.sender);
    }

    /// @dev Every payout of a token's rewards goes through here: it is booked against the token's own ledger and
    ///      refused if it would take out more than the token's fees brought in.
    function _book(address token, uint256 amount) private {
        Ledger storage l = _ledgers[token];
        uint256 paid = uint256(l.paid) + amount;
        if (paid > l.received) revert Insolvent();
        l.paid = uint128(paid);
    }

    function _sendBnb(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert BnbTransferFailed();
    }
}
