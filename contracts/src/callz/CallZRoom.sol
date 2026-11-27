// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin-contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC721} from "solady/tokens/ERC721.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {CallZToken, CALLZ_TOTAL_SUPPLY} from "./CallZToken.sol";
import {CallZRoomArt} from "./CallZRoomArt.sol";

/// @notice The part of the PancakeSwap V2 factory that CallZRoom uses.
interface IRoomPancakeFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

/// @notice The part of a PancakeSwap V2 pair that CallZRoom uses.
interface IRoomPancakePair {
    function mint(address to) external returns (uint256 liquidity);
}

/// @notice The part of WBNB that CallZRoom uses, besides the ERC-20 transfer.
interface IRoomWBNB {
    function deposit() external payable;
}

/// @notice The part of CallZVault that CallZRoom uses.
interface IRoomFeeVault {
    function deposit(address token) external payable;
}

/// @notice The one question CallZRoom asks a token a room requires its members to hold.
interface IRoomGateToken {
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Payload for `CallZRoomFactory.create`.
/// @param name          Token name. The room and its pass collection are named after it.
/// @param symbol        Token symbol.
/// @param image         Address of the room's picture (https or ipfs). Every pass shows it. May be empty.
/// @param seatPrice     BNB per pass. Every pass costs the same.
/// @param seats         Passes in the room. `seatPrice * seats` is what the room raises: at most 10 BNB.
/// @param saleDuration  Seconds from creation until passes can be handed back for their price.
/// @param poolShareBps  Share of the supply that goes into the pool, in bps (1000 to 9000). The rest is split
///                      equally between the passes.
/// @param gateToken     A token a wallet must hold to be let in. The zero address for no such requirement.
/// @param gateAmount    How much of `gateToken` it must hold, in the token's base units.
struct CallZRoomConfig {
    string name;
    string symbol;
    string image;
    uint256 seatPrice;
    uint256 seats;
    uint256 saleDuration;
    uint16 poolShareBps;
    address gateToken;
    uint256 gateAmount;
}

/// @notice Everything a room page needs, in one call.
struct CallZRoomInfo {
    address creator;
    string tokenName;
    string tokenSymbol;
    string image;
    uint256 seatPrice;
    uint256 seats;
    uint256 seated;
    uint256 minted;
    uint256 raised;
    uint256 saleDeadline;
    uint16 poolShareBps;
    uint16 launchFeeBps;
    address gateToken;
    uint256 gateAmount;
    uint256 tokensPerSeat;
    bool launched;
    address token;
    address pair;
}

/// @notice Where one wallet stands in a room.
struct CallZRoomStanding {
    bool admitted;
    bool banned;
    uint256 seat;
    bool claimed;
    uint256 owed;
    bool meetsGate;
}

/// @title CallZRoom
/// @notice A room whose members are chosen by its creator, and whose passes launch a token into PancakeSwap V2.
///
///         The creator (the room's dev) lets wallets in one by one. A wallet that has been let in buys one pass
///         at the room's flat price, and the pass is its seat: it cannot be transferred. When every seat is
///         taken the creator launches: the token is deployed, the launch fee goes to the CallZ vault, the rest of
///         the raise and the pool share of the supply go into the token's PancakeSwap V2 pair with WBNB, and the
///         LP tokens are minted to the dead address. Every pass then claims an equal share of the rest of the
///         supply, once.
///
///         What the creator can and cannot do:
///           - `admit` lets wallets in. If the room names a token to hold, a wallet that does not hold enough of
///             it at that moment is refused by this contract, whatever the creator wants.
///           - `kick` removes a member before the launch: the pass is burned, the wallet is barred, its price is
///             sent back in full, and the seat is free for another wallet. A burned pass's number is never used
///             again.
///           - `launch` is the creator's alone and only works with every seat taken.
///           - The creator cannot withdraw the raise. BNB leaves this contract only through the launch, through
///             a kick's repayment to the kicked wallet, or through members handing their passes back.
///           - After the launch the creator can do nothing here: nobody can be removed and every pass claims.
///
///         If the room has not launched by its deadline, any member can hand their pass back for its price. A
///         room that is still full can launch after the deadline; one that has lost a member cannot fill up
///         again, and everybody takes their BNB back.
///
/// @dev Deployed by `CallZRoomFactory` as an immutable minimal clone. No upgrade path and no admin besides the
///      creator's three actions above.
contract CallZRoom is Initializable, ERC721 {
    using SafeTransferLib for address;

    /// @notice Supply of the launched token: 1,000,000,000 tokens.
    uint256 public constant TOTAL_SUPPLY = CALLZ_TOTAL_SUPPLY;
    /// @notice The most BNB a room can raise.
    uint256 public constant MAX_CAP = 10 ether;
    /// @notice The most seats a room can have.
    uint256 public constant MAX_SEATS = 1000;
    /// @notice Wallets one `admit` call can let in.
    uint256 public constant MAX_ADMIT_PER_TX = 100;
    uint16 public constant MIN_POOL_SHARE_BPS = 1000;
    uint16 public constant MAX_POOL_SHARE_BPS = 9000;
    /// @notice The highest launch fee a room can carry: 10% of the raise.
    uint16 public constant MAX_LAUNCH_FEE_BPS = 1000;
    uint256 public constant MIN_SALE_DURATION = 10 minutes;
    uint256 public constant MAX_SALE_DURATION = 30 days;
    /// @notice Longest token name, symbol and picture address, in bytes.
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 32;
    uint256 public constant MAX_IMAGE_BYTES = 200;
    /// @notice Where the LP tokens go. Nobody holds the key to this address.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @dev Gas a kicked wallet gets to receive its price. One that needs more collects with `withdraw`.
    uint256 internal constant REPAY_GAS = 100_000;

    /// @notice The PancakeSwap V2 factory the pair belongs to.
    address public pancakeFactory;
    /// @notice Wrapped BNB: the pool's quote token.
    address public wbnb;
    /// @notice The room's dev: the wallet that created it.
    address public creator;
    /// @notice The CallZ vault the launch fee is paid to.
    address public vault;
    /// @notice Share of the raise paid to the vault at launch, in bps. Fixed at creation.
    uint16 public launchFeeBps;
    /// @notice The contract that writes a pass's metadata: its picture and what it cost.
    address public art;

    /// @notice BNB per pass.
    uint256 public seatPrice;
    /// @notice Seats in the room.
    uint256 public seats;
    /// @notice From this moment a room that has not launched lets its members hand their passes back.
    uint256 public saleDeadline;
    /// @notice Share of the supply that goes into the pool, in bps.
    uint16 public poolShareBps;
    /// @notice A token a wallet must hold to be let in, or the zero address.
    address public gateToken;
    /// @notice How much of `gateToken` a wallet must hold to be let in.
    uint256 public gateAmount;

    string public tokenName;
    string public tokenSymbol;
    /// @notice Address of the room's picture, as given at creation.
    string public image;

    /// @notice Passes issued so far, burned ones included. Pass numbers run from 1 to `minted`.
    uint256 public minted;
    /// @notice Seats taken now.
    uint256 public seated;
    /// @notice BNB held for the launch: `seatPrice` for every seat taken.
    uint256 public raised;

    bool public launched;
    /// @dev True only while the launch is running: closes every other action.
    bool internal launching;

    address public token;
    /// @notice The token's PancakeSwap V2 pair with WBNB.
    address public pair;
    /// @notice Tokens each pass claims after the launch. Set at creation and never changed.
    uint256 public tokensPerSeat;

    /// @notice Wallets the creator has let in and that have not bought their pass yet.
    mapping(address wallet => bool) public admitted;
    /// @notice Wallets barred from the room.
    mapping(address wallet => bool) public banned;
    /// @notice The pass a wallet holds, or 0.
    mapping(address wallet => uint256) public seatOf;
    /// @notice Whether a pass has claimed.
    mapping(uint256 tokenId => bool) public claimed;
    /// @notice BNB a kicked wallet could not be sent and can collect with `withdraw`.
    mapping(address wallet => uint256) public owed;

    /// @dev The members, and each one's position in the list plus one.
    address[] internal _members;
    mapping(address wallet => uint256) internal _memberSlot;

    event Admitted(address indexed wallet);
    event AdmissionRevoked(address indexed wallet);
    event Minted(address indexed to, uint256 indexed tokenId, uint256 paid);
    event Kicked(address indexed wallet, uint256 indexed tokenId, uint256 repaid);
    event BanSet(address indexed wallet, bool banned);
    event Withdrawn(address indexed wallet, uint256 amount);
    /// @param raised BNB that went into the pool: the raise less the launch fee.
    event Launched(address indexed token, address indexed pair, uint256 raised, uint256 poolTokens, uint256 tokensPerSeat);
    event LaunchFeePaid(address indexed token, address indexed vault, uint256 amount);
    event Claimed(uint256 indexed tokenId, address indexed to, uint256 amount);
    event Refunded(uint256 indexed tokenId, address indexed to, uint256 amount);

    error InvalidConfig();
    error NotCreator();
    error SaleClosed();
    error TooManyWallets();
    error Banned(address wallet);
    /// @notice The wallet does not hold enough of the token the room requires.
    error GateNotMet(address wallet, uint256 held, uint256 required);
    error NotAdmitted();
    error AlreadyMember();
    error NotMember(address wallet);
    error RoomFull();
    error RoomNotFull(uint256 seated, uint256 seats);
    error WrongPayment(uint256 sent, uint256 required);
    error LaunchInProgress();
    error NoLiquidityMinted();
    error NotLaunched();
    error AlreadyLaunched();
    error AlreadyClaimed(uint256 tokenId);
    error RefundUnavailable();
    error NothingOwed();
    error EthTransferFailed();
    /// @notice A pass is its holder's seat and cannot change hands.
    error Soulbound();

    modifier onlyCreator() {
        if (msg.sender != creator) revert NotCreator();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by the factory in the transaction that deploys the clone.
    function initialize(
        address pancakeFactory_,
        address wbnb_,
        address creator_,
        address vault_,
        uint16 launchFeeBps_,
        address art_,
        CallZRoomConfig calldata c
    ) external initializer {
        if (pancakeFactory_ == address(0) || wbnb_ == address(0) || creator_ == address(0)) revert InvalidConfig();
        if (art_ == address(0)) revert InvalidConfig();
        if (launchFeeBps_ > MAX_LAUNCH_FEE_BPS || (launchFeeBps_ != 0 && vault_ == address(0))) revert InvalidConfig();
        if (bytes(c.name).length == 0 || bytes(c.name).length > MAX_NAME_BYTES) revert InvalidConfig();
        if (bytes(c.symbol).length == 0 || bytes(c.symbol).length > MAX_SYMBOL_BYTES) revert InvalidConfig();
        if (bytes(c.image).length > MAX_IMAGE_BYTES) revert InvalidConfig();
        if (c.seatPrice == 0 || c.seats == 0 || c.seats > MAX_SEATS) revert InvalidConfig();
        // `seats` is at most 1000 and the product is checked against 10 BNB, so it cannot overflow unnoticed.
        if (c.seatPrice > MAX_CAP || c.seatPrice * c.seats > MAX_CAP) revert InvalidConfig();
        if (c.poolShareBps < MIN_POOL_SHARE_BPS || c.poolShareBps > MAX_POOL_SHARE_BPS) revert InvalidConfig();
        if (c.saleDuration < MIN_SALE_DURATION || c.saleDuration > MAX_SALE_DURATION) revert InvalidConfig();
        // A holding requirement names a real token and an amount, or is absent altogether.
        if (c.gateToken == address(0) ? c.gateAmount != 0 : (c.gateAmount == 0 || c.gateToken.code.length == 0)) {
            revert InvalidConfig();
        }

        pancakeFactory = pancakeFactory_;
        wbnb = wbnb_;
        creator = creator_;
        vault = vault_;
        launchFeeBps = launchFeeBps_;
        art = art_;
        seatPrice = c.seatPrice;
        seats = c.seats;
        saleDeadline = block.timestamp + c.saleDuration;
        poolShareBps = c.poolShareBps;
        gateToken = c.gateToken;
        gateAmount = c.gateAmount;
        // The passes share what the pool does not take. The launch uses this same value.
        tokensPerSeat = (TOTAL_SUPPLY - (TOTAL_SUPPLY * c.poolShareBps) / 10_000) / c.seats;
        tokenName = c.name;
        tokenSymbol = c.symbol;
        image = c.image;
    }

    /// @notice What the room raises when every seat is taken.
    function cap() public view returns (uint256) {
        return seatPrice * seats;
    }

    /// @notice The raise target: the same value as `cap`.
    function targetRaise() external view returns (uint256) {
        return cap();
    }

    /// @notice Tokens that go into the pool: the pool share of the supply plus whatever the equal split between
    ///         the passes leaves over, so every token has an owner.
    function poolTokens() public view returns (uint256) {
        return TOTAL_SUPPLY - tokensPerSeat * seats;
    }

    /// @notice Implementation version.
    function version() external pure returns (string memory) {
        return "1.0.0";
    }

    /// @notice The room's whole state, for a room page.
    function info() external view returns (CallZRoomInfo memory i) {
        i.creator = creator;
        i.tokenName = tokenName;
        i.tokenSymbol = tokenSymbol;
        i.image = image;
        i.seatPrice = seatPrice;
        i.seats = seats;
        i.seated = seated;
        i.minted = minted;
        i.raised = raised;
        i.saleDeadline = saleDeadline;
        i.poolShareBps = poolShareBps;
        i.launchFeeBps = launchFeeBps;
        i.gateToken = gateToken;
        i.gateAmount = gateAmount;
        i.tokensPerSeat = tokensPerSeat;
        i.launched = launched;
        i.token = token;
        i.pair = pair;
    }

    /// @notice Where `wallet` stands: let in or not, barred or not, its pass, and whether it holds what the
    ///         room requires right now.
    function standingOf(address wallet) external view returns (CallZRoomStanding memory s) {
        s.admitted = admitted[wallet];
        s.banned = banned[wallet];
        s.seat = seatOf[wallet];
        s.claimed = s.seat != 0 && claimed[s.seat];
        s.owed = owed[wallet];
        (s.meetsGate,) = _gate(wallet);
    }

    /// @notice How many members the room has now.
    function memberCount() external view returns (uint256) {
        return _members.length;
    }

    /// @notice Up to `limit` members starting at position `offset`, with the pass each one holds.
    function members(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory wallets, uint256[] memory tokenIds)
    {
        uint256 total = _members.length;
        if (offset > total) offset = total;
        uint256 count = total - offset;
        if (count > limit) count = limit;
        wallets = new address[](count);
        tokenIds = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            address wallet = _members[offset + i];
            wallets[i] = wallet;
            tokenIds[i] = seatOf[wallet];
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The creator: who gets in, who is removed
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Whether `wallet` holds what the room requires, and how much it holds. A room without a requirement
    ///      is met by everyone.
    function _gate(address wallet) private view returns (bool met, uint256 held) {
        address gate = gateToken;
        if (gate == address(0)) return (true, 0);
        held = IRoomGateToken(gate).balanceOf(wallet);
        met = held >= gateAmount;
    }

    /// @dev True while passes can still be bought: before the launch and before the deadline.
    function _open() private view returns (bool) {
        return !launched && !launching && block.timestamp < saleDeadline;
    }

    /// @notice Let wallets in: each may then buy one pass. A wallet that is barred, or that does not hold the
    ///         room's required token at this moment, makes the whole call fail. A wallet that is already in is
    ///         passed over.
    function admit(address[] calldata wallets) external onlyCreator {
        if (!_open()) revert SaleClosed();
        uint256 count = wallets.length;
        if (count > MAX_ADMIT_PER_TX) revert TooManyWallets();
        for (uint256 i; i < count; ++i) {
            address wallet = wallets[i];
            if (wallet == address(0)) revert InvalidConfig();
            if (banned[wallet]) revert Banned(wallet);
            if (admitted[wallet] || seatOf[wallet] != 0) continue;
            (bool met, uint256 held) = _gate(wallet);
            if (!met) revert GateNotMet(wallet, held, gateAmount);
            admitted[wallet] = true;
            emit Admitted(wallet);
        }
    }

    /// @notice Take back the admission of wallets that have not bought their pass.
    function revoke(address[] calldata wallets) external onlyCreator {
        uint256 count = wallets.length;
        for (uint256 i; i < count; ++i) {
            address wallet = wallets[i];
            if (!admitted[wallet]) continue;
            admitted[wallet] = false;
            emit AdmissionRevoked(wallet);
        }
    }

    /// @notice Bar a wallet that is not a member, or lift that bar. A member is removed with `kick`.
    function setBanned(address wallet, bool banned_) external onlyCreator {
        if (launched || launching) revert AlreadyLaunched();
        if (banned_) {
            if (seatOf[wallet] != 0) revert AlreadyMember();
            if (admitted[wallet]) {
                admitted[wallet] = false;
                emit AdmissionRevoked(wallet);
            }
        }
        banned[wallet] = banned_;
        emit BanSet(wallet, banned_);
    }

    /// @notice Remove a member before the launch. Their pass is burned and its number is never used again, the
    ///         wallet is barred, and the price it paid is sent back to it in full. The seat is free again.
    function kick(address wallet) external onlyCreator {
        if (launching) revert LaunchInProgress();
        if (launched) revert AlreadyLaunched();
        uint256 id = seatOf[wallet];
        if (id == 0) revert NotMember(wallet);

        uint256 price = seatPrice;
        _vacate(wallet, id);
        banned[wallet] = true;
        raised -= price;
        emit BanSet(wallet, true);

        // The price goes straight back. A wallet that cannot take it this way collects it with `withdraw`, so
        // no wallet can make itself impossible to remove.
        (bool ok,) = wallet.call{value: price, gas: REPAY_GAS}("");
        if (!ok) owed[wallet] += price;
        emit Kicked(wallet, id, price);
    }

    /// @notice Collect BNB a kick could not deliver.
    function withdraw() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        _sendBnb(msg.sender, amount);
    }

    /// @dev Burn `wallet`'s pass and take it off the member list.
    function _vacate(address wallet, uint256 id) private {
        uint256 slot = _memberSlot[wallet];
        uint256 lastSlot = _members.length;
        if (slot != lastSlot) {
            address moved = _members[lastSlot - 1];
            _members[slot - 1] = moved;
            _memberSlot[moved] = slot;
        }
        _members.pop();
        delete _memberSlot[wallet];
        delete seatOf[wallet];
        --seated;
        _burn(id);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Members: buy a pass, hand it back
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Buy the caller's pass: send exactly `seatPrice`. Only a wallet the creator has let in can, and
    ///         only once.
    function mint() external payable {
        if (launching) revert LaunchInProgress();
        if (launched) revert AlreadyLaunched();
        if (block.timestamp >= saleDeadline) revert SaleClosed();
        if (banned[msg.sender]) revert Banned(msg.sender);
        if (seatOf[msg.sender] != 0) revert AlreadyMember();
        if (!admitted[msg.sender]) revert NotAdmitted();
        if (seated == seats) revert RoomFull();
        uint256 price = seatPrice;
        if (msg.value != price) revert WrongPayment(msg.value, price);

        uint256 id = ++minted;
        admitted[msg.sender] = false;
        seatOf[msg.sender] = id;
        _members.push(msg.sender);
        _memberSlot[msg.sender] = _members.length;
        ++seated;
        raised += price;
        // `_mint`, not `_safeMint`: no callback into the buyer while the room's state is changing.
        _mint(msg.sender, id);
        emit Minted(msg.sender, id, price);
    }

    /// @notice Whether members can hand their passes back: the deadline has passed without a launch.
    function refundAvailable() public view returns (bool) {
        return !launched && !launching && block.timestamp >= saleDeadline;
    }

    /// @notice BNB `account` would get back from `refund()` right now.
    function refundableOf(address account) external view returns (uint256) {
        return refundAvailable() && seatOf[account] != 0 ? seatPrice : 0;
    }

    /// @notice Hand the caller's pass back for its price.
    function refund() external {
        if (!refundAvailable()) revert RefundUnavailable();
        uint256 id = seatOf[msg.sender];
        if (id == 0) revert NotMember(msg.sender);

        uint256 price = seatPrice;
        _vacate(msg.sender, id);
        raised -= price;
        emit Refunded(id, msg.sender, price);
        _sendBnb(msg.sender, price);
    }

    function _sendBnb(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Launch
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Launch the token. The creator's call, and only with every seat taken.
    /// @dev Deploys the token, pays the launch fee to the vault, seeds the token's PancakeSwap V2 pair with the
    ///      rest of the raise and the pool share of the supply, and burns the LP.
    ///
    ///      The liquidity is added by sending both assets to the pair and calling `mint` on it, not through the
    ///      router: a pair somebody created beforehand, with or without WBNB in it, is still seeded correctly.
    ///      BNB owed to kicked wallets is not part of `raised` and stays here.
    ///
    ///      `launching` closes every other action while this runs, and `claim` stays closed until `launched` is
    ///      set at the end. If any step fails, the whole call reverts and the room is as it was.
    function launch() external onlyCreator {
        if (launching) revert LaunchInProgress();
        if (launched) revert AlreadyLaunched();
        if (seated != seats) revert RoomNotFull(seated, seats);

        uint256 amount = raised;
        uint256 share = tokensPerSeat;
        // Everything the passes do not claim goes into the pool, so no token is left without an owner.
        uint256 poolAmount = TOTAL_SUPPLY - share * seats;
        address factory_ = pancakeFactory;
        address wbnb_ = wbnb;

        launching = true;
        // The whole supply is minted to this contract.
        address token_ = address(new CallZToken(tokenName, tokenSymbol));
        address pair_ = IRoomPancakeFactory(factory_).getPair(token_, wbnb_);
        if (pair_ == address(0)) pair_ = IRoomPancakeFactory(factory_).createPair(token_, wbnb_);

        uint256 fee = (amount * launchFeeBps) / 10_000;
        if (fee != 0) {
            amount -= fee;
            address vault_ = vault;
            IRoomFeeVault(vault_).deposit{value: fee}(token_);
            emit LaunchFeePaid(token_, vault_, fee);
        }

        IRoomWBNB(wbnb_).deposit{value: amount}();
        wbnb_.safeTransfer(pair_, amount);
        token_.safeTransfer(pair_, poolAmount);
        // LP to the dead address: the liquidity can never be removed.
        uint256 liquidity = IRoomPancakePair(pair_).mint(DEAD);
        if (liquidity == 0) revert NoLiquidityMinted();
        launching = false;

        launched = true;
        raised = 0;
        token = token_;
        pair = pair_;
        emit Launched(token_, pair_, amount, poolAmount, share);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Claim
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Tokens `account` would receive from `claim()` right now.
    function claimableOf(address account) external view returns (uint256) {
        uint256 id = seatOf[account];
        return launched && id != 0 && !claimed[id] ? tokensPerSeat : 0;
    }

    /// @notice Claim the caller's share of the supply. A pass claims once and stays with its holder.
    function claim() external {
        if (!launched) revert NotLaunched();
        uint256 id = seatOf[msg.sender];
        if (id == 0) revert NotMember(msg.sender);
        if (claimed[id]) revert AlreadyClaimed(id);

        claimed[id] = true;
        uint256 share = tokensPerSeat;
        emit Claimed(id, msg.sender, share);
        token.safeTransfer(msg.sender, share);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The pass
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev A pass is minted to its buyer and burned on a kick or a hand-back. It never moves between wallets.
    function _beforeTokenTransfer(address from, address to, uint256) internal pure override {
        if (from != address(0) && to != address(0)) revert Soulbound();
    }

    /// @notice A pass cannot change hands, so nobody can be approved to move one. Refusing outright also means
    ///         BNB sent along with an approval, which the ERC-721 interface allows, is never kept here.
    function approve(address, uint256) public payable override {
        revert Soulbound();
    }

    /// @notice See `approve`.
    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function name() public view override returns (string memory) {
        return string.concat(tokenName, " CallZ Pass");
    }

    function symbol() public view override returns (string memory) {
        return string.concat(tokenSymbol, "-PASS");
    }

    /// @notice What every pass of this room cost, as text: "0.25 BNB".
    function priceText() external view returns (string memory) {
        return CallZRoomArt(art).priceText(seatPrice);
    }

    /// @notice On-chain metadata, written by `art`. The picture is the room's own when it has one, and a drawn
    ///         pass with the price on it otherwise. The price every pass cost is an attribute either way.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (!_exists(tokenId)) revert TokenDoesNotExist();
        // 0: seated, the room has not launched. 1: launched and not claimed. 2: claimed.
        uint8 status = !launched ? 0 : claimed[tokenId] ? 2 : 1;
        return CallZRoomArt(art).passURI(tokenName, tokenSymbol, image, tokenId, seatPrice, seats, status);
    }
}
