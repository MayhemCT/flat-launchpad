// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CallZPancakeFactory} from "src/callz/CallZPancakeFactory.sol";
import {CallZRouter} from "src/callz/CallZRouter.sol";
import {CallZVault} from "src/callz/CallZVault.sol";

/// @notice Deploys CallZ's three mainnet contracts on BNB Chain: the fee vault, the fee-taking trade router and the
///         mint factory that launches into PancakeSwap V2.
///
///         Each is deployed with CREATE2 through the deterministic deployer, so its address depends only on its
///         bytecode, its constructor arguments and its salt, whoever sends the transaction. The roles are
///         constructor arguments, not the sender: whoever deploys, the team wallet below is the guardian. Running
///         it again after everything is deployed reverts.
///
///   forge script script/DeployCallZPancake.s.sol --rpc-url https://bsc-rpc.publicnode.com --account callz --broadcast --legacy
contract DeployCallZPancake is Script {
    /// @dev PancakeSwap V2 on BNB Chain.
    address internal constant PANCAKE_V2_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address internal constant PANCAKE_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    /// @dev Wrapped BNB on BNB Chain.
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    /// @dev The team wallet: guardian of all three contracts, receiver of the platform share, and the first
    ///      attester of callouts. The guardian can hand each role to another address later.
    address internal constant TEAM = 0x2FcB91295c790d15d5f21eD9D95C6a89E0683C58;
    /// @dev 2% of the BNB side of every trade through the router.
    uint16 internal constant TRADE_FEE_BPS = 200;
    /// @dev 10% of every raise that launches.
    uint16 internal constant LAUNCH_FEE_BPS = 1000;

    bytes32 internal constant VAULT_SALT = keccak256("CallZVault.v1");
    bytes32 internal constant ROUTER_SALT = keccak256("CallZRouter.v1");
    bytes32 internal constant FACTORY_SALT = keccak256("CallZPancakeFactory.v2");

    function run() external returns (CallZVault vault, CallZRouter router, CallZPancakeFactory factory) {
        require(block.chainid == 56, "CallZ deploys on BNB Chain");

        vm.startBroadcast();
        vault = new CallZVault{salt: VAULT_SALT}(TEAM, TEAM, TEAM);
        router = new CallZRouter{salt: ROUTER_SALT}(PANCAKE_V2_ROUTER, WBNB, address(vault), TEAM, TRADE_FEE_BPS);
        factory = new CallZPancakeFactory{salt: FACTORY_SALT}(
            PANCAKE_V2_FACTORY, WBNB, address(vault), TEAM, LAUNCH_FEE_BPS
        );
        vm.stopBroadcast();

        console.log("CallZVault         ", address(vault));
        console.log("CallZRouter        ", address(router));
        console.log("CallZPancakeFactory", address(factory));
        console.log("implementation     ", factory.implementation());
    }
}
