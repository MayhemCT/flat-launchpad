// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LibClone} from "solady/utils/LibClone.sol";
import {CallZRoom, CallZRoomConfig} from "./CallZRoom.sol";
import {CallZRoomArt} from "./CallZRoomArt.sol";

/// @title CallZRoomFactory
/// @notice Deploys one `CallZRoom` per room, as an immutable minimal clone.
///
///         Anyone can create a room. Each room is created with the launch fee in force at that moment: a share
///         of its raise, at most 10%, paid to the CallZ vault when it launches. The guardian can change the fee
///         for rooms created afterwards and nothing else: the factory cannot touch a room after creating it.
contract CallZRoomFactory {
    /// @notice The PancakeSwap V2 factory every room launches into.
    address public immutable pancakeFactory;
    /// @notice Wrapped BNB: the quote token of every pool.
    address public immutable wbnb;
    /// @notice The CallZRoom every room is a clone of.
    address public immutable implementation;
    /// @notice The CallZ vault every room pays its launch fee to.
    address public immutable vault;
    /// @notice The contract that writes every pass's metadata. It holds nothing and nobody controls it.
    address public immutable art;
    /// @notice The highest launch fee the guardian can set: 10% of the raise.
    uint16 public constant MAX_LAUNCH_FEE_BPS = 1000;

    address public guardian;
    address public pendingGuardian;
    /// @notice Share of the raise a room created now pays at launch, in bps.
    uint16 public launchFeeBps;

    /// @notice Every room this factory created, oldest first.
    address[] public rooms;
    /// @notice Whether an address is a room this factory created.
    mapping(address room => bool) public isRoom;

    event CallZRoomCreated(
        address indexed room, address indexed creator, string name, string symbol, uint256 seatPrice, uint256 seats
    );
    event LaunchFeeSet(uint16 launchFeeBps);
    event GuardianTransferStarted(address indexed pendingGuardian);
    event GuardianChanged(address indexed guardian);

    error ZeroAddress();
    error NotGuardian();
    error FeeTooHigh();
    /// @notice The caller has already created a room with this salt.
    error SaltUsed();

    constructor(address pancakeFactory_, address wbnb_, address vault_, address guardian_, uint16 launchFeeBps_) {
        if (pancakeFactory_ == address(0) || wbnb_ == address(0) || vault_ == address(0) || guardian_ == address(0)) {
            revert ZeroAddress();
        }
        if (launchFeeBps_ > MAX_LAUNCH_FEE_BPS) revert FeeTooHigh();
        pancakeFactory = pancakeFactory_;
        wbnb = wbnb_;
        vault = vault_;
        guardian = guardian_;
        launchFeeBps = launchFeeBps_;
        implementation = address(new CallZRoom());
        art = address(new CallZRoomArt());
        emit GuardianChanged(guardian_);
        emit LaunchFeeSet(launchFeeBps_);
    }

    /// @notice Set the launch fee of rooms created from now on. At most 10%. Existing rooms keep theirs.
    function setLaunchFee(uint16 launchFeeBps_) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (launchFeeBps_ > MAX_LAUNCH_FEE_BPS) revert FeeTooHigh();
        launchFeeBps = launchFeeBps_;
        emit LaunchFeeSet(launchFeeBps_);
    }

    /// @notice Hand the guardian role over in two steps.
    function transferGuardian(address next) external {
        if (msg.sender != guardian) revert NotGuardian();
        pendingGuardian = next;
        emit GuardianTransferStarted(next);
    }

    function acceptGuardian() external {
        if (msg.sender != pendingGuardian) revert NotGuardian();
        guardian = msg.sender;
        pendingGuardian = address(0);
        emit GuardianChanged(msg.sender);
    }

    /// @notice Create a room. The caller is its dev. `salt` is any value the caller has not used before.
    function create(CallZRoomConfig calldata config, bytes32 salt) external returns (address room) {
        // The clone's address depends on the caller, so nobody else can take it first.
        bytes32 cloneSalt = keccak256(abi.encode(msg.sender, salt));
        // A salt the caller already used: said here, rather than left to a failed deployment that spends all the gas.
        if (LibClone.predictDeterministicAddress(implementation, cloneSalt, address(this)).code.length != 0) revert SaltUsed();
        room = LibClone.cloneDeterministic(implementation, cloneSalt);
        CallZRoom(room).initialize(pancakeFactory, wbnb, msg.sender, vault, launchFeeBps, art, config);
        rooms.push(room);
        isRoom[room] = true;
        emit CallZRoomCreated(room, msg.sender, config.name, config.symbol, config.seatPrice, config.seats);
    }

    /// @notice The address a room created by `creator` with `salt` will have.
    function predict(address creator, bytes32 salt) external view returns (address) {
        return LibClone.predictDeterministicAddress(implementation, keccak256(abi.encode(creator, salt)), address(this));
    }

    function roomCount() external view returns (uint256) {
        return rooms.length;
    }
}
