// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LibClone} from "solady/utils/LibClone.sol";
import {CallZPancake, CallZPancakeConfig} from "./CallZPancake.sol";

/// @title CallZPancakeFactory
/// @notice Deploys one `CallZPancake` mint per launch, as an immutable minimal clone.
///
///         Anyone can create a mint. Each mint is created with the launch fee in force at that moment: a share
///         of its raise, at most 10%, paid to the CallZ vault when it launches. The guardian can change the fee
///         for mints created afterwards and nothing else: the factory cannot touch a mint after creating it.
contract CallZPancakeFactory {
    /// @notice The PancakeSwap V2 factory every mint launches into.
    address public immutable pancakeFactory;
    /// @notice Wrapped BNB: the quote token of every pool.
    address public immutable wbnb;
    /// @notice The CallZPancake every mint is a clone of.
    address public immutable implementation;
    /// @notice The CallZ vault every mint pays its launch fee to.
    address public immutable vault;
    /// @notice The highest launch fee the guardian can set: 10% of the raise.
    uint16 public constant MAX_LAUNCH_FEE_BPS = 1000;

    address public guardian;
    address public pendingGuardian;
    /// @notice Share of the raise a mint created now pays at launch, in bps.
    uint16 public launchFeeBps;

    /// @notice Every mint this factory created, oldest first.
    address[] public mints;

    event CallZPancakeCreated(
        address indexed mint, address indexed creator, string name, string symbol, uint256 nftPrice, uint256 cap
    );

    event LaunchFeeSet(uint16 launchFeeBps);
    event GuardianTransferStarted(address indexed pendingGuardian);
    event GuardianChanged(address indexed guardian);

    error ZeroAddress();
    error NotGuardian();
    error FeeTooHigh();

    constructor(address pancakeFactory_, address wbnb_, address vault_, address guardian_, uint16 launchFeeBps_) {
        if (pancakeFactory_ == address(0) || wbnb_ == address(0) || vault_ == address(0) || guardian_ == address(0)) {
            revert ZeroAddress();
        }
        if (launchFeeBps_ > MAX_LAUNCH_FEE_BPS) revert FeeTooHigh();
        pancakeFactory = pancakeFactory_;
        wbnb = wbnb_;
        vault = vault_;
        guardian = guardian_;
        launchFeeBps = launchFeeBps_;
        implementation = address(new CallZPancake());
        emit GuardianChanged(guardian_);
        emit LaunchFeeSet(launchFeeBps_);
    }

    /// @notice Set the launch fee of mints created from now on. At most 10%. Existing mints keep theirs.
    function setLaunchFee(uint16 launchFeeBps_) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (launchFeeBps_ > MAX_LAUNCH_FEE_BPS) revert FeeTooHigh();
        launchFeeBps = launchFeeBps_;
        emit LaunchFeeSet(launchFeeBps_);
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

    /// @notice Create a mint. `salt` is any value the caller has not used before.
    function create(CallZPancakeConfig calldata config, bytes32 salt) external returns (address mint) {
        // The clone's address depends on the caller, so nobody else can take it first.
        mint = LibClone.cloneDeterministic(implementation, keccak256(abi.encode(msg.sender, salt)));
        CallZPancake(mint).initialize(pancakeFactory, wbnb, msg.sender, vault, launchFeeBps, config);
        mints.push(mint);
        emit CallZPancakeCreated(mint, msg.sender, config.name, config.symbol, config.nftPrice, config.cap);
    }

    /// @notice The address a mint created by `creator` with `salt` will have.
    function predict(address creator, bytes32 salt) external view returns (address) {
        return LibClone.predictDeterministicAddress(implementation, keccak256(abi.encode(creator, salt)), address(this));
    }

    function mintCount() external view returns (uint256) {
        return mints.length;
    }
}
