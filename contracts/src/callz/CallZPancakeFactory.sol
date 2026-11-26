// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LibClone} from "solady/utils/LibClone.sol";
import {CallZPancake, CallZPancakeConfig} from "./CallZPancake.sol";

/// @title CallZPancakeFactory
/// @notice Deploys one `CallZPancake` mint per launch, as an immutable minimal clone.
///
///         Anyone can create a mint. The factory has no owner, takes no fee and cannot touch a mint after
///         creating it.
contract CallZPancakeFactory {
    /// @notice The PancakeSwap V2 factory every mint launches into.
    address public immutable pancakeFactory;
    /// @notice Wrapped BNB: the quote token of every pool.
    address public immutable wbnb;
    /// @notice The CallZPancake every mint is a clone of.
    address public immutable implementation;

    /// @notice Every mint this factory created, oldest first.
    address[] public mints;

    event CallZPancakeCreated(
        address indexed mint, address indexed creator, string name, string symbol, uint256 nftPrice, uint256 cap
    );

    error ZeroAddress();

    constructor(address pancakeFactory_, address wbnb_) {
        if (pancakeFactory_ == address(0) || wbnb_ == address(0)) revert ZeroAddress();
        pancakeFactory = pancakeFactory_;
        wbnb = wbnb_;
        implementation = address(new CallZPancake());
    }

    /// @notice Create a mint. `salt` is any value the caller has not used before.
    function create(CallZPancakeConfig calldata config, bytes32 salt) external returns (address mint) {
        // The clone's address depends on the caller, so nobody else can take it first.
        mint = LibClone.cloneDeterministic(implementation, keccak256(abi.encode(msg.sender, salt)));
        CallZPancake(mint).initialize(pancakeFactory, wbnb, msg.sender, config);
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
