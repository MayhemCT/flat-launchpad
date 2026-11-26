// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";

import {IPortal} from "src/flap/IPortal.sol";
import {LaunchVaultAddresses} from "src/flap/LaunchVaultAddresses.sol";
import {RaidPassLauncherFactory} from "src/raidpass/RaidPassLauncherFactory.sol";
import {RaidPassLauncher, RaidPassConfig} from "src/raidpass/RaidPassLauncher.sol";

/// @notice Creates one RaidPass Launcher through the Portal, the same call a launch page makes.
///
///   Environment:
///     FACTORY        RaidPassLauncherFactory address
///     TOKEN_NAME     token name
///     TOKEN_SYMBOL   token symbol
///     TOKEN_META     metadata CID (may be empty)
///     MINT_PRICE     wei per pass
///     MAX_PASSES     passes in the mint
///     SALE_DURATION  mint window in seconds
///
///   forge script script/CreateLauncher.s.sol --rpc-url $BSC_TESTNET_RPC_URL --account <keystore-name> --broadcast
contract CreateLauncher is Script {
    /// @dev The FlapDirectTaxToken implementation the Portal clones (same address on both chains).
    address internal constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;

    function run() external returns (address launcher) {
        RaidPassLauncherFactory factory = RaidPassLauncherFactory(vm.envAddress("FACTORY"));
        IPortal portal = IPortal(LaunchVaultAddresses.hub());

        RaidPassConfig memory c;
        c.name = vm.envString("TOKEN_NAME");
        c.symbol = vm.envString("TOKEN_SYMBOL");
        c.meta = vm.envOr("TOKEN_META", string(""));
        c.mintPrice = vm.envUint("MINT_PRICE");
        c.maxPasses = vm.envUint("MAX_PASSES");
        c.saleDuration = vm.envUint("SALE_DURATION");
        c.salt = _mineSalt(address(portal), keccak256(abi.encode(address(factory), c.name, c.symbol, block.number)));

        uint256 fee = portal.SALT_LOCK_FEE();
        vm.startBroadcast();
        launcher = portal.newLauncher{value: fee}(address(factory), abi.encode(c));
        vm.stopBroadcast();

        console.log("launcher     ", launcher);
        console.log("token (soon) ", ClonesUpgradeable.predictDeterministicAddress(TOKEN_IMPL, c.salt, address(portal)));
        console.log("target raise ", RaidPassLauncher(launcher).targetRaise());
        console.log("sale deadline", RaidPassLauncher(launcher).saleDeadline());
    }

    /// @dev The Portal only locks a salt whose token address ends in 0x7777: about 65,000 tries.
    function _mineSalt(address portal, bytes32 seed) internal pure returns (bytes32 salt) {
        for (uint256 i;; ++i) {
            salt = keccak256(abi.encode(seed, i));
            if (uint16(uint160(ClonesUpgradeable.predictDeterministicAddress(TOKEN_IMPL, salt, portal))) == 0x7777) {
                return salt;
            }
        }
    }
}
