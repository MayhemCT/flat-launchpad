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
/// @param name         Token name. The NFT collection is named after it.
/// @param symbol       Token symbol.
/// @param meta         Token metadata CID, passed to the token unchanged.
/// @param salt         CREATE2 launch salt, mined so the predicted token address ends in `0x7777`.
/// @param nftPrice     BNB per NFT. Every NFT costs the same.
/// @param cap          BNB the mint raises: at most 10 BNB and an exact multiple of `nftPrice`. All of it is spent
///                     on the curve at launch. `cap / nftPrice` NFTs are sold.
/// @param saleDuration Length of the mint window in seconds, counted from creation.
/// @param buyTaxBps    Buy tax in bps, 100 to 1000 (Flap's range for a tax token on the curve).
/// @param sellTaxBps   Sell tax in bps, 100 to 1000.
struct RaidPassCurveConfig {
    string name;
    string symbol;
    string meta;
    bytes32 salt;
    uint256 nftPrice;
    uint256 cap;
    uint256 saleDuration;
    uint16 buyTaxBps;
    uint16 sellTaxBps;
}

/// @notice Everything a mint page needs, in one call.
struct RaidPassCurveInfo {
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
    uint256 tokensPerNFT;
    uint256 bnbPerNFT;
    uint16 buyTaxBps;
    uint16 sellTaxBps;
    bool launched;
    address token;
}

/// @title RaidPassCurve
/// @notice An NFT mint that is the entry to a Flap bonding curve launch.
///
///         Buyers mint RaidPass NFTs with BNB at a flat price. The mint that brings the raise to its cap creates
///         the token on Flap's bonding curve and spends the whole raise on the curve in that same transaction, as
///         the launch's first buy. Every NFT then claims an equal share of the tokens bought, once, and stays
///         with its holder as a membership pass.
///
///         If the cap is not reached by the deadline, an NFT is burned for its price. The refund goes to whoever
///         holds the NFT at that moment.
///
///         Flap's bonding curve Portal is permissionless, so this works on BNB Chain without a factory approval.
///         Nobody can withdraw the raise: it leaves this contract only through the launch or through refunds.
///         There is no mint fee and no commission.
///
/// @dev Deployed by `RaidPassCurveFactory` as an immutable minimal clone. There is no owner and no upgrade path.
contract RaidPassCurve is Initializable, ERC721 {
    using SafeTransferLib for address;

    /// @notice The most BNB a mint can raise.
    uint256 public constant MAX_CAP = 10 ether;
    /// @notice The most NFTs a mint can hold.
    uint256 public constant MAX_NFTS = 10_000;
    /// @notice NFTs one `mint` call can buy. Bounds the gas of the mint that also runs the launch.
    uint256 public constant MAX_MINT_PER_TX = 50;
    uint16 public constant MIN_TAX_BPS = 100;
    uint16 public constant MAX_TAX_BPS = 1000;
    uint256 public constant MIN_SALE_DURATION = 10 minutes;
    uint256 public constant MAX_SALE_DURATION = 30 days;
    /// @notice Longest token name, symbol and metadata CID, in bytes. The Portal reads at most 4,096 bytes of a
    ///         Launcher's `description()` and stores an empty one past that, so the user-supplied part is capped.
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 32;
    uint256 public constant MAX_META_BYTES = 128;
    /// @dev Flap's TOKEN_TAXED_V3.
    uint8 internal constant TOKEN_VERSION = 6;

    /// @notice Flap's bonding curve Portal.
    address public portal;
    address public creator;
    bytes32 public launchSalt;

    /// @notice BNB per NFT.
    uint256 public nftPrice;
    /// @notice BNB the mint raises, all of it spent on the curve at launch.
    uint256 public cap;
    /// @notice NFTs in the mint: `cap / nftPrice`.
    uint256 public maxNFTs;
    uint256 public saleDeadline;
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

    bool public launched;
    /// @dev True only while the Portal call is running: blocks re-entry and accepts the Portal's change.
    bool internal launching;

    address public token;
    /// @notice Tokens each NFT claims after the launch: the tokens bought on the curve, split equally.
    uint256 public tokensPerNFT;
    /// @notice BNB each NFT claims after the launch: any part of the raise the Portal did not spend.
    uint256 public bnbPerNFT;
    /// @notice Whether an NFT has claimed.
    mapping(uint256 tokenId => bool) public claimed;

    /// @dev NFTs held by each account, and each NFT's position in its holder's list.
    mapping(address account => uint256[]) internal _owned;
    mapping(uint256 tokenId => uint256) internal _ownedIndex;

    event Minted(address indexed to, uint256 firstId, uint256 qty, uint256 paid);
    event Launched(address indexed token, uint256 spent, uint256 tokensBought, uint256 unspent);
    event Claimed(uint256 indexed tokenId, address indexed to, uint256 amount);
    event Refunded(uint256 indexed tokenId, address indexed to, uint256 amount);

    error InvalidConfig();
    error SaleClosed();
    error ZeroQuantity();
    error MintTooLarge();
    error WrongPayment(uint256 sent, uint256 required);
    error LaunchInProgress();
    error NothingBought();
    error NotLaunched();
    error AlreadyLaunched();
    error NotHolder(uint256 tokenId);
    error AlreadyClaimed(uint256 tokenId);
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
        if (portal_ == address(0) || creator_ == address(0) || c.salt == bytes32(0)) revert InvalidConfig();
        if (bytes(c.name).length == 0 || bytes(c.name).length > MAX_NAME_BYTES) revert InvalidConfig();
        if (bytes(c.symbol).length == 0 || bytes(c.symbol).length > MAX_SYMBOL_BYTES) revert InvalidConfig();
        if (bytes(c.meta).length > MAX_META_BYTES) revert InvalidConfig();
        // The cap is a whole number of NFTs, so the raise can land on it exactly.
        if (c.nftPrice == 0 || c.cap == 0 || c.cap > MAX_CAP || c.cap % c.nftPrice != 0) revert InvalidConfig();
        uint256 count = c.cap / c.nftPrice;
        if (count > MAX_NFTS) revert InvalidConfig();
        if (c.buyTaxBps < MIN_TAX_BPS || c.buyTaxBps > MAX_TAX_BPS) revert InvalidConfig();
        if (c.sellTaxBps < MIN_TAX_BPS || c.sellTaxBps > MAX_TAX_BPS) revert InvalidConfig();
        if (c.saleDuration < MIN_SALE_DURATION || c.saleDuration > MAX_SALE_DURATION) revert InvalidConfig();

        portal = portal_;
        creator = creator_;
        launchSalt = c.salt;
        nftPrice = c.nftPrice;
        cap = c.cap;
        maxNFTs = count;
        saleDeadline = block.timestamp + c.saleDuration;
        buyTaxBps = c.buyTaxBps;
        sellTaxBps = c.sellTaxBps;
        tokenName = c.name;
        tokenSymbol = c.symbol;
        tokenMeta = c.meta;

        uint256 fee = IBondingCurvePortal(portal_).SALT_LOCK_FEE();
        if (msg.value != fee) revert InvalidConfig();
        IBondingCurvePortal(portal_).lockSalt{value: fee}(c.salt, TOKEN_VERSION);
    }

    /// @notice The raise target: the same value as `cap`.
    function targetRaise() external view returns (uint256) {
        return cap;
    }

    /// @notice Implementation version.
    function version() external pure returns (string memory) {
        return "1.0.0";
    }

    /// @notice The mint's whole state, for a mint page.
    function info() external view returns (RaidPassCurveInfo memory i) {
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
        i.tokensPerNFT = tokensPerNFT;
        i.bnbPerNFT = bnbPerNFT;
        i.buyTaxBps = buyTaxBps;
        i.sellTaxBps = sellTaxBps;
        i.launched = launched;
        i.token = token;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Buy NFTs: send `nftPrice` for each one. The call that reaches the cap also launches.
    /// @dev The quantity is the value sent divided by `nftPrice`, and the value must be an exact multiple. A
    ///      buyer who asks for more NFTs than are left gets what is left, and the BNB for the others back.
    function mint() external payable {
        if (launching) revert LaunchInProgress();
        if (launched) revert AlreadyLaunched();
        if (block.timestamp >= saleDeadline) revert SaleClosed();

        uint256 price = nftPrice;
        uint256 quantity = msg.value / price;
        if (quantity == 0) revert ZeroQuantity();
        if (quantity * price != msg.value) revert WrongPayment(msg.value, quantity * price);

        uint256 left = maxNFTs - minted;
        if (quantity > left) quantity = left;
        if (quantity > MAX_MINT_PER_TX) revert MintTooLarge();

        uint256 paid = quantity * price;
        uint256 change = msg.value - paid;
        uint256 first = minted + 1;
        uint256 last = minted + quantity;
        minted = last;
        raised += paid;
        for (uint256 id = first; id <= last; ++id) {
            _mint(msg.sender, id);
        }
        emit Minted(msg.sender, first, quantity, paid);

        // The buyer's change is still held here during the launch, so the launch must not count it.
        if (last == maxNFTs) _launch(change);

        // Overflow: return what the buyer sent for NFTs that were no longer available.
        if (change > 0) _sendBnb(msg.sender, change);
    }

    /// @notice Whether NFTs can be burned for a refund: the mint missed its deadline without reaching the cap.
    function refundAvailable() public view returns (bool) {
        return !launched && !launching && block.timestamp >= saleDeadline && minted < maxNFTs;
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

    /// @notice Burn the listed NFTs for their price. The caller must hold every one.
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

    // ─────────────────────────────────────────────────────────────────────────
    // Launch
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Runs inside the mint that reaches the cap: creates the token and spends the raise on the curve.
    /// @param held BNB in this contract that is not part of the raise (the last buyer's change).
    function _launch(uint256 held) private {
        uint256 spend = raised;
        IBondingCurvePortal.NewTokenV6Params memory p = _buildParams(spend);

        launching = true;
        address token_ = IBondingCurvePortal(portal).newTokenV6{value: spend}(p);
        launching = false;

        uint256 bought = IERC20Balance(token_).balanceOf(address(this));
        if (bought == 0) revert NothingBought();
        // The Portal returns any part of the first buy it could not spend; the NFTs share it.
        uint256 unspent = address(this).balance - held;

        launched = true;
        token = token_;
        tokensPerNFT = bought / maxNFTs;
        bnbPerNFT = unspent / maxNFTs;
        emit Launched(token_, spend - unspent, bought, unspent);
    }

    /// @dev Accepts BNB only from the Portal while the launch is running (its change from the first buy).
    receive() external payable {
        if (!launching) revert UnexpectedPayment();
    }

    /// @dev A tax token with the configured buy and sell tax for 30 days. The tax goes to holders as BNB
    ///      dividends (75%), to liquidity (15%) and to burning (10%); none of it goes to the creator and there
    ///      is no commission.
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
        p.buyTaxRate = buyTaxBps;
        p.sellTaxRate = sellTaxBps;
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
            if (!claimed[list[i]]) ++unclaimed;
        }
        return unclaimed * tokensPerNFT;
    }

    /// @notice Claim the share of every unclaimed NFT the caller holds. Each NFT claims once and stays with its
    ///         holder.
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
        _payClaim(count);
    }

    /// @notice Claim the share of each listed NFT. The caller must hold every one and none may have claimed.
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
        _payClaim(count);
    }

    function _payClaim(uint256 count) private {
        token.safeTransfer(msg.sender, tokensPerNFT * count);
        uint256 bnb = bnbPerNFT * count;
        if (bnb > 0) _sendBnb(msg.sender, bnb);
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
