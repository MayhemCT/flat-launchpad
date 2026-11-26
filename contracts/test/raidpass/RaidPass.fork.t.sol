// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";

import {RaidPassLauncher, RaidPassConfig, RaidPassInfo} from "src/raidpass/RaidPassLauncher.sol";
import {RaidPassLauncherFactory} from "src/raidpass/RaidPassLauncherFactory.sol";
import {LauncherFactoryBase} from "src/flap/LauncherFactoryBase.sol";
import {LauncherBase} from "src/flap/LauncherBase.sol";
import {ForkBase} from "test/ForkBase.sol";

/// @notice The whole RaidPass flow against the live Pool Launch Portal: create a Launcher, mint NFTs, launch,
///         claim, trade, and the refund paths. `ForkBase` stands in for Flap by enabling the factory.
abstract contract RaidPassFork is ForkBase {
    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant NFTS = 10;

    RaidPassLauncherFactory internal factory;

    function _config(bytes32 seed) internal returns (RaidPassConfig memory c) {
        c.name = "Raid Example";
        c.symbol = "RAIDX";
        c.meta = "bafkreig4y5nwb4izyilbbmiydumvkld446d4k7j4ohg3x3q2lfel3fo4yq";
        c.salt = _mineSalt(seed);
        c.nftPrice = PRICE;
        c.cap = PRICE * NFTS; // 10 BNB, the most a mint can raise
        c.saleDuration = 1 days;
        c.poolShareBps = 5000;
        c.buyTaxBps = 300;
        c.sellTaxBps = 500;
    }

    function _open() internal {
        factory = new RaidPassLauncherFactory();
        _openLauncherFactory(address(factory));
    }

    function _create(bytes32 seed) internal returns (RaidPassLauncher launcher) {
        launcher = RaidPassLauncher(_newLauncher(address(factory), abi.encode(_config(seed))));
    }

    function _expectInvalid(RaidPassConfig memory c) internal {
        uint256 fee = portal.SALT_LOCK_FEE();
        vm.prank(creator);
        vm.expectRevert(RaidPassLauncher.InvalidConfig.selector);
        portal.newLauncher{value: fee}(address(factory), abi.encode(c));
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
        assertEq(factory.launcherDataSchema().fields.length, 10, "one schema field per config field");

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

    function test_04_configRules() public {
        _open();

        // The cap is at most 10 BNB.
        RaidPassConfig memory c = _config("raid-config");
        c.cap = 11 ether;
        _expectInvalid(c);

        // The cap is an exact multiple of the price.
        c.cap = 1.5 ether;
        _expectInvalid(c);

        // The price is not zero.
        c.cap = 10 ether;
        c.nftPrice = 0;
        _expectInvalid(c);

        // Taxes are at most 10%.
        c.nftPrice = PRICE;
        c.buyTaxBps = 1001;
        _expectInvalid(c);
        c.buyTaxBps = 300;
        c.sellTaxBps = 1001;
        _expectInvalid(c);

        // The pool share is between 10% and 90%.
        c.sellTaxBps = 500;
        c.poolShareBps = 999;
        _expectInvalid(c);
        c.poolShareBps = 9001;
        _expectInvalid(c);

        // The mint window is bounded.
        c.poolShareBps = 5000;
        c.saleDuration = 60;
        _expectInvalid(c);
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
        assertEq(launcher.cap(), PRICE * NFTS);
        assertEq(launcher.targetRaise(), PRICE * NFTS);
        assertEq(launcher.maxNFTs(), NFTS, "cap / nftPrice NFTs are for sale");
        assertEq(launcher.name(), "Raid Example CallZ Pass");
        assertEq(launcher.symbol(), "RAIDX-PASS");
        _assertLauncherDescription(launcherAddr, c.name, c.symbol, PRICE * NFTS, creation);

        // Alice mints 4 NFTs and sells one to Bob before the launch.
        vm.prank(alice);
        launcher.mint{value: 4 * PRICE}();
        assertEq(launcher.balanceOf(alice), 4);
        assertEq(launcher.nftsOf(alice).length, 4);
        assertFalse(launcher.launched(), "cap not reached yet");
        vm.prank(alice);
        launcher.transferFrom(alice, bob, 4);
        assertEq(launcher.nftsOf(alice).length, 3, "the index follows the transfer");
        assertEq(launcher.nftsOf(bob)[0], 4);

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

        assertTrue(launcher.launched(), "the mint that reached the cap launched the token");
        address token = launcher.token();
        assertTrue(token.code.length > 0, "token deployed");
        assertEq(uint16(uint160(token)), 0x7777, "vanity suffix");
        assertTrue(launcher.pool().code.length > 0, "pool deployed");
        assertEq(address(launcher).balance, 0, "the whole raise went into the pool");
        assertEq(_launchedCreator(logs, token), creator, "the launch event names the creator, not the Launcher");
        assertEq(IERC20(token).balanceOf(launcherAddr), launcher.holderPool(), "the holders' supply is here");

        RaidPassInfo memory i = launcher.info();
        assertEq(i.minted, NFTS);
        assertEq(i.raised, PRICE * NFTS);
        assertEq(i.token, token);
        assertEq(i.poolToken + i.holderPool, launcher.TOTAL_SUPPLY());
        assertTrue(i.launched);

        // Each NFT claims an equal share, once, to whoever holds it.
        uint256 share = launcher.tokensPerNFT();
        assertEq(share, launcher.holderPool() / NFTS);
        assertEq(launcher.claimableOf(alice), 3 * share);
        assertEq(launcher.claimableOf(bob), 7 * share);

        // Alice claims one NFT by id, then the rest in one call.
        vm.prank(alice);
        launcher.claimNFTs(_ids(1, 1));
        assertEq(IERC20(token).balanceOf(alice), share);
        vm.prank(alice);
        launcher.claim();
        assertEq(IERC20(token).balanceOf(alice), 3 * share, "alice holds 3 NFTs");
        vm.prank(bob);
        launcher.claim();
        assertEq(IERC20(token).balanceOf(bob), 7 * share, "bob holds 7 NFTs, one bought from alice");
        assertEq(IERC20(token).balanceOf(launcherAddr), 0, "the whole holders' supply was claimed");
        assertEq(launcher.claimableOf(bob), 0);

        // An NFT claims once, even after it changes hands, and only its holder can claim.
        vm.prank(alice);
        vm.expectRevert(RaidPassLauncher.NothingToClaim.selector);
        launcher.claim();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaidPassLauncher.AlreadyClaimed.selector, 1));
        launcher.claimNFTs(_ids(1, 1));
        vm.prank(alice);
        launcher.transferFrom(alice, trader, 1);
        vm.prank(trader);
        vm.expectRevert(RaidPassLauncher.NothingToClaim.selector);
        launcher.claim();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaidPassLauncher.NotHolder.selector, 5));
        launcher.claimNFTs(_ids(5, 5));

        // The NFT stays as a membership pass and its metadata is on-chain.
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

    function test_06_overflowOnTheLastMintIsRefunded() public {
        _open();
        RaidPassLauncher launcher = _create("raid-overflow");

        vm.prank(alice);
        launcher.mint{value: 8 * PRICE}();

        // Bob asks for 5 but only 2 are left: he gets 2, the launch runs, and 3 prices come back.
        uint256 before_ = bob.balance;
        vm.prank(bob);
        launcher.mint{value: 5 * PRICE}();

        assertEq(launcher.balanceOf(bob), 2, "bob got what was left");
        assertEq(bob.balance, before_ - 2 * PRICE, "bob paid for 2 and got the rest back");
        assertEq(launcher.minted(), NFTS);
        assertEq(launcher.raised(), PRICE * NFTS, "the raise landed exactly on the cap");
        assertTrue(launcher.launched(), "the overflowing mint still launched");
        assertEq(address(launcher).balance, 0, "nothing is left in the Launcher");
    }

    function test_07_poolShareAndTaxesAreConfigurable() public {
        _open();
        RaidPassConfig memory c = _config("raid-shape");
        c.poolShareBps = 8000; // 80% in the pool, 20% to the NFTs
        c.buyTaxBps = 100;
        c.sellTaxBps = 1000;
        RaidPassLauncher launcher = RaidPassLauncher(_newLauncher(address(factory), abi.encode(c)));

        assertEq(launcher.poolToken(), launcher.TOTAL_SUPPLY() * 80 / 100);
        assertEq(launcher.holderPool(), launcher.TOTAL_SUPPLY() * 20 / 100);
        _assertContains(launcher.description(), '"poolTokenRatio":"800000000000000000"', "description shows 80%");

        vm.prank(alice);
        launcher.mint{value: NFTS * PRICE}();
        assertTrue(launcher.launched());
        assertEq(IERC20(launcher.token()).balanceOf(address(launcher)), launcher.holderPool());

        vm.prank(alice);
        launcher.claim();
        assertEq(IERC20(launcher.token()).balanceOf(alice), launcher.holderPool(), "the NFTs share 20% of supply");
    }

    function test_08_mintGuards() public {
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
        vm.stopPrank();

        vm.warp(launcher.saleDeadline());
        vm.prank(alice);
        vm.expectRevert(RaidPassLauncher.SaleClosed.selector);
        launcher.mint{value: PRICE}();
    }

    function test_09_burnToRefundWhenTheCapIsMissed() public {
        _open();
        RaidPassLauncher launcher = _create("raid-refund");

        vm.prank(alice);
        launcher.mint{value: 4 * PRICE}();
        // Alice sells NFT 3 to Bob before the deadline: the refund follows the NFT.
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

        // Alice cannot refund an NFT she no longer holds.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaidPassLauncher.NotHolder.selector, 3));
        launcher.refundNFTs(_ids(3, 3));

        // One NFT by id, then everything left in one call.
        vm.prank(alice);
        launcher.refundNFTs(_ids(1, 1));
        assertEq(alice.balance, 30 ether - 3 * PRICE);
        vm.prank(alice);
        launcher.refund();
        assertEq(alice.balance, 30 ether - PRICE, "alice got three of her four prices back");
        vm.prank(bob);
        launcher.refund();
        assertEq(bob.balance, 30 ether + PRICE, "bob holds the NFT, so bob gets its refund");

        assertEq(launcher.burned(), 4);
        assertEq(launcher.raised(), 0);
        assertEq(address(launcher).balance, 0);
        assertEq(launcher.balanceOf(alice), 0, "refunded NFTs are burned");
        assertEq(launcher.nftsOf(alice).length, 0);
        assertFalse(launcher.launched());

        // Nothing is left to refund.
        vm.prank(alice);
        vm.expectRevert(RaidPassLauncher.NothingToRefund.selector);
        launcher.refund();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaidPassLauncher.NotHolder.selector, 1));
        launcher.refundNFTs(_ids(1, 1));
    }

    function test_10_guardianCanOpenRefundsEarly() public {
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

    function test_11_aLauncherCannotBeInitializedTwice() public {
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

    /// @dev The Portal reads at most 4,096 bytes of `description()` with at most 200,000 gas, and stores an empty
    ///      description past either limit with no revert. The longest name and symbol the Launcher accepts, made of
    ///      the characters that grow the most when escaped, must still come through in the creation event.
    function test_13_descriptionFitsThePortalLimitsAtTheLongestNameAndSymbol() public {
        _open();
        RaidPassConfig memory c = _config("raid-description");
        bytes memory longName = new bytes(64);
        bytes memory longSymbol = new bytes(32);
        for (uint256 i; i < longName.length; ++i) {
            longName[i] = 0x01; // a control character: six bytes once escaped
        }
        for (uint256 i; i < longSymbol.length; ++i) {
            longSymbol[i] = 0x01;
        }
        c.name = string(longName);
        c.symbol = string(longSymbol);

        vm.recordLogs();
        address launcherAddr = _newLauncher(address(factory), abi.encode(c));
        Vm.Log[] memory creation = vm.getRecordedLogs();
        RaidPassLauncher launcher = RaidPassLauncher(launcherAddr);

        uint256 gasBefore = gasleft();
        string memory d = launcher.description();
        uint256 gasUsed = gasBefore - gasleft();

        assertEq(_launcherDescriptionFromLogs(creation, launcherAddr), d, "the Portal kept the whole description");
        assertGt(bytes(d).length, 0);
        assertLt(bytes(d).length, 4096 / 2, "under half of the Portal's 4,096-byte limit");
        assertLt(gasUsed, 200_000 / 2, "under half of the Portal's 200,000 gas limit");
        emit log_named_uint("longest description, bytes", bytes(d).length);
        emit log_named_uint("description() gas", gasUsed);

        // One byte more is refused.
        c.name = string(new bytes(65));
        c.salt = _mineSalt("raid-description-long-name");
        _expectInvalid(c);
        c.name = "Raid Example";
        c.symbol = string(new bytes(33));
        _expectInvalid(c);
        c.symbol = "RAIDX";
        c.meta = string(new bytes(129));
        _expectInvalid(c);
    }

    function test_14_onlyThePortalDeliversTheHoldersSupplyAndOnlyDuringTheLaunch() public {
        _open();
        RaidPassLauncher launcher = _create("raid-distribution");
        uint256 amount = launcher.holderPool();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LauncherBase.NotHub.selector, alice));
        launcher.initializeDistribution(address(1), amount, "", bytes32(0));

        // Even the Portal cannot call it outside the launch.
        vm.prank(portalAddr);
        vm.expectRevert(RaidPassLauncher.UnauthorizedDistribution.selector);
        launcher.initializeDistribution(address(1), amount, "", bytes32(0));
    }

    function test_15_aGuardianUpgradeKeepsEveryLaunchersState() public {
        _open();
        RaidPassLauncher launcher = _create("raid-upgrade");
        assertEq(factory.launcherCount(), 1);
        assertEq(factory.launchers(0), address(launcher), "the factory lists its Launchers");
        assertEq(launcher.version(), "1.0.0");

        vm.prank(alice);
        launcher.mint{value: 3 * PRICE}();

        // The Guardian retargets the beacon to a fresh implementation in the middle of the mint.
        address impl = address(new RaidPassLauncher());
        vm.prank(guardian);
        factory.upgradeVaultImplementation(impl);
        assertEq(factory.beaconImplementation(), impl);

        assertEq(launcher.minted(), 3, "minted survives");
        assertEq(launcher.raised(), 3 * PRICE, "raised survives");
        assertEq(launcher.ownerOf(2), alice, "ownership survives");
        assertEq(launcher.nftsOf(alice).length, 3, "the ownership index survives");
        assertEq(launcher.cap(), PRICE * NFTS, "config survives");
        assertEq(address(launcher).balance, 3 * PRICE, "the raise is untouched");

        // The mint carries on to the launch and the claims.
        vm.prank(bob);
        launcher.mint{value: 7 * PRICE}();
        assertTrue(launcher.launched());
        vm.prank(alice);
        launcher.claim();
        assertEq(IERC20(launcher.token()).balanceOf(alice), 3 * launcher.tokensPerNFT());
    }

    /// @dev BNB Chain rejects any transaction above 16,777,216 gas (BEP-652, live since the Mendel upgrade). The
    ///      heaviest RaidPass transaction is the mint that buys the per-call maximum and also runs the launch.
    ///      Run with `forge test --isolate` so each call is metered as its own transaction.
    function test_12_theHeaviestTransactionsFitTheGasCap() public {
        uint256 txGasCap = 16_777_216;
        _open();

        RaidPassConfig memory c = _config("raid-gas");
        c.nftPrice = 0.1 ether;
        c.cap = 7 ether; // 70 NFTs
        RaidPassLauncher launcher = RaidPassLauncher(_newLauncher(address(factory), abi.encode(c)));

        vm.prank(alice);
        launcher.mint{value: 10 * c.nftPrice}();

        // 60 are left: more than the per-call maximum is refused.
        uint256 perCall = launcher.MAX_MINT_PER_TX();
        vm.prank(bob);
        vm.expectRevert(RaidPassLauncher.MintTooLarge.selector);
        launcher.mint{value: (perCall + 1) * c.nftPrice}();

        vm.prank(alice);
        launcher.mint{value: 10 * c.nftPrice}();
        vm.prank(bob);
        launcher.mint{value: perCall * c.nftPrice}();
        uint256 launchGas = vm.lastCallGas().gasTotalUsed;
        assertTrue(launcher.launched(), "the largest mint also launched");
        assertLt(launchGas, txGasCap * 3 / 4, "largest mint + launch leaves a quarter of the cap spare");

        vm.prank(bob);
        launcher.claim();
        uint256 claimGas = vm.lastCallGas().gasTotalUsed;
        assertLt(claimGas, txGasCap / 4, "claiming a full mint call's NFTs is far below the cap");

        emit log_named_uint("mint 50 NFTs + launch, gas", launchGas);
        emit log_named_uint("claim 50 NFTs, gas", claimGas);
    }
}
