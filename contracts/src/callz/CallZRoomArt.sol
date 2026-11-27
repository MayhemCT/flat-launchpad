// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

/// @title CallZRoomArt
/// @notice Writes the metadata of a CallZ room pass: its name, its picture and what it cost.
///
///         It keeps nothing and nobody controls it: every function is a pure function of what the room passes
///         in. It is its own contract only so that the room stays under the contract size limit.
contract CallZRoomArt {
    /// @notice A BNB amount as text: 250000000000000000 is "0.25 BNB".
    function priceText(uint256 weiAmount) public pure returns (string memory) {
        return string.concat(_decimal(weiAmount), " BNB");
    }

    /// @dev A wei amount in whole coins, with no trailing zeros.
    function _decimal(uint256 weiAmount) private pure returns (string memory) {
        string memory whole = LibString.toString(weiAmount / 1 ether);
        uint256 fraction = weiAmount % 1 ether;
        if (fraction == 0) return whole;
        // "1" followed by the fraction's 18 digits, so its leading zeros are kept.
        string memory digits = LibString.toString(1 ether + fraction);
        uint256 end = 19;
        while (bytes(digits)[end - 1] == "0") --end;
        return string.concat(whole, ".", LibString.slice(digits, 1, end));
    }

    /// @notice The metadata of one pass, as a `data:` address.
    /// @param tokenName   The room's token name.
    /// @param tokenSymbol The room's token symbol.
    /// @param image       Address of the room's picture. When empty, a pass is drawn with the price on it.
    /// @param tokenId     The pass's number.
    /// @param seatPrice   What every pass of the room cost, in wei.
    /// @param seats       Seats in the room.
    /// @param status      0: seated, the room has not launched. 1: launched and not claimed. 2: claimed.
    function passURI(
        string calldata tokenName,
        string calldata tokenSymbol,
        string calldata image,
        uint256 tokenId,
        uint256 seatPrice,
        uint256 seats,
        uint8 status
    ) external pure returns (string memory) {
        string memory id = LibString.toString(tokenId);
        string memory price = priceText(seatPrice);
        string memory picture =
            bytes(image).length != 0 ? LibString.escapeJSON(image, false) : _drawn(tokenSymbol, id, price);
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(
                bytes(string.concat(_head(tokenName, id, price), _attributes(price, seats, status), picture, '"}'))
            )
        );
    }

    /// @dev The name and the description: which room, which pass, and what it cost.
    function _head(string calldata tokenName, string memory id, string memory price)
        private
        pure
        returns (string memory)
    {
        string memory room = LibString.escapeJSON(tokenName, false);
        return string.concat(
            '{"name":"',
            room,
            " CallZ Pass #",
            id,
            '","description":"A seat in the CallZ room of ',
            room,
            ", bought for ",
            price,
            '. It claims an equal share of the supply that is not in the PancakeSwap pool, once, and cannot be transferred.",'
        );
    }

    /// @dev The attributes, up to the opening quote of the picture.
    function _attributes(string memory price, uint256 seats, uint8 status) private pure returns (string memory) {
        return string.concat(
            '"attributes":[{"trait_type":"Status","value":"',
            status == 0 ? "Seated" : status == 1 ? "Unclaimed" : "Claimed",
            '"},{"trait_type":"Price","value":"',
            price,
            '"},{"trait_type":"Seats","display_type":"number","value":',
            LibString.toString(seats),
            '}],"image":"'
        );
    }

    /// @dev The pass drawn for a room without a picture: the CallZ mark, the pass's number and its price.
    function _drawn(string calldata tokenSymbol, string memory id, string memory price)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            "data:image/svg+xml;base64,",
            Base64.encode(
                bytes(
                    string.concat(
                        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#0b0e11"/>',
                        '<path d="M200 70 310 180 200 290 90 180Z" fill="none" stroke="#f0b90b" stroke-width="16"/>',
                        '<path d="M200 130 250 180 200 230 150 180Z" fill="#f0b90b"/>',
                        '<text x="200" y="336" fill="#eaecef" font-family="monospace" font-size="20" text-anchor="middle">',
                        LibString.escapeHTML(tokenSymbol),
                        " CallZ Pass #",
                        id,
                        '</text><text x="200" y="368" fill="#f0b90b" font-family="monospace" font-size="18" text-anchor="middle">',
                        price,
                        "</text></svg>"
                    )
                )
            )
        );
    }
}
