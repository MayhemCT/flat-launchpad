// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin-contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC721} from "solady/tokens/ERC721.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @notice The part of Flap's bonding curve Portal that RaidPassCurve uses.
/// @dev Layout from https://docs.flap.sh/en/flap/v2/developers/bonding-curve/launch-tokens. Enums are `uint8`.
interface IBondingCurvePortal {
    struct NewTokenV6Params {
        string name;
        string symbol;
        string meta;
        uint8 dexThresh; // 1 = FOUR_FIFTHS, the only accepted value
        bytes32 salt;
        uint8 migratorType; // 1 = V2, required for tax tokens
        address quoteToken; // address(0) = native
        uint256 quoteAmt; // creator's first buy, sent as msg.value
        address beneficiary;
        bytes permitData;
        bytes32 extensionID;
        bytes extensionData;
        uint8 dexId;
        uint8 lpFeeProfile;
        uint16 buyTaxRate;
        uint16 sellTaxRate;
        uint64 taxDuration;
        uint64 antiFarmerDuration;
        uint16 mktBps;
        uint16 deflationBps;
        uint16 dividendBps;
        uint16 lpBps;
        uint256 minimumShareBalance;
        address dividendToken;
        address commissionReceiver;
        uint8 tokenVersion; // 6 = TOKEN_TAXED_V3
    }

    function newTokenV6(NewTokenV6Params calldata params) external payable returns (address token);
    function lockSalt(bytes32 salt, uint8 tokenVersion) external payable;
    function SALT_LOCK_FEE() external view returns (uint256);
}

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Payload for `RaidPassCurveFactory.create`.
/// @param name         Token name. The pass collection is named after it.
/// @param symbol       Token symbol.
/// @param meta         Token metadata CID, passed to the token unchanged.
/// @param salt         CREATE2 launch salt, mined so the predicted token address ends in `0x7777`.
/// @param mintPrice    BNB per pass.
/// @param maxPasses    Passes in the mint. `mintPrice * maxPasses` is spent on the curve at launch.
/// @param saleDuration Length of the mint window in seconds, counted from creation.
struct RaidPassCurveConfig {
    string name;
    string symbol;
    string meta;
    bytes32 salt;
    uint256 mintPrice;
    uint256 maxPasses;
    uint256 saleDuration;
}

/// @notice Everything a mint page needs, in one call.
struct RaidPassCurveInfo {
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
    uint256 bnbPerPass;
    bool launched;
    address token;
}

/// @title RaidPassCurve
/// @notice An NFT mint that is the entry to a Flap bonding curve launch.
///
///         Buyers mint RaidPass NFTs with BNB at a fixed price. The mint that sells the last pass creates the
///         token on Flap's bonding curve and spends the whole raise on the curve in that same transaction, as
///         the launch's first buy. Every pass then claims an equal share of the tokens bought, once, and stays
///         with its holder as a membership pass.
///
///         If the mint does not sell out by the deadline, a pass is burned for its mint price. The refund goes
///         to whoever holds the pass at that moment.
///
///         Flap's bonding curve Portal is permissionless, so this works on BNB Chain without a factory approval.
///         Nobody can withdraw the raise: it leaves this contract only through the launch or through refunds.
///
/// @dev Deployed by `RaidPassCurveFactory` as an immutable minimal clone. There is no owner and no upgrade path.
contract RaidPassCurve is Initializable, ERC721 {
    using SafeTransferLib for address;

    /// @notice Largest mint a contract can hold.
    uint256 public constant MAX_PASSES = 10_000;
    /// @notice Passes one `mint` call can buy. Bounds the gas of the mint that also runs the launch.
    uint256 public constant MAX_MINT_PER_TX = 50;
    uint256 public constant MIN_SALE_DURATION = 10 minutes;
    uint256 public constant MAX_SALE_DURATION = 30 days;
    /// @dev Flap's TOKEN_TAXED_V3.
    uint8 internal constant TOKEN_VERSION = 6;

    /// @notice Flap's bonding curve Portal.
    address public portal;
    address public creator;
    bytes32 public launchSalt;

    uint256 public mintPrice;
    uint256 public maxPasses;
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

    bool public launched;
    /// @dev True only while the Portal call is running: blocks re-entry and accepts the Portal's change.
    bool internal launching;

    address public token;
    /// @notice Tokens each pass claims after the launch: the tokens bought on the curve, split equally.
    uint256 public tokensPerPass;
    /// @notice BNB each pass claims after the launch: any part of the raise the Portal did not spend.
    uint256 public bnbPerPass;
    mapping(uint256 tokenId => bool) public passClaimed;

    /// @dev Passes held by each account, and each pass's position in its holder's list.
    mapping(address account => uint256[]) internal _owned;
    mapping(uint256 tokenId => uint256) internal _ownedIndex;

    event PassesMinted(address indexed account, uint256 firstTokenId, uint256 quantity, uint256 paid);
    event PassRefunded(address indexed account, uint256 indexed tokenId, uint256 amount);
    event PassClaimed(address indexed account, uint256 indexed tokenId, uint256 tokens, uint256 bnb);
    event Launched(address indexed token, uint256 spent, uint256 tokensBought, uint256 unspent);

    error InvalidConfig();
    error SaleClosed();
    error ZeroQuantity();
    error MintTooLarge();
    error SoldOut();
    error WrongPayment(uint256 sent, uint256 required);
    error LaunchInProgress();
    error NothingBought();
    error NotLaunched();
    error AlreadyLaunched();
    error NotPassHolder(uint256 tokenId);
    error PassAlreadyClaimed(uint256 tokenId);
    error RefundUnavailable();
    error NothingToRefund();
    error NothingToClaim();
    error EthTransferFailed();
    error UnexpectedPayment();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by the factory in the transaction that deploys the clone.
    /// @dev `msg.value` must be the Portal's salt-lock fee. This contract locks the salt itself, so only it can
    ///      launch a token at the reserved address.
    function initialize(address portal_, address creator_, RaidPassCurveConfig calldata c) external payable initializer {
        if (portal_ == address(0) || creator_ == address(0)) revert InvalidConfig();
        if (c.salt == bytes32(0) || c.mintPrice == 0) revert InvalidConfig();
        if (c.maxPasses == 0 || c.maxPasses > MAX_PASSES) revert InvalidConfig();
        if (c.saleDuration < MIN_SALE_DURATION || c.saleDuration > MAX_SALE_DURATION) revert InvalidConfig();
        if (bytes(c.name).length == 0 || bytes(c.symbol).length == 0) revert InvalidConfig();

        portal = portal_;
        creator = creator_;
        launchSalt = c.salt;
        mintPrice = c.mintPrice;
        maxPasses = c.maxPasses;
        saleDeadline = block.timestamp + c.saleDuration;
        tokenName = c.name;
        tokenSymbol = c.symbol;
        tokenMeta = c.meta;

        uint256 fee = IBondingCurvePortal(portal_).SALT_LOCK_FEE();
        if (msg.value != fee) revert InvalidConfig();
        IBondingCurvePortal(portal_).lockSalt{value: fee}(c.salt, TOKEN_VERSION);
    }

    /// @notice BNB the mint raises when it sells out, all of it spent on the curve.
    function targetRaise() public view returns (uint256) {
        return mintPrice * maxPasses;
    }

    /// @notice The mint's whole state, for a mint page.
    function info() external view returns (RaidPassCurveInfo memory i) {
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
        i.bnbPerPass = bnbPerPass;
        i.launched = launched;
        i.token = token;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Buy passes: send `mintPrice` for each one. The call that sells the last pass also launches.
    function mint() external payable {
        if (launching) revert LaunchInProgress();
        if (launched) revert AlreadyLaunched();
        if (block.timestamp >= saleDeadline) revert SaleClosed();

        uint256 quantity = msg.value / mintPrice;
        if (quantity == 0) revert ZeroQuantity();
        if (quantity * mintPrice != msg.value) revert WrongPayment(msg.value, quantity * mintPrice);
        if (quantity > MAX_MINT_PER_TX) revert MintTooLarge();

        uint256 first = minted + 1;
        uint256 last = minted + quantity;
        if (last > maxPasses) revert SoldOut();

        minted = last;
        raised += msg.value;
        for (uint256 id = first; id <= last; ++id) {
            _mint(msg.sender, id);
        }
        emit PassesMinted(msg.sender, first, quantity, msg.value);

        if (last == maxPasses) _launch();
    }

    /// @notice Whether passes can be burned for a refund: the mint missed its deadline without selling out.
    function refundAvailable() public view returns (bool) {
        return !launched && !launching && block.timestamp >= saleDeadline && minted < maxPasses;
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
            uint256 id = list[i - 1];
            _burn(id);
            emit PassRefunded(msg.sender, id, price);
        }
        _payRefund(count, price);
    }

    /// @notice Burn the listed passes for their mint price. The caller must hold every pass.
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
        _sendBnb(msg.sender, amount);
    }

    function _sendBnb(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Launch
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Runs inside the mint that sells the last pass: creates the token and spends the raise on the curve.
    function _launch() private {
        uint256 spend = raised;
        IBondingCurvePortal.NewTokenV6Params memory p = _buildParams(spend);

        launching = true;
        address token_ = IBondingCurvePortal(portal).newTokenV6{value: spend}(p);
        launching = false;

        uint256 bought = IERC20Balance(token_).balanceOf(address(this));
        if (bought == 0) revert NothingBought();
        // The Portal returns any part of the first buy it could not spend; passes share it.
        uint256 unspent = address(this).balance;

        launched = true;
        token = token_;
        tokensPerPass = bought / maxPasses;
        bnbPerPass = unspent / maxPasses;
        emit Launched(token_, spend - unspent, bought, unspent);
    }

    /// @dev Accepts BNB only from the Portal while the launch is running (its change from the first buy).
    receive() external payable {
        if (!launching) revert UnexpectedPayment();
    }

    /// @dev A tax token with 3% buy and 5% sell tax for 30 days. The tax goes to holders as BNB dividends (75%),
    ///      to liquidity (15%) and to burning (10%); none of it goes to the creator and there is no commission.
    function _buildParams(uint256 spend) private view returns (IBondingCurvePortal.NewTokenV6Params memory p) {
        p.name = tokenName;
        p.symbol = tokenSymbol;
        p.meta = tokenMeta;
        p.dexThresh = 1;
        p.salt = launchSalt;
        p.migratorType = 1;
        p.quoteToken = address(0);
        p.quoteAmt = spend;
        p.beneficiary = creator;
        p.dexId = 0;
        p.lpFeeProfile = 0;
        p.buyTaxRate = 300;
        p.sellTaxRate = 500;
        p.taxDuration = 30 days;
        p.antiFarmerDuration = 1 days;
        p.mktBps = 0;
        p.deflationBps = 1000;
        p.dividendBps = 7500;
        p.lpBps = 1500;
        p.minimumShareBalance = 10_000 ether;
        p.dividendToken = address(0);
        p.commissionReceiver = address(0);
        p.tokenVersion = TOKEN_VERSION;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Claim
    // ─────────────────────────────────────────────────────────────────────────

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

    /// @notice Claim the share of every unclaimed pass the caller holds. Each pass claims once and stays with
    ///         its holder.
    function claim() external {
        if (!launched) revert NotLaunched();

        uint256[] storage list = _owned[msg.sender];
        uint256 count;
        for (uint256 i; i < list.length; ++i) {
            uint256 id = list[i];
            if (passClaimed[id]) continue;
            passClaimed[id] = true;
            ++count;
            emit PassClaimed(msg.sender, id, tokensPerPass, bnbPerPass);
        }
        if (count == 0) revert NothingToClaim();
        _payClaim(count);
    }

    /// @notice Claim the share of each listed pass. The caller must hold every pass and none may have claimed.
    function claimPasses(uint256[] calldata tokenIds) external {
        if (!launched) revert NotLaunched();

        uint256 count = tokenIds.length;
        if (count == 0) revert NothingToClaim();
        for (uint256 i; i < count; ++i) {
            uint256 id = tokenIds[i];
            if (_ownerOf(id) != msg.sender) revert NotPassHolder(id);
            if (passClaimed[id]) revert PassAlreadyClaimed(id);
            passClaimed[id] = true;
            emit PassClaimed(msg.sender, id, tokensPerPass, bnbPerPass);
        }
        _payClaim(count);
    }

    function _payClaim(uint256 count) private {
        token.safeTransfer(msg.sender, tokensPerPass * count);
        uint256 bnb = bnbPerPass * count;
        if (bnb > 0) _sendBnb(msg.sender, bnb);
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
    // ERC721 metadata
    // ─────────────────────────────────────────────────────────────────────────

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
                    '<path d="M200 80 320 200 200 320 80 200Z" fill="none" stroke="#f0b90b" stroke-width="16"/>',
                    '<circle cx="80" cy="200" r="24" fill="#0b0e11"/><circle cx="320" cy="200" r="24" fill="#0b0e11"/>',
                    '<path d="M200 150 250 200 200 250 150 200Z" fill="#f0b90b"/>',
                    '<text x="200" y="368" fill="#eaecef" font-family="monospace" font-size="20" text-anchor="middle">',
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
                        '. Claims an equal share of the tokens bought on the bonding curve at launch and stays with its holder.",',
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
