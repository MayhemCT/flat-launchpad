// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LibClone} from "solady/utils/LibClone.sol";
import {UpgradeableBeacon} from "solady/utils/UpgradeableBeacon.sol";

import {LauncherFactoryBase} from "src/flap/LauncherFactoryBase.sol";
import {LauncherDataSchema, FieldDescriptor} from "src/flap/IVaultSchemas.sol";
import {RaidPassLauncher, RaidPassConfig} from "./RaidPassLauncher.sol";

/// @title RaidPassLauncherFactory
/// @notice Deploys one `RaidPassLauncher` per launch.
///
///         - `newLauncher` is Portal-only (applied by `LauncherFactoryBase`).
///         - `data` is `abi.encode(RaidPassConfig)`, decoded strictly: any other encoding reverts.
///         - The salt-lock fee is forwarded to the Launcher, which locks the salt itself.
///         - Each Launcher is an ERC1967 beacon proxy at an address fixed by `(beacon, config.salt)`.
///         - `upgradeVaultImplementation` is the only privileged function and only the Flap Guardian can call it.
///           There is no owner, pause, fee or allowlist, and the factory takes no commission.
///
///         The Portal and the Guardian come from the chain registry in `LaunchVaultAddresses`, so the same
///         bytecode is correct on BNB Chain and BNB Chain Testnet.
contract RaidPassLauncherFactory is LauncherFactoryBase {
    /// @notice The solady `UpgradeableBeacon` every Launcher proxy points at.
    address public immutable beacon;

    event RaidPassLauncherCreated(
        address indexed launcher, address indexed creator, bytes32 launchSalt, uint256 mintPrice, uint256 maxPasses
    );
    event FlapLauncherImplementationUpgraded(address implementation);

    error InvalidData();

    constructor() {
        beacon = address(new UpgradeableBeacon(address(this), address(new RaidPassLauncher())));
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

    /// @notice The address a Launcher created with `salt` will have.
    function predictLauncher(bytes32 salt) external view returns (address) {
        return LibClone.predictDeterministicAddressERC1967BeaconProxy(beacon, salt, address(this));
    }

    /// @inheritdoc LauncherFactoryBase
    function _newLauncher(address creator, bytes calldata data) internal override returns (address launcher) {
        RaidPassConfig memory config = abi.decode(data, (RaidPassConfig));
        // Strict: the canonical encoding of the decoded config must be exactly what was sent.
        if (keccak256(abi.encode(config)) != keccak256(data)) revert InvalidData();

        launcher = LibClone.deployDeterministicERC1967BeaconProxy(beacon, config.salt);
        RaidPassLauncher(launcher).initialize{value: msg.value}(_getHub(), creator, config);

        emit RaidPassLauncherCreated(launcher, creator, config.salt, config.mintPrice, config.maxPasses);
    }

    /// @inheritdoc LauncherFactoryBase
    function upgradeVaultImplementation(address newImplementation) external override onlyGuardian {
        UpgradeableBeacon(beacon).upgradeTo(newImplementation);
        emit FlapLauncherImplementationUpgraded(newImplementation);
    }

    /// @inheritdoc LauncherFactoryBase
    function launcherDataSchema() external pure override returns (LauncherDataSchema memory schema) {
        schema.description =
            "RaidPass NFT mint: passes are sold at a fixed BNB price. When every pass is minted, the raise and 50% of the supply seed the pool and each pass claims an equal share of the other 50%. If the mint does not sell out by the deadline, passes are burned for a refund.";
        schema.isArray = false;

        FieldDescriptor[] memory fields = new FieldDescriptor[](7);
        fields[0] = FieldDescriptor({name: "name", fieldType: "string", description: "Token name", decimals: 0});
        fields[1] = FieldDescriptor({name: "symbol", fieldType: "string", description: "Token symbol", decimals: 0});
        fields[2] = FieldDescriptor({name: "meta", fieldType: "string", description: "Metadata CID", decimals: 0});
        fields[3] = FieldDescriptor({
            name: "salt",
            fieldType: "bytes32",
            description: "CREATE2 salt; vanity-mined so the token address ends in 0x7777",
            decimals: 0
        });
        fields[4] =
            FieldDescriptor({name: "mintPrice", fieldType: "uint256", description: "BNB per pass", decimals: 18});
        fields[5] = FieldDescriptor({
            name: "maxPasses",
            fieldType: "uint256",
            description: "Passes in the mint, 1 to 10000. mintPrice x maxPasses is the raise target and the pool quote",
            decimals: 0
        });
        fields[6] = FieldDescriptor({
            name: "saleDuration",
            fieldType: "uint256",
            description: "Mint window in seconds, 600 to 2592000",
            decimals: 0
        });
        schema.fields = fields;
    }
}
