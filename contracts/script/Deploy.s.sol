// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {RaidPassLauncherFactory} from "src/raidpass/RaidPassLauncherFactory.sol";

/// @notice Deploys the RaidPass Launcher Factory. The factory has no constructor arguments: it reads the Portal
///         and the Guardian from the chain registry, so it only deploys on BNB Chain (56) and BNB Testnet (97).
///
///   forge script script/Deploy.s.sol --rpc-url $BSC_TESTNET_RPC_URL --account <keystore-name> --broadcast
contract Deploy is Script {
    function run() external returns (RaidPassLauncherFactory factory) {
        require(block.chainid == 56 || block.chainid == 97, "RaidPass deploys on BNB Chain or BNB Testnet");

        vm.startBroadcast();
        factory = new RaidPassLauncherFactory();
        vm.stopBroadcast();

        console.log("chain id            ", block.chainid);
        console.log("RaidPassLauncherFactory", address(factory));
        console.log("beacon              ", factory.beacon());
        console.log("implementation      ", factory.beaconImplementation());
        console.log("hub (Portal)        ", factory.hub());
        console.log("guardian            ", factory.guardian());
    }
}
