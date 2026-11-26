// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LibClone} from "solady/utils/LibClone.sol";
import {RaidPassCurve, RaidPassCurveConfig} from "./RaidPassCurve.sol";

/// @title RaidPassCurveFactory
/// @notice Deploys one `RaidPassCurve` mint per launch, as an immutable minimal clone.
///
///         Anyone can create a mint: Flap's bonding curve Portal is permissionless. The factory has no owner,
///         takes no fee and cannot touch a mint after creating it.
contract RaidPassCurveFactory {
    /// @notice Flap's bonding curve Portal on this chain.
    address public immutable portal;
    /// @notice The RaidPassCurve every mint is a clone of.
    address public immutable implementation;

    /// @notice Every mint this factory created, oldest first.
    address[] public mints;

    event RaidPassCurveCreated(
        address indexed mint, address indexed creator, bytes32 launchSalt, uint256 nftPrice, uint256 cap
    );

    error ZeroAddress();

    constructor(address portal_) {
        if (portal_ == address(0)) revert ZeroAddress();
        portal = portal_;
        implementation = address(new RaidPassCurve());
    }

    /// @notice Create a mint. Send exactly the Portal's `SALT_LOCK_FEE()`; the mint uses it to reserve the token
    ///         address for itself.
    function create(RaidPassCurveConfig calldata config) external payable returns (address mint) {
        // The clone's address depends on the caller, so nobody else can take it first.
        mint = LibClone.cloneDeterministic(implementation, keccak256(abi.encode(msg.sender, config.salt)));
        RaidPassCurve(payable(mint)).initialize{value: msg.value}(portal, msg.sender, config);
        mints.push(mint);
        emit RaidPassCurveCreated(mint, msg.sender, config.salt, config.nftPrice, config.cap);
    }

    /// @notice The address a mint created by `creator` with `salt` will have.
    function predict(address creator, bytes32 salt) external view returns (address) {
        return LibClone.predictDeterministicAddress(implementation, keccak256(abi.encode(creator, salt)), address(this));
    }

    function mintCount() external view returns (uint256) {
        return mints.length;
    }
}
