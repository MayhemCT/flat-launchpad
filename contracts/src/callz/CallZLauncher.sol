// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin-contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC721} from "solady/tokens/ERC721.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {IPortalTypes, IPortal} from "src/flap/IPortal.sol";
import {LauncherBase} from "src/flap/LauncherBase.sol";
import {Distribution, DistributionTarget} from "src/flap/Distribution.sol";
import {IStrategy} from "src/flap/IStrategy.sol";
import {LaunchExtensionHelper} from "src/flap/LaunchExtensionHelper.sol";
import {LauncherDescription} from "src/flap/LauncherHelper.sol";

// Display copy for `description()`. Constants only: no quotes or backslashes, as the description spec requires.
string constant CALLZ_TITLE_ZH = unicode"CallZ NFT 铸造发射";
string constant CALLZ_TITLE_EN = "CallZ NFT mint";
string constant CALLZ_SUMMARY_ZH =
    unicode"以固定价格用 BNB 铸造 CallZ NFT。募集达到上限时，全部 BNB 与入池份额的代币一起注入流动性池，LP 被销毁。其余代币由所有 NFT 平均领取，NFT 仍归持有人所有。若在截止时间前未达到上限，销毁 NFT 即可取回铸造价。";
string constant CALLZ_SUMMARY_EN =
    "Mint a CallZ NFT with BNB at a flat price. When the raise reaches its cap, all of it and the pool share of the supply seed the pool and the LP is burned. Every NFT then claims an equal share of the rest of the supply and stays with its holder. If the cap is not reached by the deadline, burn an NFT to get its price back.";

/// @notice Payload the creator passes to `Portal.newLauncher(factory, abi.encode(CallZConfig))`.
/// @param name          Token name. The NFT collection is named after it.
/// @param symbol        Token symbol.
/// @param meta          Token metadata CID, passed to the token unchanged.
/// @param salt          CREATE2 launch salt, mined so the predicted token address ends in `0x7777`.
/// @param nftPrice      BNB per NFT. Every NFT costs the same.
/// @param cap           BNB the mint raises: at most 10 BNB and an exact multiple of `nftPrice`. All of it becomes
///                      the pool's quote side. `cap / nftPrice` NFTs are sold.
/// @param saleDuration  Length of the mint window in seconds, counted from creation.
/// @param poolShareBps  Share of the supply that goes into the pool, in bps (1000 to 9000). The rest is split
///                      equally between the NFTs.
/// @param buyTaxBps     Buy tax in bps, at most 1000.
/// @param sellTaxBps    Sell tax in bps, at most 1000.
struct CallZConfig {
    string name;
    string symbol;
    string meta;
    bytes32 salt;
    uint256 nftPrice;
    uint256 cap;
    uint256 saleDuration;
    uint16 poolShareBps;
    uint16 buyTaxBps;
    uint16 sellTaxBps;
}

/// @notice Everything a launch page needs, in one call.
struct CallZInfo {
    address creator;
    string tokenName;
    string tokenSymbol;
    string tokenMeta;
    uint256 nftPrice;
    uint256 cap;
    uint256 maxNFTs;
    uint256 minted;
    uint256 burned;
    uint256 raised;
    uint256 saleDeadline;
    uint256 poolToken;
    uint256 holderPool;
    uint256 tokensPerNFT;
    uint16 buyTaxBps;
    uint16 sellTaxBps;
    bool launched;
    bool refundsOpen;
    address token;
    address pool;
}

/// @title CallZLauncher
/// @notice A Pool Launch Launcher whose raise is an NFT mint.
///
///         Buyers mint CallZ NFTs with BNB at a flat price. The mint that brings the raise to its cap launches
///         the token in the same transaction: all the BNB raised is the pool's quote side, the pool share of the
///         supply is its token side, the LP is burned, and the rest of the supply comes back here. Every NFT
///         then claims an equal share of that rest, once, and stays with its holder as a membership pass.
///
///         If the cap is not reached by the deadline, an NFT is burned for its price. The refund goes to whoever
///         holds the NFT at that moment, so NFTs can change hands safely before the launch.
///
///         Order of events:
///           1. `initialize` runs once, in the transaction that deploys the proxy, and locks the launch salt from
///              this contract (the Portal requires `locker == launcher` at launch).
///           2. `mint()` sells one NFT per `nftPrice` sent. A buyer who sends more than the NFTs left gets what is
///              left and the rest of the BNB back. The call that reaches the cap runs `_launch()`.
///           3. `_launch()` calls `Portal.launchTaxTokenV2` with `poolQuote = cap`. The supply that is not in the
///              pool is routed here with `Distribution{EXPLICIT, strategy = this}`.
///           4. Inside that call the Portal invokes `initializeDistribution`, and this contract pulls that supply.
///           5. After the launch, `claim()` pays `tokensPerNFT` for each unclaimed NFT the caller holds.
///           6. After a missed deadline, `refund()` burns the caller's NFTs for `nftPrice` each.
///
///         `mint`, `claim` and `refund` take no arguments, so a host that can only call zero-argument methods
///         (the Flap Launcher UI runtime) can offer every action. `claimNFTs` and `refundNFTs` take token ids,
///         for holders with too many NFTs for one call.
///
/// @dev Deployed by `CallZLauncherFactory` as an ERC1967 beacon proxy. Only the Flap Guardian can upgrade the
///      implementation. No account can withdraw the raise: it leaves only through the launch or through refunds.
///      There is no mint fee and no commission.
/// @dev What the Portal's floor lens takes and returns. `createFloorUsdWad` is the least USD value (18 decimals)
///      the quote side of a pool may hold at launch, for the given share of the supply.
struct GraduationFloorParams {
    address quoteToken;
    uint256 quotePriceUsd;
    uint256 poolQuote;
    uint256 poolToken;
    uint256 totalSupply;
    address vaultFactory;
}

struct GraduationFloorResultV2 {
    bool meetsFloor;
    uint256 floorUsdWad;
    uint256 quoteUsdWad;
    uint16 multiplierBps;
    bool meetsCreateFloor;
    uint256 createFloorUsdWad;
}

/// @dev The part of the Pool Launch Portal that says how much liquidity a launch needs.
interface IPortalFloor {
    function graduationFloorV2(GraduationFloorParams calldata params)
        external
        view
        returns (GraduationFloorResultV2 memory);

    /// @notice Whether `quoteToken` can back a launch of `kind`, and its USD price with 18 decimals.
    function launchQuoteConfig(uint8 kind, address quoteToken)
        external
        view
        returns (bool enabled, uint256 quotePriceUsd);
}

contract CallZLauncher is LauncherBase, Initializable, ERC721, IStrategy {
    using SafeTransferLib for address;

    /// @notice Supply the Portal mints: 1,000,000,000 tokens.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    /// @notice The most BNB a mint can raise.
    uint256 public constant MAX_CAP = 10 ether;
    /// @notice The most NFTs a mint can hold. Keeps each NFT's share above the dividend minimum balance.
    uint256 public constant MAX_NFTS = 10_000;
    /// @notice NFTs one `mint` call can buy. Bounds the gas of the mint that also runs the launch.
    uint256 public constant MAX_MINT_PER_TX = 50;
    uint16 public constant MIN_POOL_SHARE_BPS = 1000;
    uint16 public constant MAX_POOL_SHARE_BPS = 9000;
    uint16 public constant MAX_TAX_BPS = 1000;
    uint256 public constant MIN_SALE_DURATION = 10 minutes;
    uint256 public constant MAX_SALE_DURATION = 30 days;
    /// @notice Longest token name, symbol and metadata CID, in bytes. The Portal reads at most 4,096 bytes of a
    ///         Launcher's `description()` and stores an empty one past that, so the user-supplied part is capped.
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 32;
    uint256 public constant MAX_META_BYTES = 128;

    address public hub;
    address public creator;
    bytes32 public launchSalt;

    /// @notice BNB per NFT.
    uint256 public nftPrice;
    /// @notice BNB the mint raises; also the exact `poolQuote`.
    uint256 public cap;
    /// @notice NFTs in the mint: `cap / nftPrice`.
    uint256 public maxNFTs;
    /// @notice End of the mint window.
    uint256 public saleDeadline;

    /// @notice Tokens that go into the pool.
    uint256 public poolToken;
    /// @notice Tokens the NFTs share: `TOTAL_SUPPLY - poolToken`.
    uint256 public holderPool;
    /// @notice Tokens each NFT claims after the launch: `holderPool / maxNFTs`.
    uint256 public tokensPerNFT;
    uint16 public buyTaxBps;
    uint16 public sellTaxBps;

    string public tokenName;
    string public tokenSymbol;
    string public tokenMeta;

    /// @notice NFTs minted so far. Token ids run from 1 to `minted`.
    uint256 public minted;
    /// @notice NFTs burned for a refund.
    uint256 public burned;
    /// @notice BNB held for the launch: `nftPrice` for every NFT that has not been refunded.
    uint256 public raised;

    /// @notice Set once the Portal launch succeeded.
    bool public launched;
    /// @notice Set by the Guardian to end the mint early and open refunds.
    bool public refundsOpen;
    /// @dev True only while the Portal call is running. It authorizes the distribution callback and blocks
    ///      `mint()` from re-entering.
    bool internal launching;
    bool internal distributionInitialized;

    address public token;
    address public pool;
    /// @notice Whether an NFT has claimed its tokens.
    mapping(uint256 tokenId => bool) public claimed;

    /// @dev NFTs held by each account, and each NFT's position in its holder's list.
    mapping(address account => uint256[]) internal _owned;
    mapping(uint256 tokenId => uint256) internal _ownedIndex;

    event Minted(address indexed to, uint256 firstId, uint256 qty, uint256 paid);
    event Launched(address indexed token, address indexed pool, uint256 poolQuote, uint256 poolToken);
    event Claimed(uint256 indexed tokenId, address indexed to, uint256 amount);
    event Refunded(uint256 indexed tokenId, address indexed to, uint256 amount);
    event RefundsOpened(address indexed guardian);

    error InvalidConfig();
    /// @notice The cap is under the Portal's liquidity floor for this pool share, so the mint could never launch.
    error CapBelowLaunchFloor(uint256 cap, uint256 floor);
    error SaleClosed();
    error ZeroQuantity();
    error MintTooLarge();
    error WrongPayment(uint256 sent, uint256 required);
    error LaunchInProgress();
    error UnauthorizedDistribution();
    error NotLaunched();
    error AlreadyLaunched();
    error NotHolder(uint256 tokenId);
    error AlreadyClaimed(uint256 tokenId);
    error RefundUnavailable();
    error NothingToRefund();
    error NothingToClaim();
    error EthTransferFailed();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by the factory in the transaction that deploys the proxy.
    /// @dev `msg.value` is the salt-lock fee the factory forwarded from the Portal call. The Launcher pays it to
    ///      the Portal itself so the Portal records this proxy as the salt's locker.
    function initialize(address hub_, address creator_, CallZConfig calldata c) external payable initializer {
        if (hub_ == address(0) || creator_ == address(0) || c.salt == bytes32(0)) revert InvalidConfig();
        if (bytes(c.name).length == 0 || bytes(c.name).length > MAX_NAME_BYTES) revert InvalidConfig();
        if (bytes(c.symbol).length == 0 || bytes(c.symbol).length > MAX_SYMBOL_BYTES) revert InvalidConfig();
        if (bytes(c.meta).length > MAX_META_BYTES) revert InvalidConfig();
        // The cap is a whole number of NFTs, so the raise can land on it exactly.
        if (c.nftPrice == 0 || c.cap == 0 || c.cap > MAX_CAP || c.cap % c.nftPrice != 0) revert InvalidConfig();
        uint256 count = c.cap / c.nftPrice;
        if (count > MAX_NFTS) revert InvalidConfig();
        if (c.poolShareBps < MIN_POOL_SHARE_BPS || c.poolShareBps > MAX_POOL_SHARE_BPS) revert InvalidConfig();
        if (c.buyTaxBps > MAX_TAX_BPS || c.sellTaxBps > MAX_TAX_BPS) revert InvalidConfig();
        if (c.saleDuration < MIN_SALE_DURATION || c.saleDuration > MAX_SALE_DURATION) revert InvalidConfig();

        hub = hub_;
        creator = creator_;
        launchSalt = c.salt;
        nftPrice = c.nftPrice;
        cap = c.cap;
        maxNFTs = count;
        saleDeadline = block.timestamp + c.saleDuration;
        // Every NFT claims the same whole number of tokens. What that division leaves over goes into the pool
        // with the pool's share, so nothing is stranded here once the last NFT has claimed.
        tokensPerNFT = (TOTAL_SUPPLY - (TOTAL_SUPPLY * c.poolShareBps) / 10_000) / count;
        holderPool = tokensPerNFT * count;
        poolToken = TOTAL_SUPPLY - holderPool;
        // The Portal rejects a launch whose pool holds too little for its share of the supply. A cap under that
        // floor could never launch and would hold its buyers' BNB until the deadline: it is refused here, at
        // the Portal's price and this factory's multiplier as they are now.
        uint256 floor = _launchFloor(hub_, msg.sender, poolToken);
        if (c.cap < floor) revert CapBelowLaunchFloor(c.cap, floor);
        buyTaxBps = c.buyTaxBps;
        sellTaxBps = c.sellTaxBps;
        tokenName = c.name;
        tokenSymbol = c.symbol;
        tokenMeta = c.meta;

        uint256 fee = IPortal(hub_).SALT_LOCK_FEE();
        // Exactly the fee: anything extra would stay here, since neither a refund nor the launch can spend it.
        if (msg.value != fee) revert InvalidConfig();
        IPortal(hub_).lockSalt{value: fee}(c.salt, uint8(IPortalTypes.LaunchKind.DIRECT_V2_POOL_TAX));
    }

    /// @dev The least BNB the Portal accepts in the pool of a launch that puts `poolToken_` of the supply there,
    ///      for a Launcher of `factory_`: the Portal's creation floor in USD, scaled by the factory's floor
    ///      multiplier, at the Portal's own BNB price, rounded up.
    function _launchFloor(address hub_, address factory_, uint256 poolToken_) private view returns (uint256) {
        (bool quoteEnabled, uint256 priceUsd) =
            IPortalFloor(hub_).launchQuoteConfig(uint8(IPortalTypes.LaunchKind.DIRECT_V2_POOL_TAX), address(0));
        // Without a price for BNB the Portal launches nothing against it.
        if (!quoteEnabled || priceUsd == 0) revert InvalidConfig();
        GraduationFloorResultV2 memory result = IPortalFloor(hub_).graduationFloorV2(
            GraduationFloorParams({
                quoteToken: address(0),
                quotePriceUsd: priceUsd,
                poolQuote: 1,
                poolToken: poolToken_,
                totalSupply: TOTAL_SUPPLY,
                vaultFactory: address(0)
            })
        );
        // A factory Flap has not configured launches at the full floor.
        (bool enabled, uint16 multiplierBps) = IPortal(hub_).launcherFactoryMultiplier(factory_);
        uint256 floorUsd = (result.createFloorUsdWad * (enabled ? multiplierBps : 10_000)) / 10_000;
        return (floorUsd * 1 ether + priceUsd - 1) / priceUsd;
    }

    /// @inheritdoc LauncherBase
    function _getHub() internal view override returns (address) {
        return hub;
    }

    /// @inheritdoc LauncherBase
    function _description() internal view override returns (LauncherDescription memory d) {
        d.name = tokenName;
        d.symbol = tokenSymbol;
        d.quoteToken = address(0); // native BNB, matching `_buildParams`' p.quoteToken
        d.targetRaise = cap;
        d.poolTokenRatio = (poolToken * 1e18) / TOTAL_SUPPLY;
        d.titleZh = CALLZ_TITLE_ZH;
        d.titleEn = CALLZ_TITLE_EN;
        d.summaryZh = CALLZ_SUMMARY_ZH;
        d.summaryEn = CALLZ_SUMMARY_EN;
    }

    /// @notice The raise target: the same value as `cap`, under the name launch pages use.
    function targetRaise() external view returns (uint256) {
        return cap;
    }

    /// @notice Implementation version.
    function version() external pure returns (string memory) {
        return "1.0.0";
    }

    /// @notice The Launcher's whole state, for a launch page.
    function info() external view returns (CallZInfo memory i) {
        i.creator = creator;
        i.tokenName = tokenName;
        i.tokenSymbol = tokenSymbol;
        i.tokenMeta = tokenMeta;
        i.nftPrice = nftPrice;
        i.cap = cap;
        i.maxNFTs = maxNFTs;
        i.minted = minted;
        i.burned = burned;
        i.raised = raised;
        i.saleDeadline = saleDeadline;
        i.poolToken = poolToken;
        i.holderPool = holderPool;
        i.tokensPerNFT = tokensPerNFT;
        i.buyTaxBps = buyTaxBps;
        i.sellTaxBps = sellTaxBps;
        i.launched = launched;
        i.refundsOpen = refundsOpen;
        i.token = token;
        i.pool = pool;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Buy NFTs: send `nftPrice` for each one. The call that reaches the cap also launches.
    /// @dev Takes no argument so that any host can offer it as a single payable action: the quantity is the
    ///      value sent divided by `nftPrice`, and the value must be an exact multiple. A buyer who asks for more
    ///      NFTs than are left gets what is left, and the BNB for the others back.
    function mint() external payable {
        if (launching) revert LaunchInProgress();
        if (launched) revert AlreadyLaunched();
        if (refundsOpen || block.timestamp >= saleDeadline) revert SaleClosed();

        uint256 price = nftPrice;
        uint256 quantity = msg.value / price;
        if (quantity == 0) revert ZeroQuantity();
        if (quantity * price != msg.value) revert WrongPayment(msg.value, quantity * price);

        uint256 left = maxNFTs - minted;
        if (quantity > left) quantity = left;
        if (quantity > MAX_MINT_PER_TX) revert MintTooLarge();

        uint256 paid = quantity * price;
        uint256 first = minted + 1;
        uint256 last = minted + quantity;
        minted = last;
        raised += paid;
        // `_mint`, not `_safeMint`: no callback into the buyer while the sale state is changing.
        for (uint256 id = first; id <= last; ++id) {
            _mint(msg.sender, id);
        }
        emit Minted(msg.sender, first, quantity, paid);

        if (last == maxNFTs) _launch();

        // Overflow: return what the buyer sent for NFTs that were no longer available.
        if (msg.value > paid) _sendBnb(msg.sender, msg.value - paid);
    }

    /// @notice Whether NFTs can be burned for a refund: the mint missed its deadline without reaching the cap,
    ///         or the Guardian opened refunds. Never after the launch.
    function refundAvailable() public view returns (bool) {
        if (launched || launching) return false;
        return refundsOpen || (block.timestamp >= saleDeadline && minted < maxNFTs);
    }

    /// @notice BNB `account` would get back from `refund()` right now.
    function refundableOf(address account) external view returns (uint256) {
        return refundAvailable() ? _owned[account].length * nftPrice : 0;
    }

    /// @notice Burn every NFT the caller holds for its price.
    function refund() external {
        if (!refundAvailable()) revert RefundUnavailable();

        uint256[] storage list = _owned[msg.sender];
        uint256 count = list.length;
        if (count == 0) revert NothingToRefund();
        uint256 price = nftPrice;
        for (uint256 i = count; i > 0; --i) {
            // Burning removes the NFT from the end of the list, so walk it backwards.
            uint256 id = list[i - 1];
            _burn(id);
            emit Refunded(id, msg.sender, price);
        }
        _payRefund(count, price);
    }

    /// @notice Burn the listed NFTs for their price. For a holder with too many NFTs for one `refund()` call.
    ///         The caller must hold every one.
    function refundNFTs(uint256[] calldata tokenIds) external {
        if (!refundAvailable()) revert RefundUnavailable();

        uint256 count = tokenIds.length;
        if (count == 0) revert NothingToRefund();
        uint256 price = nftPrice;
        for (uint256 i; i < count; ++i) {
            uint256 id = tokenIds[i];
            if (_ownerOf(id) != msg.sender) revert NotHolder(id);
            _burn(id);
            emit Refunded(id, msg.sender, price);
        }
        _payRefund(count, price);
    }

    function _payRefund(uint256 count, uint256 price) private {
        uint256 amount = price * count;
        burned += count;
        raised -= amount;
        _sendBnb(msg.sender, amount);
    }

    function _sendBnb(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @notice Recovery path: end the mint and open refunds, for a Launcher that cannot launch.
    function openRefunds() external onlyGuardian {
        if (launched) revert AlreadyLaunched();
        refundsOpen = true;
        emit RefundsOpened(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Launch and distribution
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Runs inside the mint that reaches the cap.
    function _launch() private {
        IPortalTypes.CreateTaxTokenParams memory p = _buildParams();
        Distribution memory dist = Distribution({
            target: DistributionTarget.EXPLICIT,
            strategy: address(this), // the Portal calls initializeDistribution on us
            amount: uint128(holderPool),
            configData: ""
        });
        IPortalTypes.CreatorBuyParams memory creatorBuy;

        // `LauncherBase._launchOnHub` takes calldata parameters and these are built in memory, so the same
        // Portal entry point is called directly.
        launching = true;
        (address token_, address pool_) = IPortal(hub).launchTaxTokenV2{value: p.poolQuote}(p, dist, creatorBuy);
        launching = false;

        if (!distributionInitialized) revert UnauthorizedDistribution();
        launched = true;
        token = token_;
        pool = pool_;
        emit Launched(token_, pool_, p.poolQuote, p.poolToken);
    }

    /// @inheritdoc IStrategy
    /// @dev Portal callback inside `_launch()`. The Portal has approved `amount`; this must pull all of it.
    function initializeDistribution(address token_, uint256 amount, bytes calldata, bytes32) external override onlyHub {
        if (!launching || distributionInitialized) revert UnauthorizedDistribution();
        if (token_ == address(0) || amount != holderPool) revert InvalidConfig();

        distributionInitialized = true;
        token = token_;

        token_.safeTransferFrom(msg.sender, address(this), amount);
        emit FlapDistributionInitialized(token_, amount);
    }

    /// @notice Tokens `account` would receive from `claim()` right now.
    function claimableOf(address account) external view returns (uint256) {
        if (!launched) return 0;
        uint256[] storage list = _owned[account];
        uint256 unclaimed;
        for (uint256 i; i < list.length; ++i) {
            if (!claimed[list[i]]) ++unclaimed;
        }
        return unclaimed * tokensPerNFT;
    }

    /// @notice Claim the token share of every unclaimed NFT the caller holds. Each NFT claims once and stays
    ///         with its holder.
    function claim() external {
        if (!launched) revert NotLaunched();

        uint256[] storage list = _owned[msg.sender];
        uint256 share = tokensPerNFT;
        uint256 count;
        for (uint256 i; i < list.length; ++i) {
            uint256 id = list[i];
            if (claimed[id]) continue;
            claimed[id] = true;
            ++count;
            emit Claimed(id, msg.sender, share);
        }
        if (count == 0) revert NothingToClaim();
        token.safeTransfer(msg.sender, share * count);
    }

    /// @notice Claim the token share of each listed NFT. For a holder with too many NFTs for one `claim()` call.
    ///         The caller must hold every one and none may have claimed.
    function claimNFTs(uint256[] calldata tokenIds) external {
        if (!launched) revert NotLaunched();

        uint256 share = tokensPerNFT;
        uint256 count = tokenIds.length;
        if (count == 0) revert NothingToClaim();
        for (uint256 i; i < count; ++i) {
            uint256 id = tokenIds[i];
            if (_ownerOf(id) != msg.sender) revert NotHolder(id);
            if (claimed[id]) revert AlreadyClaimed(id);
            claimed[id] = true;
            emit Claimed(id, msg.sender, share);
        }
        token.safeTransfer(msg.sender, share * count);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // NFT ownership index
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The NFTs `account` holds, in no particular order.
    function nftsOf(address account) external view returns (uint256[] memory) {
        return _owned[account];
    }

    /// @dev Keeps `_owned` in step with every mint, transfer and burn.
    function _afterTokenTransfer(address from, address to, uint256 id) internal override {
        if (from == to) return;
        if (from != address(0)) {
            uint256[] storage list = _owned[from];
            uint256 lastIndex = list.length - 1;
            uint256 index = _ownedIndex[id];
            if (index != lastIndex) {
                uint256 moved = list[lastIndex];
                list[index] = moved;
                _ownedIndex[moved] = index;
            }
            list.pop();
            delete _ownedIndex[id];
        }
        if (to != address(0)) {
            _ownedIndex[id] = _owned[to].length;
            _owned[to].push(id);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Launch parameters
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The whole raise as the quote side, the configured share of the supply as the token side, and the
    ///      configured taxes for 30 days.
    function _buildParams() private view returns (IPortalTypes.CreateTaxTokenParams memory p) {
        p.name = tokenName;
        p.symbol = tokenSymbol;
        p.meta = tokenMeta;
        p.totalSupply = TOTAL_SUPPLY;
        p.salt = launchSalt;
        p.quoteToken = address(0); // native BNB
        p.dexId = 0;
        p.poolQuote = raised;
        p.poolToken = poolToken;
        p.buyTaxRate = buyTaxBps;
        p.sellTaxRate = sellTaxBps;
        p.taxDuration = 30 days;
        p.antiFarmerDuration = 1 days;
        p.feeConfigs = _feeConfigs();
        p.antiSniperMode = 0;
        p.exemptWindow = 0;
        p.exemptAddrs = new address[](0);
        p.creatorBuyQuote = 0;
        // Show the wallet that created the Launcher, not this contract, as the creator on the launch event.
        (p.extensionID, p.extensionData) = LaunchExtensionHelper.encodeCreator(creator);
        // No royalty: no commission on launches.
        p.commissionReceiver = address(0);
    }

    /// @dev Tax split, bps summing to 10_000: 10% burn, 15% liquidity, 75% BNB dividends to holders. The
    ///      dividend minimum balance is the lowest the Portal allows (0.001% of supply), so one NFT's share
    ///      qualifies even in the largest mint.
    function _feeConfigs() private pure returns (IPortalTypes.FeeConfig[] memory fees) {
        fees = new IPortalTypes.FeeConfig[](3);
        fees[0] = IPortalTypes.FeeConfig({feeType: IPortalTypes.FeeSlotType.DEFLATION, bps: 1000, configData: ""});
        fees[1] = IPortalTypes.FeeConfig({feeType: IPortalTypes.FeeSlotType.LP_BPS, bps: 1500, configData: ""});
        fees[2] = IPortalTypes.FeeConfig({
            feeType: IPortalTypes.FeeSlotType.DIVIDEND,
            bps: 7500,
            configData: abi.encode(
                IPortalTypes.FeeConfigDividend({
                    dividendToken: address(0), // quote token
                    minimumShareBalance: TOTAL_SUPPLY / 100_000
                })
            )
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ERC721 metadata
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Collection name: the token name followed by "CallZ Pass".
    function name() public view override returns (string memory) {
        return string.concat(tokenName, " CallZ Pass");
    }

    function symbol() public view override returns (string memory) {
        return string.concat(tokenSymbol, "-PASS");
    }

    /// @notice On-chain metadata: no external host to go down.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (!_exists(tokenId)) revert TokenDoesNotExist();

        string memory id = LibString.toString(tokenId);
        string memory status = !launched ? "Minting" : claimed[tokenId] ? "Claimed" : "Unclaimed";
        string memory image = Base64.encode(
            bytes(
                string.concat(
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#0b0e11"/>',
                    '<path d="M200 80 320 200 200 320 80 200Z" fill="none" stroke="#f0b90b" stroke-width="16"/>',
                    '<circle cx="80" cy="200" r="24" fill="#0b0e11"/><circle cx="320" cy="200" r="24" fill="#0b0e11"/>',
                    '<path d="M200 150 250 200 200 250 150 200Z" fill="#f0b90b"/>',
                    '<text x="200" y="368" fill="#eaecef" font-family="monospace" font-size="20" text-anchor="middle">',
                    LibString.escapeHTML(tokenSymbol),
                    " CallZ Pass #",
                    id,
                    "</text></svg>"
                )
            )
        );
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(
                bytes(
                    string.concat(
                        '{"name":"',
                        LibString.escapeJSON(name(), false),
                        " #",
                        id,
                        '","description":"CallZ pass for ',
                        LibString.escapeJSON(tokenName, false),
                        '. Claims an equal share of the supply that is not in the pool, once, and stays with its holder.",',
                        '"attributes":[{"trait_type":"Status","value":"',
                        status,
                        '"}],"image":"data:image/svg+xml;base64,',
                        image,
                        '"}'
                    )
                )
            )
        );
    }
}
