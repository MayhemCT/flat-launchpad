// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CallZPancakeFactory} from "src/callz/CallZPancakeFactory.sol";

/// @notice Deploys the CallZPancake factory on BNB Chain, pointed at PancakeSwap V2 and WBNB.
///
///         Deployed with CREATE2 through the deterministic deployer, so the address depends only on the bytecode,
///         the constructor arguments and the salt below, whoever sends the transaction. Running it again after it
///         is deployed reverts.
///
///   forge script script/DeployCallZPancake.s.sol --rpc-url https://bsc-rpc.publicnode.com --account raidpass --broadcast --legacy
contract DeployCallZPancake is Script {
    /// @dev PancakeSwap V2 factory on BNB Chain.
    address internal constant PANCAKE_V2_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    /// @dev Wrapped BNB on BNB Chain.
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    bytes32 internal constant SALT = keccak256("CallZPancakeFactory.v1");

    function run() external returns (CallZPancakeFactory factory) {
        require(block.chainid == 56, "CallZPancake deploys on BNB Chain");

        vm.startBroadcast();
        factory = new CallZPancakeFactory{salt: SALT}(PANCAKE_V2_FACTORY, WBNB);
        vm.stopBroadcast();

        console.log("CallZPancakeFactory", address(factory));
        console.log("implementation     ", factory.implementation());
        console.log("pancakeFactory     ", factory.pancakeFactory());
        console.log("wbnb               ", factory.wbnb());
    }
}
