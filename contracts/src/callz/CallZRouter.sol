// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @notice The part of the PancakeSwap V2 router that CallZRouter uses.
interface IPancakeRouter {
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @notice The part of CallZVault that fee payers use.
interface ICallZVault {
    function deposit(address token) external payable;
}

/// @title CallZRouter
/// @notice Buys and sells a token through PancakeSwap V2 and takes the CallZ trading fee, in BNB, on the way.
///
///         A buy pays the fee out of the BNB sent and swaps the rest; the tokens go straight from the pool to the
///         buyer. A sell swaps the tokens for BNB, takes the fee out of that BNB and sends the rest to the seller.
///         The fee goes to the CallZ vault in the same transaction, booked under the token traded.
///
///         The router keeps nothing between transactions: no balances, no allowances beyond the swap it is making.
///
/// @dev The guardian can change the fee, up to `MAX_FEE_BPS`, and nothing else. The vault and the PancakeSwap
///      router are fixed at deployment.
contract CallZRouter is ReentrancyGuard {
    using SafeTransferLib for address;

    /// @notice The highest fee the guardian can set: 2%.
    uint16 public constant MAX_FEE_BPS = 200;
    uint256 internal constant BPS = 10_000;

    address public immutable pancakeRouter;
    address public immutable wbnb;
    address public immutable vault;

    address public guardian;
    address public pendingGuardian;
    /// @notice The fee on the BNB side of every trade, in bps.
    uint16 public feeBps;

    event Bought(address indexed token, address indexed trader, uint256 bnbIn, uint256 fee, uint256 tokensOut);
    event Sold(address indexed token, address indexed trader, uint256 tokensIn, uint256 bnbOut, uint256 fee);
    event FeeSet(uint16 feeBps);
    event GuardianTransferStarted(address indexed pendingGuardian);
    event GuardianChanged(address indexed guardian);

    error ZeroAddress();
    error NotGuardian();
    error FeeTooHigh();
    error InvalidPath();
    error ZeroAmount();
    error InsufficientOutput(uint256 out, uint256 minimum);
    error UnexpectedBnb();
    error BnbTransferFailed();

    constructor(address pancakeRouter_, address wbnb_, address vault_, address guardian_, uint16 feeBps_) {
        if (pancakeRouter_ == address(0) || wbnb_ == address(0) || vault_ == address(0) || guardian_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        pancakeRouter = pancakeRouter_;
        wbnb = wbnb_;
        vault = vault_;
        guardian = guardian_;
        feeBps = feeBps_;
        emit GuardianChanged(guardian_);
        emit FeeSet(feeBps_);
    }

    /// @notice Buy `token` with the BNB sent.
    /// @param path       The PancakeSwap route: WBNB first, `token` last.
    /// @param minOut     The least tokens the buyer accepts, after the token's own tax.
    /// @return tokensOut Tokens that reached the buyer.
    function buy(address token, address[] calldata path, uint256 minOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (msg.value == 0) revert ZeroAmount();
        if (path.length < 2 || path[0] != wbnb || path[path.length - 1] != token) revert InvalidPath();

        uint256 fee = (msg.value * feeBps) / BPS;
        if (fee != 0) ICallZVault(vault).deposit{value: fee}(token);

        uint256 before = token.balanceOf(msg.sender);
        // PancakeSwap checks `minOut` against what actually reached the buyer.
        IPancakeRouter(pancakeRouter).swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value - fee}(
            minOut, path, msg.sender, deadline
        );
        tokensOut = token.balanceOf(msg.sender) - before;
        emit Bought(token, msg.sender, msg.value, fee, tokensOut);
    }

    /// @notice Sell `amountIn` of `token` for BNB. Approve this router for `amountIn` first.
    /// @param path       The PancakeSwap route: `token` first, WBNB last.
    /// @param minBnbOut  The least BNB the seller accepts, after the CallZ fee.
    /// @return bnbOut    BNB sent to the seller.
    function sell(address token, uint256 amountIn, address[] calldata path, uint256 minBnbOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 bnbOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (path.length < 2 || path[0] != token || path[path.length - 1] != wbnb) revert InvalidPath();

        // Sell what actually arrived: a token may take a tax on the way in.
        uint256 held = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 received = token.balanceOf(address(this)) - held;
        if (received == 0) revert ZeroAmount();

        uint256 before = address(this).balance;
        token.safeApproveWithRetry(pancakeRouter, received);
        IPancakeRouter(pancakeRouter).swapExactTokensForETHSupportingFeeOnTransferTokens(
            received, 0, path, address(this), deadline
        );
        uint256 proceeds = address(this).balance - before;

        uint256 fee = (proceeds * feeBps) / BPS;
        bnbOut = proceeds - fee;
        if (bnbOut < minBnbOut) revert InsufficientOutput(bnbOut, minBnbOut);
        if (fee != 0) ICallZVault(vault).deposit{value: fee}(token);
        emit Sold(token, msg.sender, amountIn, bnbOut, fee);

        (bool ok,) = msg.sender.call{value: bnbOut}("");
        if (!ok) revert BnbTransferFailed();
    }

    /// @notice Set the trading fee. At most 2%.
    function setFee(uint16 feeBps_) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    /// @notice Hand the guardian role over in two steps.
    function transferGuardian(address next) external {
        if (msg.sender != guardian) revert NotGuardian();
        pendingGuardian = next;
        emit GuardianTransferStarted(next);
    }

    function acceptGuardian() external {
        if (msg.sender != pendingGuardian) revert NotGuardian();
        guardian = msg.sender;
        pendingGuardian = address(0);
        emit GuardianChanged(msg.sender);
    }

    /// @dev BNB only ever arrives from PancakeSwap, as the proceeds of a sell.
    receive() external payable {
        if (msg.sender != pancakeRouter) revert UnexpectedBnb();
    }
}
