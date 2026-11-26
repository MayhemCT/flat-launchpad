// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LibClone} from "solady/utils/LibClone.sol";
import {UpgradeableBeacon} from "solady/utils/UpgradeableBeacon.sol";

import {LauncherFactoryBase} from "src/flap/LauncherFactoryBase.sol";
import {LauncherDataSchema, FieldDescriptor} from "src/flap/IVaultSchemas.sol";
import {CallZLauncher, CallZConfig} from "./CallZLauncher.sol";

/// @title CallZLauncherFactory
/// @notice Deploys one `CallZLauncher` per launch.
///
///         - `newLauncher` is Portal-only (applied by `LauncherFactoryBase`).
///         - `data` is `abi.encode(CallZConfig)`, decoded strictly: any other encoding reverts.
///         - The salt-lock fee is forwarded to the Launcher, which locks the salt itself.
///         - Each Launcher is an ERC1967 beacon proxy at an address fixed by `(beacon, config.salt)`.
///         - `upgradeVaultImplementation` is the only privileged function and only the Flap Guardian can call it.
///           There is no owner, pause, fee or allowlist, and the factory takes no commission.
///
///         The Portal and the Guardian come from the chain registry in `LaunchVaultAddresses`, so the same
///         bytecode is correct on BNB Chain and BNB Chain Testnet.
contract CallZLauncherFactory is LauncherFactoryBase {
    /// @notice The solady `UpgradeableBeacon` every Launcher proxy points at.
    address public immutable beacon;

    /// @notice Every Launcher this factory created, oldest first.
    address[] public launchers;

    event CallZLauncherCreated(
        address indexed launcher, address indexed creator, bytes32 launchSalt, uint256 nftPrice, uint256 cap
    );
    event FlapLauncherImplementationUpgraded(address implementation);

    error InvalidData();

    constructor() {
        beacon = address(new UpgradeableBeacon(address(this), address(new CallZLauncher())));
    }

    /// @notice The Pool Launch Portal this factory deploys Launchers for.
    function hub() external view returns (address) {
        return _getHub();
    }

    /// @notice The only account allowed to upgrade the Launcher implementation.
    function guardian() external view returns (address) {
        return _getGuardian();
    }

    /// @notice The implementation every Launcher of this factory currently delegates to.
    function beaconImplementation() external view returns (address) {
        return UpgradeableBeacon(beacon).implementation();
    }

    function launcherCount() external view returns (uint256) {
        return launchers.length;
    }

    /// @notice The address a Launcher created with `salt` will have.
    function predictLauncher(bytes32 salt) external view returns (address) {
        return LibClone.predictDeterministicAddressERC1967BeaconProxy(beacon, salt, address(this));
    }

    /// @inheritdoc LauncherFactoryBase
    function _newLauncher(address creator, bytes calldata data) internal override returns (address launcher) {
        CallZConfig memory config = abi.decode(data, (CallZConfig));
        // Strict: the canonical encoding of the decoded config must be exactly what was sent.
        if (keccak256(abi.encode(config)) != keccak256(data)) revert InvalidData();

        launcher = LibClone.deployDeterministicERC1967BeaconProxy(beacon, config.salt);
        CallZLauncher(launcher).initialize{value: msg.value}(_getHub(), creator, config);
        launchers.push(launcher);

        emit CallZLauncherCreated(launcher, creator, config.salt, config.nftPrice, config.cap);
    }

    /// @inheritdoc LauncherFactoryBase
    function upgradeVaultImplementation(address newImplementation) external override onlyGuardian {
        UpgradeableBeacon(beacon).upgradeTo(newImplementation);
        emit FlapLauncherImplementationUpgraded(newImplementation);
    }

    /// @inheritdoc LauncherFactoryBase
    function launcherDataSchema() external pure override returns (LauncherDataSchema memory schema) {
        schema.description =
            "CallZ NFT mint: NFTs are sold at a flat BNB price until the raise reaches its cap. The raise and the pool share of the supply then seed the pool, and every NFT claims an equal share of the rest. If the cap is not reached by the deadline, NFTs are burned for a refund.";
        schema.isArray = false;

        FieldDescriptor[] memory fields = new FieldDescriptor[](10);
        fields[0] = FieldDescriptor({name: "name", fieldType: "string", description: "Token name", decimals: 0});
        fields[1] = FieldDescriptor({name: "symbol", fieldType: "string", description: "Token symbol", decimals: 0});
        fields[2] = FieldDescriptor({name: "meta", fieldType: "string", description: "Metadata CID", decimals: 0});
        fields[3] = FieldDescriptor({name: "salt", fieldType: "bytes32", description: "CREATE2 salt; vanity-mined so the token address ends in 0x7777", decimals: 0});
        fields[4] = FieldDescriptor({name: "nftPrice", fieldType: "uint256", description: "BNB per NFT; every NFT costs the same", decimals: 18});
        fields[5] = FieldDescriptor({name: "cap", fieldType: "uint256", description: "BNB to raise: at most 10 BNB and an exact multiple of nftPrice. All of it goes into the pool", decimals: 18});
        fields[6] = FieldDescriptor({name: "saleDuration", fieldType: "uint256", description: "Mint window in seconds, 600 to 2592000", decimals: 0});
        fields[7] = FieldDescriptor({name: "poolShareBps", fieldType: "uint16", description: "Share of the supply that goes into the pool, in bps, 1000 to 9000", decimals: 0});
        fields[8] = FieldDescriptor({name: "buyTaxBps", fieldType: "uint16", description: "Buy tax in bps, at most 1000", decimals: 0});
        fields[9] = FieldDescriptor({name: "sellTaxBps", fieldType: "uint16", description: "Sell tax in bps, at most 1000", decimals: 0});
        schema.fields = fields;
    }
}
