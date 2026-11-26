// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RaidPassFork} from "test/raidpass/RaidPass.fork.t.sol";
import {ForkAddresses} from "test/ForkAddresses.sol";

/// @notice RaidPass against the live Portal on BNB Chain. Needs BSC_RPC_URL.
contract RaidPassBSCForkTest is RaidPassFork {
    function _addrs() internal pure override returns (ForkAddresses.Addrs memory) {
        return ForkAddresses.bsc();
    }
}
