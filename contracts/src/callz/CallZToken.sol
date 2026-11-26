// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/token/ERC20/ERC20.sol";

/// @dev Supply of every CallZ token: 1,000,000,000 tokens with 18 decimals. Shared with the launcher, which
///      splits exactly this amount between the pool and the NFTs.
uint256 constant CALLZ_TOTAL_SUPPLY = 1_000_000_000e18;

/// @title CallZToken
/// @notice The token a CallZ mint launches: a plain ERC-20 with a fixed supply.
///
///         The whole supply is minted once, in the constructor, to the contract that deploys the token (the
///         launcher). After that the supply never changes: there is no mint or burn function, no owner, no tax,
///         no transfer hook, no pause and no blacklist. A transfer moves exactly the amount asked.
contract CallZToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        _mint(msg.sender, CALLZ_TOTAL_SUPPLY);
    }
}
