// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CallZLauncherFactory} from "src/callz/CallZLauncherFactory.sol";

/// @notice Deploys the CallZ Launcher Factory. The factory has no constructor arguments: it reads the Portal
///         and the Guardian from the chain registry, so it only deploys on BNB Chain (56) and BNB Testnet (97).
///
///         It is deployed with CREATE2 through the deterministic deployer, so its address depends only on the
///         bytecode and the salt below: the same on both chains, whoever sends the transaction. Running this
///         again after it is deployed reverts.
///
///   forge script script/Deploy.s.sol --rpc-url $BSC_TESTNET_RPC_URL --account <keystore-name> --broadcast
contract Deploy is Script {
    bytes32 internal constant SALT = keccak256("CallZLauncherFactory.v1");

    function run() external returns (CallZLauncherFactory factory) {
        require(block.chainid == 56 || block.chainid == 97, "CallZ deploys on BNB Chain or BNB Testnet");

        vm.startBroadcast();
        factory = new CallZLauncherFactory{salt: SALT}();
        vm.stopBroadcast();

        console.log("chain id            ", block.chainid);
        console.log("CallZLauncherFactory", address(factory));
        console.log("beacon              ", factory.beacon());
        console.log("implementation      ", factory.beaconImplementation());
        console.log("hub (Portal)        ", factory.hub());
        console.log("guardian            ", factory.guardian());
    }
}
