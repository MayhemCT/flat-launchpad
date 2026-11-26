// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";

import {RaidPassLauncher, RaidPassConfig, RaidPassInfo} from "src/raidpass/RaidPassLauncher.sol";
import {RaidPassLauncherFactory} from "src/raidpass/RaidPassLauncherFactory.sol";
import {LauncherFactoryBase} from "src/flap/LauncherFactoryBase.sol";
import {LauncherBase} from "src/flap/LauncherBase.sol";
import {ForkBase} from "test/ForkBase.sol";

/// @notice The whole RaidPass flow against the live Pool Launch Portal: create a Launcher, mint passes, launch,
///         claim, trade, and the refund paths. `ForkBase` stands in for Flap by enabling the factory.
abstract contract RaidPassFork is ForkBase {
    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant PASSES = 10;

    RaidPassLauncherFactory internal factory;

    function _config(bytes32 seed) internal returns (RaidPassConfig memory c) {
        c.name = "Raid Example";
        c.symbol = "RAIDX";
        c.meta = "bafkreig4y5nwb4izyilbbmiydumvkld446d4k7j4ohg3x3q2lfel3fo4yq";
        c.salt = _mineSalt(seed);
        c.mintPrice = PRICE;
        c.maxPasses = PASSES;
        c.saleDuration = 1 days;
    }

    function _open() internal {
        factory = new RaidPassLauncherFactory();
        _openLauncherFactory(address(factory));
    }

    function _create(bytes32 seed) internal returns (RaidPassLauncher launcher) {
        launcher = RaidPassLauncher(_newLauncher(address(factory), abi.encode(_config(seed))));
    }

    function _ids(uint256 from, uint256 to) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](to - from + 1);
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = from + i;
        }
    }

    /// @dev BNB Chain is permissioned: only a factory Flap has enabled can create Launchers. BNB Chain Testnet
    ///      is open (creation is not paused there and the Portal accepts any factory), so the same call succeeds.
    function test_01_anUnopenedFactoryIsClosedOnMainnetAndOpenOnTestnet() public {
        factory = new RaidPassLauncherFactory();
        bytes memory data = abi.encode(_config("raid-unopened"));
        uint256 fee = portal.SALT_LOCK_FEE();

        (bool enabled,) = portal.launcherFactoryMultiplier(address(factory));
        assertFalse(enabled, "a new factory starts closed");

        vm.prank(creator);
        if (block.chainid == 56) {
            vm.expectRevert();
            portal.newLauncher{value: fee}(address(factory), data);
        } else {
            address launcher = portal.newLauncher{value: fee}(address(factory), data);
            assertEq(portal.getLauncher(launcher).launcherFactory, address(factory), "testnet records it");
        }
    }

    function test_02_factoryFollowsTheSpec() public {
        _open();
        assertEq(factory.factorySpecVersion(), "lf-v1");
        assertEq(factory.hub(), portalAddr, "hub comes from the chain registry");
        assertEq(factory.guardian(), guardian, "guardian comes from the chain registry");
        assertEq(factory.launcherDataSchema().fields.length, 7, "one schema field per config field");

        // Only the Portal creates Launchers.
        bytes memory data = abi.encode(_config("raid-direct"));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LauncherFactoryBase.NotHub.selector, creator));
        factory.newLauncher(creator, data);

        // Only the Guardian upgrades them.
        address impl = address(new RaidPassLauncher());
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LauncherFactoryBase.NotGuardian.selector, creator));
        factory.upgradeVaultImplementation(impl);
        vm.prank(guardian);
        factory.upgradeVaultImplementation(impl);
        assertEq(factory.beaconImplementation(), impl);
    }

    function test_03_dataIsDecodedStrictly() public {
        _open();
        uint256 fee = portal.SALT_LOCK_FEE();
        bytes memory data = bytes.concat(abi.encode(_config("raid-strict")), bytes32(uint256(1)));
        vm.prank(creator);
        vm.expectRevert(RaidPassLauncherFactory.InvalidData.selector);
        portal.newLauncher{value: fee}(address(factory), data);
    }

    function test_04_invalidConfigsAreRejected() public {
        _open();
        uint256 fee = portal.SALT_LOCK_FEE();

        RaidPassConfig memory c = _config("raid-invalid");
        c.maxPasses = 10_001;
        vm.prank(creator);
        vm.expectRevert(RaidPassLauncher.InvalidConfig.selector);
        portal.newLauncher{value: fee}(address(factory), abi.encode(c));

        c.maxPasses = PASSES;
        c.mintPrice = 0;
        vm.prank(creator);
        vm.expectRevert(RaidPassLauncher.InvalidConfig.selector);
        portal.newLauncher{value: fee}(address(factory), abi.encode(c));

        c.mintPrice = PRICE;
        c.saleDuration = 60;
        vm.prank(creator);
        vm.expectRevert(RaidPassLauncher.InvalidConfig.selector);
        portal.newLauncher{value: fee}(address(factory), abi.encode(c));
    }

    function test_05_fullJourney() public {
        _open();
        assertTrue(_paused(), "the Portal is paused, so the opened factory is what lets this launch through");

        RaidPassConfig memory c = _config("raid-journey");
        address predicted = factory.predictLauncher(c.salt);
        vm.recordLogs();
        address launcherAddr = _newLauncher(address(factory), abi.encode(c));
        Vm.Log[] memory creation = vm.getRecordedLogs();
        RaidPassLauncher launcher = RaidPassLauncher(launcherAddr);

        assertEq(launcherAddr, predicted, "the Launcher address is known before creation");
        assertEq(portal.getLauncher(launcherAddr).launcherFactory, address(factory), "Portal recorded the Launcher");
        assertEq(launcher.creator(), creator);
        assertEq(launcher.targetRaise(), PRICE * PASSES);
        assertEq(launcher.name(), "Raid Example RaidPass");
        assertEq(launcher.symbol(), "RAIDX-PASS");
        _assertLauncherDescription(launcherAddr, c.name, c.symbol, PRICE * PASSES, creation);

        // Alice mints 4 passes and sells one to Bob before the launch.
        vm.prank(alice);
        launcher.mint{value: 4 * PRICE}();
        assertEq(launcher.balanceOf(alice), 4);
        assertEq(launcher.passesOf(alice).length, 4);
        assertFalse(launcher.launched(), "not sold out yet");
        vm.prank(alice);
        launcher.transferFrom(alice, bob, 4);
        assertEq(launcher.passesOf(alice).length, 3, "the index follows the transfer");
        assertEq(launcher.passesOf(bob)[0], 4);

        // Nothing is claimable before the launch.
        assertEq(launcher.claimableOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(RaidPassLauncher.NotLaunched.selector);
        launcher.claim();

        // Bob mints the last 6: that mint launches the token.
        vm.recordLogs();
        vm.prank(bob);
        launcher.mint{value: 6 * PRICE}();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertTrue(launcher.launched(), "the mint that sold the last pass launched the token");
        address token = launcher.token();
        assertTrue(token.code.length > 0, "token deployed");
        assertEq(uint16(uint160(token)), 0x7777, "vanity suffix");
        assertTrue(launcher.pool().code.length > 0, "pool deployed");
        assertEq(address(launcher).balance, 0, "the whole raise went into the pool");
        assertEq(_launchedCreator(logs, token), creator, "the launch event names the creator, not the Launcher");
        assertEq(IERC20(token).balanceOf(launcherAddr), launcher.RESERVED_TOKEN(), "the reserved half is here");

        RaidPassInfo memory i = launcher.info();
        assertEq(i.minted, PASSES);
        assertEq(i.raised, PRICE * PASSES);
        assertEq(i.token, token);
        assertTrue(i.launched);

        // Each pass claims an equal share, once, to whoever holds it.
        uint256 share = launcher.tokensPerPass();
        assertEq(share, launcher.RESERVED_TOKEN() / PASSES);
        assertEq(launcher.claimableOf(alice), 3 * share);
        assertEq(launcher.claimableOf(bob), 7 * share);

        // Alice claims one pass by id, then the rest in one call.
        vm.prank(alice);
        launcher.claimPasses(_ids(1, 1));
        assertEq(IERC20(token).balanceOf(alice), share);
        vm.prank(alice);
        launcher.claim();
        assertEq(IERC20(token).balanceOf(alice), 3 * share, "alice holds 3 passes");
        vm.prank(bob);
        launcher.claim();
        assertEq(IERC20(token).balanceOf(bob), 7 * share, "bob holds 7 passes, one bought from alice");
        assertEq(IERC20(token).balanceOf(launcherAddr), 0, "everything reserved was claimed");
        assertEq(launcher.claimableOf(bob), 0);

        // A pass claims once, even after it changes hands, and only its holder can claim.
        vm.prank(alice);
        vm.expectRevert(RaidPassLauncher.NothingToClaim.selector);
        launcher.claim();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaidPassLauncher.PassAlreadyClaimed.selector, 1));
        launcher.claimPasses(_ids(1, 1));
        vm.prank(alice);
        launcher.transferFrom(alice, trader, 1);
        vm.prank(trader);
        vm.expectRevert(RaidPassLauncher.NothingToClaim.selector);
        launcher.claim();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaidPassLauncher.NotPassHolder.selector, 5));
        launcher.claimPasses(_ids(5, 5));

        // The pass stays as a membership pass and its metadata is on-chain.
        assertEq(launcher.ownerOf(2), alice);
        _assertContains(launcher.tokenURI(2), "data:application/json;base64,", "on-chain metadata");

        // The mint is over and nothing can be refunded.
        vm.prank(bob);
        vm.expectRevert(RaidPassLauncher.AlreadyLaunched.selector);
        launcher.mint{value: PRICE}();
        assertFalse(launcher.refundAvailable());
        assertEq(launcher.refundableOf(bob), 0);
        vm.prank(bob);
        vm.expectRevert(RaidPassLauncher.RefundUnavailable.selector);
        launcher.refund();

        // Trading works on the real pool, and tax flows without reverting.
        _generateTaxAndDispatch(token);
    }

    function test_06_mintGuards() public {
        _open();
        RaidPassLauncher launcher = _create("raid-guards");

        vm.startPrank(alice);
        vm.expectRevert(RaidPassLauncher.ZeroQuantity.selector);
        launcher.mint();
        vm.expectRevert(RaidPassLauncher.ZeroQuantity.selector);
        launcher.mint{value: PRICE - 1}();
        // The value must be an exact multiple of the price.
        vm.expectRevert(abi.encodeWithSelector(RaidPassLauncher.WrongPayment.selector, PRICE + 1, PRICE));
        launcher.mint{value: PRICE + 1}();
        vm.expectRevert(RaidPassLauncher.SoldOut.selector);
        launcher.mint{value: 11 * PRICE}();
        vm.stopPrank();

        vm.deal(trader, 100 ether);
        vm.prank(trader);
        vm.expectRevert(RaidPassLauncher.MintTooLarge.selector);
        launcher.mint{value: 51 * PRICE}();

        vm.warp(launcher.saleDeadline());
        vm.prank(alice);
        vm.expectRevert(RaidPassLauncher.SaleClosed.selector);
        launcher.mint{value: PRICE}();
    }

    function test_07_burnToRefundWhenTheMintDoesNotSellOut() public {
        _open();
        RaidPassLauncher launcher = _create("raid-refund");

        vm.prank(alice);
        launcher.mint{value: 4 * PRICE}();
        // Alice sells pass 3 to Bob before the deadline: the refund follows the pass.
        vm.prank(alice);
        launcher.transferFrom(alice, bob, 3);

        assertFalse(launcher.refundAvailable(), "the mint is still open");
        assertEq(launcher.refundableOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(RaidPassLauncher.RefundUnavailable.selector);
        launcher.refund();

        vm.warp(launcher.saleDeadline());
        assertTrue(launcher.refundAvailable());
        assertEq(launcher.refundableOf(alice), 3 * PRICE);
        assertEq(launcher.refundableOf(bob), PRICE);

        // Alice cannot refund a pass she no longer holds.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaidPassLauncher.NotPassHolder.selector, 3));
        launcher.refundPasses(_ids(3, 3));

        // One pass by id, then everything left in one call.
        vm.prank(alice);
        launcher.refundPasses(_ids(1, 1));
        assertEq(alice.balance, 30 ether - 3 * PRICE);
        vm.prank(alice);
        launcher.refund();
        assertEq(alice.balance, 30 ether - PRICE, "alice got three of her four mint prices back");
        vm.prank(bob);
        launcher.refund();
        assertEq(bob.balance, 30 ether + PRICE, "bob holds the pass, so bob gets its refund");

        assertEq(launcher.burned(), 4);
        assertEq(launcher.raised(), 0);
        assertEq(address(launcher).balance, 0);
        assertEq(launcher.balanceOf(alice), 0, "refunded passes are burned");
        assertEq(launcher.passesOf(alice).length, 0);
        assertFalse(launcher.launched());

        // Nothing is left to refund.
        vm.prank(alice);
        vm.expectRevert(RaidPassLauncher.NothingToRefund.selector);
        launcher.refund();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaidPassLauncher.NotPassHolder.selector, 1));
        launcher.refundPasses(_ids(1, 1));
    }

    function test_08_guardianCanOpenRefundsEarly() public {
        _open();
        RaidPassLauncher launcher = _create("raid-guardian");
        vm.prank(alice);
        launcher.mint{value: 2 * PRICE}();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LauncherBase.NotGuardian.selector, alice));
        launcher.openRefunds();

        vm.prank(guardian);
        launcher.openRefunds();

        vm.prank(bob);
        vm.expectRevert(RaidPassLauncher.SaleClosed.selector);
        launcher.mint{value: PRICE}();

        vm.prank(alice);
        launcher.refund();
        assertEq(alice.balance, 30 ether, "alice got everything back before the deadline");
    }

    function test_09_aLauncherCannotBeInitializedTwice() public {
        _open();
        RaidPassLauncher launcher = _create("raid-init");
        RaidPassConfig memory c = _config("raid-init-again");
        vm.expectRevert();
        launcher.initialize(portalAddr, alice, c);

        // The implementation itself is locked.
        RaidPassLauncher impl = RaidPassLauncher(factory.beaconImplementation());
        vm.expectRevert();
        impl.initialize(portalAddr, alice, c);
    }
}
