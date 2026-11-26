// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CallZCurveFactory} from "src/callz/CallZCurveFactory.sol";

/// @notice Deploys the CallZCurve factory on BNB Chain, pointed at Flap's bonding curve Portal.
///
///         Deployed with CREATE2 through the deterministic deployer, so the address depends only on the bytecode
///         and the salt below, whoever sends the transaction. Running it again after it is deployed reverts.
///
///   forge script script/DeployCurve.s.sol --rpc-url https://bsc-rpc.publicnode.com --account callz --broadcast --legacy
contract DeployCurve is Script {
    /// @dev Flap's bonding curve Portal on BNB Chain (docs.flap.sh, Deployed Contract Addresses).
    address internal constant BONDING_CURVE_PORTAL = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;
    bytes32 internal constant SALT = keccak256("CallZCurveFactory.v1");

    function run() external returns (CallZCurveFactory factory) {
        require(block.chainid == 56, "CallZCurve deploys on BNB Chain");

        vm.startBroadcast();
        factory = new CallZCurveFactory{salt: SALT}(BONDING_CURVE_PORTAL);
        vm.stopBroadcast();

        console.log("CallZCurveFactory", address(factory));
        console.log("implementation      ", factory.implementation());
        console.log("portal              ", factory.portal());
    }
}
