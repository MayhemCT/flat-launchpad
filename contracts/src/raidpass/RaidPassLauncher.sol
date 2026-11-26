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
string constant RAIDPASS_TITLE_ZH = unicode"RaidPass NFT 铸造发射";
string constant RAIDPASS_TITLE_EN = "RaidPass NFT mint";
string constant RAIDPASS_SUMMARY_ZH =
    unicode"使用 BNB 铸造 RaidPass NFT。全部铸造完成后，募集的 BNB 与 50% 的代币供应一起注入流动性池，LP 被销毁。每个 NFT 可领取另外 50% 中的等额份额，NFT 仍归持有人所有。若在截止时间前未铸造完毕，销毁 NFT 即可取回铸造价。";
string constant RAIDPASS_SUMMARY_EN =
    "Mint a RaidPass NFT with BNB. When every pass is minted, the whole raise and 50% of the supply seed the pool and the LP is burned. Each pass then claims an equal share of the other 50% and stays with its holder. If the mint does not sell out by the deadline, burn a pass to get its mint price back.";

/// @notice Payload the creator passes to `Portal.newLauncher(factory, abi.encode(RaidPassConfig))`.
/// @param name         Token name. The pass collection is named after it.
/// @param symbol       Token symbol.
/// @param meta         Token metadata CID, passed to the token unchanged.
/// @param salt         CREATE2 launch salt, mined so the predicted token address ends in `0x7777`.
/// @param mintPrice    BNB per pass.
/// @param maxPasses    Passes in the mint. `mintPrice * maxPasses` is the raise target and the exact `poolQuote`.
/// @param saleDuration Length of the mint window in seconds, counted from creation.
struct RaidPassConfig {
    string name;
    string symbol;
    string meta;
    bytes32 salt;
    uint256 mintPrice;
    uint256 maxPasses;
    uint256 saleDuration;
}

/// @notice Everything a launch page needs, in one call.
struct RaidPassInfo {
    address creator;
    string tokenName;
    string tokenSymbol;
    string tokenMeta;
    uint256 mintPrice;
    uint256 maxPasses;
    uint256 minted;
    uint256 burned;
    uint256 raised;
    uint256 targetRaise;
    uint256 saleDeadline;
    uint256 tokensPerPass;
    bool launched;
    bool refundsOpen;
    address token;
    address pool;
}

/// @title RaidPassLauncher
/// @notice A Pool Launch Launcher whose presale is an NFT mint.
///
///         Minters buy RaidPass NFTs with BNB at a fixed price. The mint that sells the last pass launches the
///         token in the same transaction: the whole raise is the pool's quote side, half of the supply is the
///         pool's token side, the LP is burned, and the other half of the supply comes back here. Each pass then
///         claims an equal share of that half, once, and stays with its holder as a membership pass.
///
///         If the mint does not sell out by the deadline, a pass is burned for its mint price. The refund goes to
///         whoever holds the pass at that moment, so passes can change hands safely before the launch.
///
///         Order of events:
///           1. `initialize` runs once, in the transaction that deploys the proxy, and locks the launch salt from
///              this contract (the Portal requires `locker == launcher` at launch).
///           2. `mint()` sells one pass per `mintPrice` sent, until `maxPasses`. The call that sells the last one
///              runs `_launch()`.
///           3. `_launch()` calls `Portal.launchTaxTokenV2` with `poolQuote = raised` and
///              `poolToken = TOTAL_SUPPLY / 2`. The other half is routed here with
///              `Distribution{EXPLICIT, strategy = this}`.
///           4. Inside that call the Portal invokes `initializeDistribution`, and this contract pulls the half.
///           5. After the launch, `claim()` pays `tokensPerPass` for each unclaimed pass the caller holds.
///           6. After a missed deadline, `refund()` burns the caller's passes for `mintPrice` each.
///
///         `mint`, `claim` and `refund` take no arguments, so a host that can only call zero-argument methods
///         (the Flap Launcher UI runtime) can offer every action. `claimPasses` and `refundPasses` take pass ids
///         for holders with too many passes for one call.
///
/// @dev Deployed by `RaidPassLauncherFactory` as an ERC1967 beacon proxy. Only the Flap Guardian can upgrade the
///      implementation. No account can withdraw the raise: it leaves only through the launch or through refunds.
contract RaidPassLauncher is LauncherBase, Initializable, ERC721, IStrategy {
    using SafeTransferLib for address;

    /// @notice Supply the Portal mints: 1,000,000,000 tokens.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    /// @notice Pool side of the supply: 50%.
    uint256 public constant POOL_TOKEN = TOTAL_SUPPLY / 2;
    /// @notice The other 50%, split equally between the passes.
    uint256 public constant RESERVED_TOKEN = TOTAL_SUPPLY - POOL_TOKEN;

    /// @notice Largest mint a Launcher can hold. Keeps each pass's share above the dividend minimum balance.
    uint256 public constant MAX_PASSES = 10_000;
    /// @notice Passes one `mint` call can buy. Bounds the gas of the mint that also runs the launch.
    uint256 public constant MAX_MINT_PER_TX = 50;
    uint256 public constant MIN_SALE_DURATION = 10 minutes;
    uint256 public constant MAX_SALE_DURATION = 30 days;

    address public hub;
    address public creator;
    bytes32 public launchSalt;

    /// @notice BNB per pass.
    uint256 public mintPrice;
    /// @notice Passes in the mint.
    uint256 public maxPasses;
    /// @notice End of the mint window.
    uint256 public saleDeadline;

    string public tokenName;
    string public tokenSymbol;
    string public tokenMeta;

    /// @notice Passes minted so far. Pass ids run from 1 to `minted`.
    uint256 public minted;
    /// @notice Passes burned for a refund.
    uint256 public burned;
    /// @notice BNB held for the launch: `mintPrice` for every pass that has not been refunded.
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
    /// @notice Tokens each pass claims after the launch.
    uint256 public tokensPerPass;
    /// @notice Whether a pass has claimed its tokens.
    mapping(uint256 tokenId => bool) public passClaimed;

    /// @dev Passes held by each account, and each pass's position in its holder's list.
    mapping(address account => uint256[]) internal _owned;
    mapping(uint256 tokenId => uint256) internal _ownedIndex;

    event PassesMinted(address indexed account, uint256 firstTokenId, uint256 quantity, uint256 paid);
    event PassRefunded(address indexed account, uint256 indexed tokenId, uint256 amount);
    event PassClaimed(address indexed account, uint256 indexed tokenId, uint256 amount);
    event Launched(address indexed token, address indexed pool, uint256 poolQuote, uint256 poolToken);
    event RefundsOpened(address indexed guardian);

    error InvalidConfig();
    error SaleClosed();
    error ZeroQuantity();
    error MintTooLarge();
    error SoldOut();
    error WrongPayment(uint256 sent, uint256 required);
    error LaunchInProgress();
    error UnauthorizedDistribution();
    error NotLaunched();
    error AlreadyLaunched();
    error NotPassHolder(uint256 tokenId);
    error PassAlreadyClaimed(uint256 tokenId);
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
    function initialize(address hub_, address creator_, RaidPassConfig calldata c) external payable initializer {
        if (hub_ == address(0) || creator_ == address(0)) revert InvalidConfig();
        if (c.salt == bytes32(0) || c.mintPrice == 0) revert InvalidConfig();
        if (c.maxPasses == 0 || c.maxPasses > MAX_PASSES) revert InvalidConfig();
        if (c.saleDuration < MIN_SALE_DURATION || c.saleDuration > MAX_SALE_DURATION) revert InvalidConfig();
        if (bytes(c.name).length == 0 || bytes(c.symbol).length == 0) revert InvalidConfig();

        hub = hub_;
        creator = creator_;
        launchSalt = c.salt;
        mintPrice = c.mintPrice;
        maxPasses = c.maxPasses;
        saleDeadline = block.timestamp + c.saleDuration;
        tokenName = c.name;
        tokenSymbol = c.symbol;
        tokenMeta = c.meta;
        tokensPerPass = RESERVED_TOKEN / c.maxPasses;

        uint256 fee = IPortal(hub_).SALT_LOCK_FEE();
        // Exactly the fee: anything extra would stay here, since neither a refund nor the launch can spend it.
        if (msg.value != fee) revert InvalidConfig();
        IPortal(hub_).lockSalt{value: fee}(c.salt, uint8(IPortalTypes.LaunchKind.DIRECT_V2_POOL_TAX));
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
        d.targetRaise = targetRaise();
        d.poolTokenRatio = (POOL_TOKEN * 1e18) / TOTAL_SUPPLY;
        d.titleZh = RAIDPASS_TITLE_ZH;
        d.titleEn = RAIDPASS_TITLE_EN;
        d.summaryZh = RAIDPASS_SUMMARY_ZH;
        d.summaryEn = RAIDPASS_SUMMARY_EN;
    }

    /// @notice BNB the mint raises when it sells out; also the exact `poolQuote`.
    function targetRaise() public view returns (uint256) {
        return mintPrice * maxPasses;
    }

    /// @notice The Launcher's whole state, for a launch page.
    function info() external view returns (RaidPassInfo memory i) {
        i.creator = creator;
        i.tokenName = tokenName;
        i.tokenSymbol = tokenSymbol;
        i.tokenMeta = tokenMeta;
        i.mintPrice = mintPrice;
        i.maxPasses = maxPasses;
        i.minted = minted;
        i.burned = burned;
        i.raised = raised;
        i.targetRaise = targetRaise();
        i.saleDeadline = saleDeadline;
        i.tokensPerPass = tokensPerPass;
        i.launched = launched;
        i.refundsOpen = refundsOpen;
        i.token = token;
        i.pool = pool;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Buy passes: send `mintPrice` for each one. The call that sells the last pass also launches.
    /// @dev Takes no argument so that any host can offer it as a single payable action: the quantity is the
    ///      value sent divided by `mintPrice`, and the value must be an exact multiple.
    function mint() external payable {
        if (launching) revert LaunchInProgress();
        if (launched) revert AlreadyLaunched();
        if (refundsOpen || block.timestamp >= saleDeadline) revert SaleClosed();

        uint256 quantity = msg.value / mintPrice;
        if (quantity == 0) revert ZeroQuantity();
        if (quantity * mintPrice != msg.value) revert WrongPayment(msg.value, quantity * mintPrice);
        if (quantity > MAX_MINT_PER_TX) revert MintTooLarge();

        uint256 first = minted + 1;
        uint256 last = minted + quantity;
        if (last > maxPasses) revert SoldOut();

        minted = last;
        raised += msg.value;
        // `_mint`, not `_safeMint`: no callback into the buyer while the sale state is changing.
        for (uint256 id = first; id <= last; ++id) {
            _mint(msg.sender, id);
        }
        emit PassesMinted(msg.sender, first, quantity, msg.value);

        if (last == maxPasses) _launch();
    }

    /// @notice Whether passes can be burned for a refund: the mint missed its deadline without selling out, or
    ///         the Guardian opened refunds. Never after the launch.
    function refundAvailable() public view returns (bool) {
        if (launched || launching) return false;
        return refundsOpen || (block.timestamp >= saleDeadline && minted < maxPasses);
    }

    /// @notice BNB `account` would get back from `refund()` right now.
    function refundableOf(address account) external view returns (uint256) {
        return refundAvailable() ? _owned[account].length * mintPrice : 0;
    }

    /// @notice Burn every pass the caller holds for its mint price.
    function refund() external {
        if (!refundAvailable()) revert RefundUnavailable();

        uint256[] storage list = _owned[msg.sender];
        uint256 count = list.length;
        if (count == 0) revert NothingToRefund();
        uint256 price = mintPrice;
        for (uint256 i = count; i > 0; --i) {
            // Burning removes the pass from the end of the list, so walk it backwards.
            uint256 id = list[i - 1];
            _burn(id);
            emit PassRefunded(msg.sender, id, price);
        }
        _payRefund(count, price);
    }

    /// @notice Burn the listed passes for their mint price. For a holder with too many passes for one
    ///         `refund()` call. The caller must hold every pass.
    function refundPasses(uint256[] calldata tokenIds) external {
        if (!refundAvailable()) revert RefundUnavailable();

        uint256 count = tokenIds.length;
        if (count == 0) revert NothingToRefund();
        uint256 price = mintPrice;
        for (uint256 i; i < count; ++i) {
            uint256 id = tokenIds[i];
            if (_ownerOf(id) != msg.sender) revert NotPassHolder(id);
            _burn(id);
            emit PassRefunded(msg.sender, id, price);
        }
        _payRefund(count, price);
    }

    function _payRefund(uint256 count, uint256 price) private {
        uint256 amount = price * count;
        burned += count;
        raised -= amount;

        (bool ok,) = msg.sender.call{value: amount}("");
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

    /// @dev Runs inside the mint that sells the last pass.
    function _launch() private {
        IPortalTypes.CreateTaxTokenParams memory p = _buildParams();
        Distribution memory dist = Distribution({
            target: DistributionTarget.EXPLICIT,
            strategy: address(this), // the Portal calls initializeDistribution on us
            amount: uint128(RESERVED_TOKEN),
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
        emit Launched(token_, pool_, p.poolQuote, POOL_TOKEN);
    }

    /// @inheritdoc IStrategy
    /// @dev Portal callback inside `_launch()`. The Portal has approved `amount`; this must pull all of it.
    function initializeDistribution(address token_, uint256 amount, bytes calldata, bytes32) external override onlyHub {
        if (!launching || distributionInitialized) revert UnauthorizedDistribution();
        if (token_ == address(0) || amount != RESERVED_TOKEN) revert InvalidConfig();

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
            if (!passClaimed[list[i]]) ++unclaimed;
        }
        return unclaimed * tokensPerPass;
    }

    /// @notice Claim the token share of every unclaimed pass the caller holds. Each pass claims once and stays
    ///         with its holder.
    function claim() external {
        if (!launched) revert NotLaunched();

        uint256[] storage list = _owned[msg.sender];
        uint256 share = tokensPerPass;
        uint256 count;
        for (uint256 i; i < list.length; ++i) {
            uint256 id = list[i];
            if (passClaimed[id]) continue;
            passClaimed[id] = true;
            ++count;
            emit PassClaimed(msg.sender, id, share);
        }
        if (count == 0) revert NothingToClaim();
        token.safeTransfer(msg.sender, share * count);
    }

    /// @notice Claim the token share of each listed pass. For a holder with too many passes for one `claim()`
    ///         call. The caller must hold every pass and none may have claimed.
    function claimPasses(uint256[] calldata tokenIds) external {
        if (!launched) revert NotLaunched();

        uint256 share = tokensPerPass;
        uint256 count = tokenIds.length;
        if (count == 0) revert NothingToClaim();
        for (uint256 i; i < count; ++i) {
            uint256 id = tokenIds[i];
            if (_ownerOf(id) != msg.sender) revert NotPassHolder(id);
            if (passClaimed[id]) revert PassAlreadyClaimed(id);
            passClaimed[id] = true;
            emit PassClaimed(msg.sender, id, share);
        }
        token.safeTransfer(msg.sender, share * count);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pass ownership index
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The passes `account` holds, in no particular order.
    function passesOf(address account) external view returns (uint256[] memory) {
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

    /// @dev Fixed launch shape: the whole raise as the quote side, 50% of supply as the token side, 3% buy and
    ///      5% sell tax for 30 days.
    function _buildParams() private view returns (IPortalTypes.CreateTaxTokenParams memory p) {
        p.name = tokenName;
        p.symbol = tokenSymbol;
        p.meta = tokenMeta;
        p.totalSupply = TOTAL_SUPPLY;
        p.salt = launchSalt;
        p.quoteToken = address(0); // native BNB
        p.dexId = 0;
        p.poolQuote = raised;
        p.poolToken = POOL_TOKEN;
        p.buyTaxRate = 300;
        p.sellTaxRate = 500;
        p.taxDuration = 30 days;
        p.antiFarmerDuration = 1 days;
        p.feeConfigs = _feeConfigs();
        p.antiSniperMode = 0;
        p.exemptWindow = 0;
        p.exemptAddrs = new address[](0);
        p.creatorBuyQuote = 0;
        // Show the wallet that created the Launcher, not this contract, as the creator on the launch event.
        (p.extensionID, p.extensionData) = LaunchExtensionHelper.encodeCreator(creator);
        // No commission on launches.
        p.commissionReceiver = address(0);
    }

    /// @dev Tax split, bps summing to 10_000: 10% burn, 15% liquidity, 75% BNB dividends to holders. The
    ///      dividend minimum balance is the lowest the Portal allows (0.001% of supply), so one pass's share
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

    /// @notice Collection name: the token name followed by "RaidPass".
    function name() public view override returns (string memory) {
        return string.concat(tokenName, " RaidPass");
    }

    function symbol() public view override returns (string memory) {
        return string.concat(tokenSymbol, "-PASS");
    }

    /// @notice On-chain metadata: no external host to go down.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (!_exists(tokenId)) revert TokenDoesNotExist();

        string memory id = LibString.toString(tokenId);
        string memory status = !launched ? "Minting" : passClaimed[tokenId] ? "Claimed" : "Unclaimed";
        string memory image = Base64.encode(
            bytes(
                string.concat(
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#0b0e11"/>',
                    '<path d="M200 96l64 64-24 24-40-40-40 40-24-24zM200 304l-64-64 24-24 40 40 40-40 24 24zM200 176l24 24-24 24-24-24zM112 200l24-24 24 24-24 24zM288 200l-24 24-24-24 24-24z" fill="#f0b90b"/>',
                    '<text x="200" y="352" fill="#eaecef" font-family="monospace" font-size="20" text-anchor="middle">',
                    LibString.escapeHTML(tokenSymbol),
                    " RaidPass #",
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
                        '","description":"RaidPass for ',
                        LibString.escapeJSON(tokenName, false),
                        '. Claims an equal share of the reserved supply after the launch and stays with its holder.",',
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
