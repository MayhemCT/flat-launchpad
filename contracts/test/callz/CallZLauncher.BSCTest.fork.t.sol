// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CallZLauncherFork} from "test/callz/CallZLauncher.fork.t.sol";
import {ForkAddresses} from "test/ForkAddresses.sol";

/// @notice CallZ against the live Portal on BNB Chain Testnet. Needs BSC_TESTNET_RPC_URL.
contract CallZLauncherBSCTestForkTest is CallZLauncherFork {
    function _addrs() internal pure override returns (ForkAddresses.Addrs memory) {
        return ForkAddresses.bscTest();
    }
}
