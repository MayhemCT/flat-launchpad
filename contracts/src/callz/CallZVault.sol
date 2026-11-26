// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ECDSA} from "solady/utils/ECDSA.sol";
import {EIP712} from "solady/utils/EIP712.sol";
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
/// @param nonce        The review record's id. Signed so two approvals never share a digest.
/// @param deadline     Last second the approval can be recorded.
struct Submission {
    address holder;
    address token;
    uint256 epoch;
    uint8 kind;
    bytes32 linkHash;
    bytes32 profileHash;
    uint256 nonce;
    uint256 deadline;
}

/// @title CallZVault
/// @notice Holds every fee CallZ collects, in BNB, and pays it out. One contract keeps a separate book per token.
///
///         Fees arrive through `deposit(token)`: the launch fee from a CallZ mint and the trading fee from the
///         CallZ router. Each deposit is split four ways on arrival:
///
///           35%  holders, by weight        streamed to the token's stakers in this vault
///           10%  callout-unlocked holders  shared, by token weight, between holders whose callouts were verified
///                                          in the round the fee arrived
///           30%  callout reward pool       split equally per verified link of that round
///           25%  platform                  sent to the team wallet as it arrives
///
///         A round's 10% and 30% can be claimed during the 24 hours after the round ends. Whatever is not claimed
///         by then goes to the team wallet.
///
///         Nobody signs for the team's money: the platform share is forwarded on every deposit, and every
///         deposit also sweeps one finished round, if there is one, so rounds are settled by the fees that keep
///         arriving. A holder collects everything owed for a token with one `claim`.
///
///         A round is one UTC day. A callout counts when the attester signed it for the running round and it is
///         recorded here before the round ends. Every recorded link is emitted in full, so the list of rewarded
///         links is public.
///
///         Solvency: every token has a ledger of what its fees brought in for holders and callers and what has
///         been paid out of that. A payout that would take a token's ledger past what the token produced
///         reverts, so one token's rewards can never be paid with another token's fees, whatever else happens.
///
///         "Holders by weight" are stakers because this vault does not control the tokens it serves: it cannot
///         see transfers, and a balance read at one moment can be moved to another wallet and read again.
///         Staked tokens cannot. A stake is returned in full on `unstake`, at any time.
///
/// @dev Trust: the attester can approve any link, which mints callout claims and unlocks the 10% share, within the
///      per-round cap on links per holder. The guardian can replace the attester and the team wallet, lower or
///      move the split (the platform share can never exceed 25%) and change the round rules. Neither can touch
///      staked tokens or amounts already owed.
contract CallZVault is EIP712, ReentrancyGuard {
    using SafeTransferLib for address;

    /// @notice Length of a round. Round `n` runs from `n * EPOCH` to `(n + 1) * EPOCH`, unix time.
    uint256 public constant EPOCH = 1 days;
    /// @notice How long callout rewards stay claimable after their round is closed.
    uint256 public constant CLAIM_WINDOW = 24 hours;
    /// @notice Gas given to the team wallet when money is forwarded to it inside a deposit. A wallet that needs
    ///         more is not paid then: the amount waits in `platformAccrued` for `collect`.
    uint256 public constant TEAM_SEND_GAS = 30_000;
    /// @notice The holder share of a deposit reaches stakers evenly over this long.
    uint256 public constant STREAM = 3 days;
    /// @notice Waiting fees join the stream at most this often, so small deposits cannot keep stretching it.
    uint256 public constant ROLL_INTERVAL = 1 hours;
    /// @notice The platform share can be lowered, never raised past this.
    uint16 public constant MAX_PLATFORM_BPS = 2500;
    uint256 public constant MAX_LINK_BYTES = 256;
    uint8 public constant MAX_KIND = 3;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant PPM = 1_000_000;
    /// @dev Fixed-point scale of `rewardPerToken`.
    uint256 internal constant SCALE = 1e30;

    bytes32 public constant SUBMISSION_TYPEHASH = keccak256(
        "Submission(address holder,address token,uint256 epoch,uint8 kind,bytes32 linkHash,bytes32 profileHash,uint256 nonce,uint256 deadline)"
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Roles and rules
    // ─────────────────────────────────────────────────────────────────────────

    address public guardian;
    address public pendingGuardian;
    /// @notice Signs verified callouts.
    address public attester;
    /// @notice Receives the platform share and swept callout rewards.
    address public teamWallet;

    uint16 public holdersBps = 3500;
    uint16 public unlockedBps = 1000;
    uint16 public calloutBps = 3000;
    uint16 public platformBps = 2500;

    /// @notice Verified links a holder needs in a round to unlock that round's 10% share.
    uint8 public requiredLinks = 1;
    /// @notice The most links one holder can record for one token in one round.
    uint8 public maxLinksPerEpoch = 3;
    /// @notice The least a holder must hold (wallet plus stake) to record a callout, in parts per million of the
    ///         token's supply. 100 is 0.01%.
    uint32 public minHoldPpm = 100;

    // ─────────────────────────────────────────────────────────────────────────
    // Books
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice BNB owed to the team wallet that could not be sent to it when it fell due. `collect` sends it.
    uint256 public platformAccrued;

    /// @dev What a token's fees brought in for holders and callers (everything but the platform share), and what
    ///      has been paid out of it.
    struct Ledger {
        uint128 received;
        uint128 paid;
    }

    struct Round {
        /// @dev The 10% share: paid to unlocked holders by weight.
        uint128 pot;
        /// @dev The 30% callout reward pool.
        uint128 pool;
        uint104 claimedPot;
        uint104 claimedPool;
        /// @dev Verified links recorded in the round.
        uint32 links;
        /// @dev In the sweep queue.
        bool listed;
        bool swept;
        /// @dev Sum of the weights of the holders who unlocked.
        uint256 totalWeight;
    }

    /// @dev A round waiting to be swept once its claim window has passed.
    struct RoundRef {
        address token;
        uint64 epoch;
    }

    struct Entry {
        uint8 links;
        bool unlocked;
        bool claimedUnlocked;
        bool claimedCallout;
        /// @dev Tokens held (wallet plus stake) at the moment of unlocking.
        uint256 weight;
    }

    struct Stream {
        uint256 totalStaked;
        uint256 rewardPerToken;
        /// @dev BNB waiting to join the stream.
        uint256 queued;
        /// @dev Wei per second.
        uint256 rate;
        uint64 periodFinish;
        uint64 lastUpdate;
        uint64 lastRoll;
    }

    mapping(address token => mapping(uint256 epoch => Round)) internal _rounds;
    mapping(address token => mapping(uint256 epoch => mapping(address holder => Entry))) internal _entries;
    mapping(address token => Stream) internal _streams;
    mapping(address token => Ledger) internal _ledgers;
    /// @dev Every round that received a fee, in the order they opened. Rounds open in time order, so the ones
    ///      whose claim window has passed are always at the front.
    RoundRef[] internal _queue;
    /// @notice How many rounds of the queue have been swept.
    uint256 public sweepCursor;
    mapping(address token => mapping(address holder => uint256)) public staked;
    mapping(address token => mapping(address holder => uint256)) internal _paid;
    mapping(address token => mapping(address holder => uint256)) internal _owed;
    /// @notice Whether a link has been recorded. One link, one holder, ever.
    mapping(bytes32 linkHash => bool) public usedLink;

    // ─────────────────────────────────────────────────────────────────────────
    // Events and errors
    // ─────────────────────────────────────────────────────────────────────────

    event Deposited(address indexed token, address indexed from, uint256 indexed epoch, uint256 amount);
    event Staked(address indexed token, address indexed holder, uint256 amount);
    event Unstaked(address indexed token, address indexed holder, uint256 amount);
    event Submitted(
        address indexed holder, address indexed token, uint256 indexed epoch, uint8 kind, bytes32 linkHash, string link
    );
    event Unlocked(address indexed holder, address indexed token, uint256 indexed epoch, uint256 weight);
    /// @param bucket 0 holders by weight, 1 callout-unlocked share, 2 callout reward pool.
    event Claimed(address indexed holder, address indexed token, uint256 epoch, uint8 bucket, uint256 amount);
    /// @notice A round's claim window passed: what nobody claimed of its 10% share and its callout pool went to
    ///         the team wallet.
    event UnclaimedSwept(address indexed token, uint256 indexed epoch, uint256 amount, address teamWallet);
    event TeamPaid(uint256 amount, address teamWallet);
    event AttesterSet(address attester);
    event TeamWalletSet(address teamWallet);
    event SplitSet(uint16 holdersBps, uint16 unlockedBps, uint16 calloutBps, uint16 platformBps);
    event RulesSet(uint8 requiredLinks, uint8 maxLinksPerEpoch, uint32 minHoldPpm);
    event GuardianTransferStarted(address indexed pendingGuardian);
    event GuardianChanged(address indexed guardian);

    error ZeroAddress();
    error NotGuardian();
    error InvalidSplit();
    error InvalidRules();
    error ZeroAmount();
    error InsufficientStake();
    error WrongEpoch();
    error Expired();
    error InvalidKind();
    error LinkTooLong();
    error LinkMismatch();
    error LinkUsed();
    error BadSignature();
    error TooManyLinks();
    error BelowMinHold();
    error NothingToClaim();
    error BnbTransferFailed();
    error Insolvent();

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
    /// @dev Splits the value into the four buckets, forwards the platform share to the team wallet, and sweeps
    ///      one finished round if there is one. No loop, and nothing here can revert the trade or launch that
    ///      pays it: if the team wallet does not take the money, it waits in `platformAccrued`.
    function deposit(address token) external payable {
        uint256 value = msg.value;
        if (value == 0) return;

        uint256 toHolders = (value * holdersBps) / BPS;
        uint256 toUnlocked = (value * unlockedBps) / BPS;
        uint256 toCallouts = (value * calloutBps) / BPS;
        uint256 epoch = currentEpoch();

        _ledgers[token].received += uint128(toHolders + toUnlocked + toCallouts);
        Stream storage s = _streams[token];
        s.queued += toHolders;
        if (block.timestamp >= uint256(s.lastRoll) + ROLL_INTERVAL) _roll(s);

        Round storage r = _rounds[token][epoch];
        r.pot += uint128(toUnlocked);
        r.pool += uint128(toCallouts);
        if (!r.listed) {
            r.listed = true;
            _queue.push(RoundRef(token, uint64(epoch)));
        }
        emit Deposited(token, msg.sender, epoch, value);

        // The platform takes its share and whatever the divisions above rounded off, plus one finished round's
        // unclaimed rewards.
        _forwardToTeam(value - toHolders - toUnlocked - toCallouts + _sweepNext());
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
    // Holders by weight: staking
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Brings the token's reward-per-token up to now. Time that passed with nobody staked pays nobody: what
    ///      would have streamed goes back to the queue.
    function _accrue(Stream storage s) private {
        uint256 end = block.timestamp < s.periodFinish ? block.timestamp : s.periodFinish;
        if (end > s.lastUpdate) {
            uint256 streamed = (end - s.lastUpdate) * s.rate;
            if (s.totalStaked == 0) s.queued += streamed;
            else s.rewardPerToken += (streamed * SCALE) / s.totalStaked;
            s.lastUpdate = uint64(end);
        }
    }

    /// @dev Starts a new stream of everything waiting plus whatever the running stream has not paid yet.
    function _roll(Stream storage s) private {
        _accrue(s);
        uint256 amount = s.queued;
        if (amount == 0) return;
        if (block.timestamp < s.periodFinish) amount += (uint256(s.periodFinish) - block.timestamp) * s.rate;
        uint256 rate = amount / STREAM;
        if (rate == 0) return;
        s.rate = rate;
        // What the division rounded off waits for the next roll.
        s.queued = amount - rate * STREAM;
        s.periodFinish = uint64(block.timestamp + STREAM);
        s.lastUpdate = uint64(block.timestamp);
        s.lastRoll = uint64(block.timestamp);
    }

    /// @dev Before a stake changes or pays: bring the book up to now, and let waiting fees join the stream if the
    ///      interval has passed.
    function _poke(Stream storage s) private {
        if (block.timestamp >= uint256(s.lastRoll) + ROLL_INTERVAL) _roll(s);
        else _accrue(s);
    }

    function _settle(Stream storage s, address token, address holder) private {
        uint256 perToken = s.rewardPerToken;
        _owed[token][holder] += (staked[token][holder] * (perToken - _paid[token][holder])) / SCALE;
        _paid[token][holder] = perToken;
    }

    /// @notice Stake `amount` of `token` to earn the holder share of its fees. Approve this vault first.
    /// @dev Counts what actually arrived, so a token that takes a tax on transfer is credited correctly.
    function stake(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Stream storage s = _streams[token];
        _poke(s);
        _settle(s, token, msg.sender);

        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        staked[token][msg.sender] += received;
        s.totalStaked += received;
        emit Staked(token, msg.sender, received);
    }

    /// @notice Take `amount` of a stake back. Rewards earned so far stay owed and are paid by `claim`.
    function unstake(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (staked[token][msg.sender] < amount) revert InsufficientStake();
        Stream storage s = _streams[token];
        _poke(s);
        _settle(s, token, msg.sender);

        staked[token][msg.sender] -= amount;
        s.totalStaked -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Unstaked(token, msg.sender, amount);
    }

    /// @notice BNB `holder`'s stake in `token` has earned and not yet collected.
    function earned(address token, address holder) external view returns (uint256) {
        Stream storage s = _streams[token];
        uint256 perToken = s.rewardPerToken;
        uint256 end = block.timestamp < s.periodFinish ? block.timestamp : s.periodFinish;
        if (end > s.lastUpdate && s.totalStaked != 0) {
            perToken += ((end - s.lastUpdate) * s.rate * SCALE) / s.totalStaked;
        }
        return _owed[token][holder] + (staked[token][holder] * (perToken - _paid[token][holder])) / SCALE;
    }

    /// @notice The holder stream of `token`: tokens staked, BNB per second now streaming, when that stream ends, and
    ///         BNB waiting to join it.
    function streamOf(address token)
        external
        view
        returns (uint256 totalStaked, uint256 rate, uint256 periodFinish, uint256 queued)
    {
        Stream storage s = _streams[token];
        return (s.totalStaked, block.timestamp < s.periodFinish ? s.rate : 0, s.periodFinish, s.queued);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Callouts
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice What `holder` holds of `token`: wallet plus stake.
    function holdingOf(address token, address holder) public view returns (uint256) {
        return token.balanceOf(holder) + staked[token][holder];
    }

    /// @notice Record a callout the attester verified. Anyone can send it; it counts for `s.holder`.
    /// @param link The link's canonical text. Emitted, so every rewarded link is public.
    function submitAttested(Submission calldata s, string calldata link, bytes calldata signature) external {
        uint256 epoch = currentEpoch();
        if (s.epoch != epoch) revert WrongEpoch();
        if (block.timestamp > s.deadline) revert Expired();
        if (s.kind > MAX_KIND) revert InvalidKind();
        if (bytes(link).length == 0 || bytes(link).length > MAX_LINK_BYTES) revert LinkTooLong();
        if (keccak256(bytes(link)) != s.linkHash) revert LinkMismatch();
        if (usedLink[s.linkHash]) revert LinkUsed();

        bytes32 digest = _hashTypedData(
            keccak256(
                abi.encode(
                    SUBMISSION_TYPEHASH,
                    s.holder,
                    s.token,
                    s.epoch,
                    s.kind,
                    s.linkHash,
                    s.profileHash,
                    s.nonce,
                    s.deadline
                )
            )
        );
        if (!_signedByAttester(digest, signature)) revert BadSignature();

        Entry storage e = _entries[s.token][epoch][s.holder];
        if (e.links >= maxLinksPerEpoch) revert TooManyLinks();
        uint256 holding = holdingOf(s.token, s.holder);
        if (holding == 0 || holding * PPM < _totalSupply(s.token) * minHoldPpm) revert BelowMinHold();

        usedLink[s.linkHash] = true;
        Round storage r = _rounds[s.token][epoch];
        e.links += 1;
        r.links += 1;
        emit Submitted(s.holder, s.token, epoch, s.kind, s.linkHash, link);

        if (!e.unlocked && e.links >= requiredLinks) {
            e.unlocked = true;
            e.weight = holding;
            r.totalWeight += holding;
            emit Unlocked(s.holder, s.token, epoch, holding);
        }
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

    /// @notice Collect everything `token` owes the caller, in one transaction: what the caller's stake has
    ///         earned, and for each listed round its callout-unlocked holder share and its callout rewards.
    /// @dev A listed round that is still running, or whose 24-hour claim window has passed, is skipped.
    ///      The holder share is paid on the smaller of the weight at unlocking and what the caller holds now, so
    ///      buying, unlocking and selling earns nothing; what that cuts off stays in the round and is swept.
    function claim(address token, uint256[] calldata epochs) external nonReentrant returns (uint256 total) {
        Stream storage s = _streams[token];
        _poke(s);
        _settle(s, token, msg.sender);
        total = _owed[token][msg.sender];
        if (total != 0) {
            _owed[token][msg.sender] = 0;
            emit Claimed(msg.sender, token, currentEpoch(), 0, total);
        }

        uint256 holding = holdingOf(token, msg.sender);
        for (uint256 i; i < epochs.length; ++i) {
            total += _claimRound(token, epochs[i], holding);
        }
        if (total == 0) revert NothingToClaim();
        _pay(token, msg.sender, total);
    }

    function _claimRound(address token, uint256 epoch, uint256 holding) private returns (uint256 total) {
        if (epoch >= currentEpoch() || block.timestamp > claimDeadline(epoch)) return 0;
        Round storage r = _rounds[token][epoch];
        if (r.swept) return 0;
        Entry storage e = _entries[token][epoch][msg.sender];

        if (e.unlocked && !e.claimedUnlocked) {
            e.claimedUnlocked = true;
            uint256 payout = (uint256(r.pot) * (holding < e.weight ? holding : e.weight)) / r.totalWeight;
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

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A token's ledger: BNB its fees brought in for holders and callers, and BNB paid out of that. `paid`
    ///         can never pass `received`.
    function ledgerOf(address token) external view returns (uint256 received, uint256 paid) {
        Ledger storage l = _ledgers[token];
        return (l.received, l.paid);
    }

    /// @notice A round's book. Its rewards can be claimed from the end of the round until `deadline`.
    function roundOf(address token, uint256 epoch)
        external
        view
        returns (
            uint256 pot10,
            uint256 pool30,
            uint256 claimedPot,
            uint256 claimedPool,
            uint256 totalWeight,
            uint256 links,
            uint256 deadline,
            bool swept
        )
    {
        Round storage r = _rounds[token][epoch];
        pot10 = r.pot;
        pool30 = r.pool;
        claimedPot = r.claimedPot;
        claimedPool = r.claimedPool;
        totalWeight = r.totalWeight;
        links = r.links;
        deadline = claimDeadline(epoch);
        swept = r.swept;
    }

    /// @notice What `holder` did in a round, and what `claim` would pay for it right now. Both payouts are zero
    ///         while the round is running and once its claim window has passed.
    function progress(address token, uint256 epoch, address holder)
        external
        view
        returns (
            uint256 links,
            bool unlocked,
            uint256 weight,
            bool claimedUnlocked,
            bool claimedCallout,
            uint256 unlockedPayout,
            uint256 calloutPayout
        )
    {
        Entry storage e = _entries[token][epoch][holder];
        links = e.links;
        unlocked = e.unlocked;
        weight = e.weight;
        claimedUnlocked = e.claimedUnlocked;
        claimedCallout = e.claimedCallout;
        (unlockedPayout, calloutPayout) = _payouts(token, epoch, holder);
    }

    function _payouts(address token, uint256 epoch, address holder)
        private
        view
        returns (uint256 unlockedPayout, uint256 calloutPayout)
    {
        Round storage r = _rounds[token][epoch];
        if (epoch >= currentEpoch() || block.timestamp > claimDeadline(epoch) || r.swept) return (0, 0);
        Entry storage e = _entries[token][epoch][holder];
        if (e.unlocked && !e.claimedUnlocked) {
            uint256 holding = holdingOf(token, holder);
            unlockedPayout = (uint256(r.pot) * (holding < e.weight ? holding : e.weight)) / r.totalWeight;
        }
        if (e.links != 0 && !e.claimedCallout) calloutPayout = (uint256(r.pool) / r.links) * e.links;
    }

    /// @notice How many rounds have ever received a fee. `sweepCursor` of them have been swept.
    function roundCount() external view returns (uint256) {
        return _queue.length;
    }

    /// @notice The EIP-712 digest the attester signs for `s`.
    function submissionDigest(Submission calldata s) external view returns (bytes32) {
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
                    s.nonce,
                    s.deadline
                )
            )
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Guardian
    // ─────────────────────────────────────────────────────────────────────────

    function setAttester(address attester_) external onlyGuardian {
        if (attester_ == address(0)) revert ZeroAddress();
        attester = attester_;
        emit AttesterSet(attester_);
    }

    function setTeamWallet(address teamWallet_) external onlyGuardian {
        if (teamWallet_ == address(0)) revert ZeroAddress();
        teamWallet = teamWallet_;
        emit TeamWalletSet(teamWallet_);
    }

    /// @notice Change how future deposits are split. The four shares add up to 100% and the platform share can
    ///         only be 25% or less.
    function setSplit(uint16 holders, uint16 unlocked, uint16 callouts, uint16 platform) external onlyGuardian {
        if (uint256(holders) + unlocked + callouts + platform != BPS || platform > MAX_PLATFORM_BPS) {
            revert InvalidSplit();
        }
        holdersBps = holders;
        unlockedBps = unlocked;
        calloutBps = callouts;
        platformBps = platform;
        emit SplitSet(holders, unlocked, callouts, platform);
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
    function _pay(address token, address to, uint256 amount) private {
        Ledger storage l = _ledgers[token];
        uint256 paid = uint256(l.paid) + amount;
        if (paid > l.received) revert Insolvent();
        l.paid = uint128(paid);
        _sendBnb(to, amount);
    }

    function _sendBnb(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert BnbTransferFailed();
    }
}
