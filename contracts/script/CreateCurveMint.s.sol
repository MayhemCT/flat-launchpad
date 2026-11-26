// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";

import {RaidPassCurveFactory} from "src/raidpass/RaidPassCurveFactory.sol";
import {RaidPassCurve, RaidPassCurveConfig, IBondingCurvePortal} from "src/raidpass/RaidPassCurve.sol";

/// @notice Creates one RaidPass mint on BNB Chain. Costs the Portal's salt-lock fee (0.01 BNB) plus gas.
///
///   Environment:
///     CURVE_FACTORY  RaidPassCurveFactory address
///     TOKEN_NAME     token name
///     TOKEN_SYMBOL   token symbol
///     TOKEN_META     metadata CID from Flap's upload API (optional)
///     NFT_PRICE      wei per NFT
///     CAP            wei to raise: at most 10 BNB and an exact multiple of NFT_PRICE
///     SALE_DURATION  mint window in seconds (600 to 2592000)
///     BUY_TAX_BPS    buy tax, bps, 100 to 1000 (default 300)
///     SELL_TAX_BPS   sell tax, bps, 100 to 1000 (default 500)
///
///   forge script script/CreateCurveMint.s.sol --rpc-url https://bsc-rpc.publicnode.com --account raidpass --broadcast --legacy
contract CreateCurveMint is Script {
    /// @dev Flap's Tax Token V3 implementation on BNB Chain: the Portal clones it, and the clone's address must
    ///      end in 0x7777.
    address internal constant TAX_TOKEN_V3_IMPL = 0x024f18294970B5c76c0691b87f138A0317156422;

    function run() external returns (address mint) {
        require(block.chainid == 56, "RaidPassCurve runs on BNB Chain");
        RaidPassCurveFactory factory = RaidPassCurveFactory(vm.envAddress("CURVE_FACTORY"));
        address portal = factory.portal();

        RaidPassCurveConfig memory c;
        c.name = vm.envString("TOKEN_NAME");
        c.symbol = vm.envString("TOKEN_SYMBOL");
        c.meta = vm.envOr("TOKEN_META", string(""));
        c.nftPrice = vm.envUint("NFT_PRICE");
        c.cap = vm.envUint("CAP");
        c.saleDuration = vm.envUint("SALE_DURATION");
        c.buyTaxBps = uint16(vm.envOr("BUY_TAX_BPS", uint256(300)));
        c.sellTaxBps = uint16(vm.envOr("SELL_TAX_BPS", uint256(500)));
        c.salt = _mineSalt(portal, keccak256(abi.encode(address(factory), c.name, c.symbol, block.number)));

        uint256 fee = IBondingCurvePortal(portal).SALT_LOCK_FEE();
        vm.startBroadcast();
        mint = factory.create{value: fee}(c);
        vm.stopBroadcast();

        console.log("mint (send BNB to mint() here)", mint);
        console.log("token address after launch    ", ClonesUpgradeable.predictDeterministicAddress(TAX_TOKEN_V3_IMPL, c.salt, portal));
        console.log("price per NFT, wei            ", c.nftPrice);
        console.log("NFTs for sale                 ", RaidPassCurve(payable(mint)).maxNFTs());
        console.log("cap (total to sell out), wei  ", c.cap);
        console.log("sale deadline, unix           ", RaidPassCurve(payable(mint)).saleDeadline());
    }

    /// @dev About 65,000 tries.
    function _mineSalt(address portal, bytes32 seed) internal pure returns (bytes32 salt) {
        for (uint256 i;; ++i) {
            salt = keccak256(abi.encode(seed, i));
            if (uint16(uint160(ClonesUpgradeable.predictDeterministicAddress(TAX_TOKEN_V3_IMPL, salt, portal))) == 0x7777) {
                return salt;
            }
        }
    }
}
