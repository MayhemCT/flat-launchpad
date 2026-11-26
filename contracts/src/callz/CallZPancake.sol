// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin-contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC721} from "solady/tokens/ERC721.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {CallZToken, CALLZ_TOTAL_SUPPLY} from "./CallZToken.sol";

/// @notice The part of the PancakeSwap V2 factory that CallZPancake uses.
interface IPancakeFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

/// @notice The part of a PancakeSwap V2 pair that CallZPancake uses.
interface IPancakePair {
    function mint(address to) external returns (uint256 liquidity);
}

/// @notice The part of WBNB that CallZPancake uses, besides the ERC-20 transfer.
interface IWBNB {
    function deposit() external payable;
}

/// @notice The part of CallZVault that CallZPancake uses.
interface ICallZFeeVault {
    function deposit(address token) external payable;
}

/// @notice Payload for `CallZPancakeFactory.create`.
/// @param name          Token name. The NFT collection is named after it.
/// @param symbol        Token symbol.
/// @param meta          Token metadata reference (a CID), kept on the mint for the app to read.
/// @param nftPrice      BNB per NFT. Every NFT costs the same.
/// @param cap           BNB the mint raises: at most 10 BNB and an exact multiple of `nftPrice`. The launch fee comes
///                      out of it and the rest becomes the pool's BNB side. `cap / nftPrice` NFTs are sold.
/// @param saleDuration  Length of the mint window in seconds, counted from creation.
/// @param poolShareBps  Share of the supply that goes into the pool, in bps (1000 to 9000). The rest is split
///                      equally between the NFTs.
struct CallZPancakeConfig {
    string name;
    string symbol;
    string meta;
    uint256 nftPrice;
    uint256 cap;
    uint256 saleDuration;
    uint16 poolShareBps;
}

/// @title CallZPancake
/// @notice An NFT mint that launches a token straight into a PancakeSwap V2 pool.
///
///         Buyers mint CallZ NFTs with BNB at a flat price. The mint that brings the raise to its cap deploys the
///         token and, in that same transaction, pays the launch fee to the CallZ vault and puts the rest of the
///         raise and the pool share of the supply into the token's PancakeSwap V2 pair with WBNB. The LP tokens
///         are minted to the dead address, so the liquidity can never be removed. Every NFT then claims an equal share of the rest of the supply, once, and stays
///         with its holder as a membership pass.
///
///         If the cap is not reached by the deadline, an NFT is burned for its price. The refund goes to whoever
///         holds the NFT at that moment.
///
///         Nobody can withdraw the raise: it leaves this contract only through the launch or through refunds.
///         The launch fee is a share of the raise, fixed when the mint is created (`launchFeeBps`, at most 10%)
///         and taken only if the mint launches: a refund returns the full price. It goes to the CallZ vault,
///         booked under the new token, where it rewards the people who call the token out. The token itself has
///         no tax.
///
/// @dev Deployed by `CallZPancakeFactory` as an immutable minimal clone. There is no owner, no admin function and
///      no upgrade path.
contract CallZPancake is Initializable, ERC721 {
    using SafeTransferLib for address;

    /// @notice Supply of the launched token: 1,000,000,000 tokens.
    uint256 public constant TOTAL_SUPPLY = CALLZ_TOTAL_SUPPLY;
    /// @notice The most BNB a mint can raise.
    uint256 public constant MAX_CAP = 10 ether;
    /// @notice The most NFTs a mint can hold.
    uint256 public constant MAX_NFTS = 10_000;
    /// @notice NFTs one `mint` call can buy. Bounds the gas of the mint that also runs the launch.
    uint256 public constant MAX_MINT_PER_TX = 50;
    uint16 public constant MIN_POOL_SHARE_BPS = 1000;
    uint16 public constant MAX_POOL_SHARE_BPS = 9000;
    /// @notice The highest launch fee a mint can carry: 10% of the raise.
    uint16 public constant MAX_LAUNCH_FEE_BPS = 1000;
    uint256 public constant MIN_SALE_DURATION = 10 minutes;
    uint256 public constant MAX_SALE_DURATION = 30 days;
    /// @notice Longest token name, symbol and metadata reference, in bytes.
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 32;
    uint256 public constant MAX_META_BYTES = 128;
    /// @notice Where the LP tokens go. Nobody holds the key to this address.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The PancakeSwap V2 factory the pair belongs to.
    address public pancakeFactory;
    /// @notice Wrapped BNB: the pool's quote token.
    address public wbnb;
    address public creator;
    /// @notice The CallZ vault the launch fee is paid to.
    address public vault;
    /// @notice Share of the raise paid to the vault at launch, in bps. Fixed at creation.
    uint16 public launchFeeBps;

    /// @notice BNB per NFT.
    uint256 public nftPrice;
    /// @notice BNB the mint raises. At launch the fee comes out of it and the rest is paired with the pool's tokens.
    uint256 public cap;
    /// @notice NFTs in the mint: `cap / nftPrice`.
    uint256 public maxNFTs;
    uint256 public saleDeadline;
    /// @notice Share of the supply that goes into the pool, in bps.
    uint16 public poolShareBps;

    string public tokenName;
    string public tokenSymbol;
    /// @notice Token metadata reference, as given at creation.
    string public meta;

    /// @notice NFTs minted so far. Token ids run from 1 to `minted`.
    uint256 public minted;
    /// @notice NFTs burned for a refund.
    uint256 public burned;
    /// @notice BNB held for the launch: `nftPrice` for every NFT that has not been refunded.
    uint256 public raised;

    bool public launched;
    /// @dev True only while the launch is running: blocks `mint` and `refund` from re-entering. `claim` stays
    ///      closed until `launched` is set, after the launch has finished.
    bool internal launching;

    address public token;
    /// @notice The token's PancakeSwap V2 pair with WBNB.
    address public pair;
    /// @notice Tokens each NFT claims after the launch: the supply that is not in the pool, split equally. Set at
    ///         creation and never changed, so it reads the same before and after the launch.
    uint256 public tokensPerNFT;
    /// @notice Whether an NFT has claimed.
    mapping(uint256 tokenId => bool) public claimed;

    /// @dev NFTs held by each account, and each NFT's position in its holder's list.
    mapping(address account => uint256[]) internal _owned;
    mapping(uint256 tokenId => uint256) internal _ownedIndex;

    event Minted(address indexed to, uint256 firstId, uint256 qty, uint256 paid);
    /// @param raised BNB that went into the pool: the raise less the launch fee.
    event Launched(
        address indexed token, address indexed pair, uint256 raised, uint256 poolTokens, uint256 tokensPerNFT
    );
    event LaunchFeePaid(address indexed token, address indexed vault, uint256 amount);
    event Claimed(uint256 indexed tokenId, address indexed to, uint256 amount);
    event Refunded(uint256 indexed tokenId, address indexed to, uint256 amount);

    error InvalidConfig();
    error SaleClosed();
    error ZeroQuantity();
    error MintTooLarge();
    error WrongPayment(uint256 sent, uint256 required);
    error LaunchInProgress();
    error NoLiquidityMinted();
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

    /// @notice Called once by the factory in the transaction that deploys the clone.
    function initialize(
        address pancakeFactory_,
        address wbnb_,
        address creator_,
        address vault_,
        uint16 launchFeeBps_,
        CallZPancakeConfig calldata c
    ) external initializer {
        if (pancakeFactory_ == address(0) || wbnb_ == address(0) || creator_ == address(0)) revert InvalidConfig();
        if (launchFeeBps_ > MAX_LAUNCH_FEE_BPS || (launchFeeBps_ != 0 && vault_ == address(0))) revert InvalidConfig();
        if (bytes(c.name).length == 0 || bytes(c.name).length > MAX_NAME_BYTES) revert InvalidConfig();
        if (bytes(c.symbol).length == 0 || bytes(c.symbol).length > MAX_SYMBOL_BYTES) revert InvalidConfig();
        if (bytes(c.meta).length > MAX_META_BYTES) revert InvalidConfig();
        // The cap is a whole number of NFTs, so the raise can land on it exactly.
        if (c.nftPrice == 0 || c.cap == 0 || c.cap > MAX_CAP || c.cap % c.nftPrice != 0) revert InvalidConfig();
        uint256 count = c.cap / c.nftPrice;
        if (count > MAX_NFTS) revert InvalidConfig();
        if (c.poolShareBps < MIN_POOL_SHARE_BPS || c.poolShareBps > MAX_POOL_SHARE_BPS) revert InvalidConfig();
        if (c.saleDuration < MIN_SALE_DURATION || c.saleDuration > MAX_SALE_DURATION) revert InvalidConfig();

        pancakeFactory = pancakeFactory_;
        wbnb = wbnb_;
        creator = creator_;
        vault = vault_;
        launchFeeBps = launchFeeBps_;
        nftPrice = c.nftPrice;
        cap = c.cap;
        maxNFTs = count;
        saleDeadline = block.timestamp + c.saleDuration;
        poolShareBps = c.poolShareBps;
        // The NFTs share what the pool does not take. The launch uses this same value.
        tokensPerNFT = (TOTAL_SUPPLY - (TOTAL_SUPPLY * c.poolShareBps) / 10_000) / count;
        tokenName = c.name;
        tokenSymbol = c.symbol;
        meta = c.meta;
    }

    /// @notice The raise target: the same value as `cap`.
    function targetRaise() external view returns (uint256) {
        return cap;
    }

    /// @notice Tokens that go into the pool: the pool share of the supply plus whatever the equal split between
    ///         the NFTs leaves over, so every token has an owner.
    function poolTokens() public view returns (uint256) {
        return TOTAL_SUPPLY - tokensPerNFT * maxNFTs;
    }

    /// @notice Implementation version.
    function version() external pure returns (string memory) {
        return "2.0.0";
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
        // `_mint`, not `_safeMint`: no callback into the buyer while the sale state is changing.
        for (uint256 id = first; id <= last; ++id) {
            _mint(msg.sender, id);
        }
        emit Minted(msg.sender, first, quantity, paid);

        // The launch moves exactly `raised`, so the buyer's change stays here until it is returned below.
        if (last == maxNFTs) _launch();

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

    /// @dev Runs inside the mint that reaches the cap: deploys the token, pays the launch fee to the vault, seeds
    ///      the token's PancakeSwap V2 pair with the rest of the raise and the pool share of the supply, and burns
    ///      the LP.
    ///
    ///      The liquidity is added by sending both assets to the pair and calling `mint` on it, not through the
    ///      router. The token address is predictable, so anyone can create the pair first and send WBNB to it.
    ///      The pair counts what it received on top of its recorded reserves, so `mint` works in every state such
    ///      a pair can be in, including WBNB already in its reserves with no tokens, where the router's
    ///      `addLiquidityETH` reverts. WBNB sent to the pair beforehand simply becomes part of the pool.
    ///
    ///      `launching` closes `mint` and `refund` while this runs, and `claim` stays closed until `launched` is
    ///      set at the end. If any step fails, the whole mint reverts and the raise stays refundable.
    function _launch() private {
        uint256 amount = raised;
        uint256 share = tokensPerNFT;
        // Everything the NFTs do not claim goes into the pool, so no token is left without an owner.
        uint256 poolAmount = TOTAL_SUPPLY - share * maxNFTs;
        address factory_ = pancakeFactory;
        address wbnb_ = wbnb;

        launching = true;
        // The whole supply is minted to this contract.
        address token_ = address(new CallZToken(tokenName, tokenSymbol));
        address pair_ = IPancakeFactory(factory_).getPair(token_, wbnb_);
        if (pair_ == address(0)) pair_ = IPancakeFactory(factory_).createPair(token_, wbnb_);

        uint256 fee = (amount * launchFeeBps) / 10_000;
        if (fee != 0) {
            amount -= fee;
            address vault_ = vault;
            ICallZFeeVault(vault_).deposit{value: fee}(token_);
            emit LaunchFeePaid(token_, vault_, fee);
        }

        IWBNB(wbnb_).deposit{value: amount}();
        wbnb_.safeTransfer(pair_, amount);
        token_.safeTransfer(pair_, poolAmount);
        // LP to the dead address: the liquidity can never be removed.
        uint256 liquidity = IPancakePair(pair_).mint(DEAD);
        if (liquidity == 0) revert NoLiquidityMinted();
        launching = false;

        launched = true;
        token = token_;
        pair = pair_;
        emit Launched(token_, pair_, amount, poolAmount, share);
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
                        '. Claims an equal share of the supply that is not in the PancakeSwap pool, once, and stays with its holder.",',
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
