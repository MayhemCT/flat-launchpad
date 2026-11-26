// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";

import {RaidPassCurve, RaidPassCurveConfig, RaidPassCurveInfo, IBondingCurvePortal} from "src/raidpass/RaidPassCurve.sol";
import {RaidPassCurveFactory} from "src/raidpass/RaidPassCurveFactory.sol";

/// @notice RaidPassCurve against Flap's live bonding curve Portal on a fork of BNB Chain. Nothing is pranked on
///         the Portal: this is the same permissionless path a real deployment uses. Needs BSC_RPC_URL.
contract RaidPassCurveBSCForkTest is Test {
    address internal constant PORTAL = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;
    address internal constant TAX_TOKEN_V3_IMPL = 0x024f18294970B5c76c0691b87f138A0317156422;

    uint256 internal constant PRICE = 0.01 ether;
    uint256 internal constant PASSES = 10;

    RaidPassCurveFactory internal factory;
    address internal creator = address(uint160(0xC0DE0001));
    address internal alice = address(uint160(0xC0DE0002));
    address internal bob = address(uint160(0xC0DE0003));
    uint256 internal saltCounter;

    function setUp() public {
        string memory rpcUrl = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpcUrl);
        require(block.chainid == 56, "BSC_RPC_URL is not BNB Chain");
        vm.deal(creator, 1 ether);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        factory = new RaidPassCurveFactory(PORTAL);
    }

    function _mineSalt(bytes32 seed) internal returns (bytes32 salt) {
        uint256 start = ++saltCounter << 128;
        for (uint256 i = start;; ++i) {
            salt = keccak256(abi.encode(seed, i));
            if (uint16(uint160(ClonesUpgradeable.predictDeterministicAddress(TAX_TOKEN_V3_IMPL, salt, PORTAL))) == 0x7777) {
                return salt;
            }
        }
    }

    function _config(bytes32 seed) internal returns (RaidPassCurveConfig memory c) {
        c.name = "Raid Example";
        c.symbol = "RAIDX";
        c.meta = "bafkreig4y5nwb4izyilbbmiydumvkld446d4k7j4ohg3x3q2lfel3fo4yq";
        c.salt = _mineSalt(seed);
        c.mintPrice = PRICE;
        c.maxPasses = PASSES;
        c.saleDuration = 1 days;
    }

    function _create(RaidPassCurveConfig memory c) internal returns (RaidPassCurve mint) {
        uint256 fee = IBondingCurvePortal(PORTAL).SALT_LOCK_FEE();
        vm.prank(creator);
        mint = RaidPassCurve(payable(factory.create{value: fee}(c)));
    }

    function _ids(uint256 from, uint256 to) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](to - from + 1);
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = from + i;
        }
    }

    function test_01_fullJourneyOnTheBondingCurve() public {
        RaidPassCurveConfig memory c = _config("curve-journey");
        address predicted = factory.predict(creator, c.salt);
        RaidPassCurve mint = _create(c);

        assertEq(address(mint), predicted, "the mint address is known before creation");
        assertEq(mint.creator(), creator);
        assertEq(mint.targetRaise(), PRICE * PASSES);
        assertEq(mint.name(), "Raid Example RaidPass");
        assertEq(factory.mintCount(), 1);

        // Alice mints 4 passes and sells one to Bob before the launch.
        vm.prank(alice);
        mint.mint{value: 4 * PRICE}();
        assertFalse(mint.launched(), "not sold out yet");
        vm.prank(alice);
        mint.transferFrom(alice, bob, 4);
        vm.prank(alice);
        vm.expectRevert(RaidPassCurve.NotLaunched.selector);
        mint.claim();

        // Bob mints the last 6: that mint creates the token and buys on the curve with the whole raise.
        vm.prank(bob);
        mint.mint{value: 6 * PRICE}();

        assertTrue(mint.launched(), "the mint that sold the last pass launched the token");
        address token = mint.token();
        assertTrue(token.code.length > 0, "token deployed");
        assertEq(uint16(uint160(token)), 0x7777, "vanity suffix");
        assertEq(token, ClonesUpgradeable.predictDeterministicAddress(TAX_TOKEN_V3_IMPL, c.salt, PORTAL));

        uint256 share = mint.tokensPerPass();
        uint256 bnbShare = mint.bnbPerPass();
        assertGt(share, 0, "the raise bought tokens on the curve");
        assertGe(IERC20(token).balanceOf(address(mint)), share * PASSES, "the mint holds every pass's share");
        assertEq(address(mint).balance, bnbShare * PASSES + address(mint).balance % PASSES, "only unspent BNB is left");

        RaidPassCurveInfo memory i = mint.info();
        assertTrue(i.launched);
        assertEq(i.token, token);
        assertEq(i.minted, PASSES);

        // Each pass claims an equal share, once, to whoever holds it.
        assertEq(mint.claimableOf(alice), 3 * share);
        assertEq(mint.claimableOf(bob), 7 * share);
        uint256 aliceBnb = alice.balance;
        vm.prank(alice);
        mint.claimPasses(_ids(1, 1));
        vm.prank(alice);
        mint.claim();
        assertEq(IERC20(token).balanceOf(alice), 3 * share, "alice holds 3 passes");
        assertEq(alice.balance, aliceBnb + 3 * bnbShare);
        vm.prank(bob);
        mint.claim();
        assertEq(IERC20(token).balanceOf(bob), 7 * share, "bob holds 7 passes, one bought from alice");

        // A pass claims once and stays with its holder.
        vm.prank(alice);
        vm.expectRevert(RaidPassCurve.NothingToClaim.selector);
        mint.claim();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaidPassCurve.PassAlreadyClaimed.selector, 1));
        mint.claimPasses(_ids(1, 1));
        assertEq(mint.ownerOf(2), alice);

        // The mint is over and nothing can be refunded.
        vm.prank(bob);
        vm.expectRevert(RaidPassCurve.AlreadyLaunched.selector);
        mint.mint{value: PRICE}();
        assertFalse(mint.refundAvailable());

        emit log_named_uint("tokens per pass (wei)", share);
        emit log_named_uint("unspent BNB per pass (wei)", bnbShare);
    }

    function test_02_burnToRefundWhenTheMintDoesNotSellOut() public {
        RaidPassCurve mint = _create(_config("curve-refund"));

        vm.prank(alice);
        mint.mint{value: 4 * PRICE}();
        vm.prank(alice);
        mint.transferFrom(alice, bob, 3);

        vm.prank(alice);
        vm.expectRevert(RaidPassCurve.RefundUnavailable.selector);
        mint.refund();

        vm.warp(mint.saleDeadline());
        assertEq(mint.refundableOf(alice), 3 * PRICE);

        vm.prank(alice);
        mint.refundPasses(_ids(1, 1));
        vm.prank(alice);
        mint.refund();
        assertEq(alice.balance, 10 ether - PRICE, "alice got three of her four mint prices back");
        vm.prank(bob);
        mint.refund();
        assertEq(bob.balance, 10 ether + PRICE, "the refund follows the pass");

        assertEq(mint.raised(), 0);
        assertEq(address(mint).balance, 0);
        assertFalse(mint.launched());
    }

    function test_03_guards() public {
        RaidPassCurve mint = _create(_config("curve-guards"));

        vm.startPrank(alice);
        vm.expectRevert(RaidPassCurve.ZeroQuantity.selector);
        mint.mint();
        vm.expectRevert(abi.encodeWithSelector(RaidPassCurve.WrongPayment.selector, PRICE + 1, PRICE));
        mint.mint{value: PRICE + 1}();
        vm.expectRevert(RaidPassCurve.SoldOut.selector);
        mint.mint{value: 11 * PRICE}();
        vm.stopPrank();

        // BNB cannot be sent to the mint directly.
        vm.prank(alice);
        (bool ok,) = address(mint).call{value: 1 ether}("");
        assertFalse(ok, "direct payments are rejected");

        // The clone and the implementation cannot be initialized again.
        RaidPassCurveConfig memory c = _config("curve-reinit");
        vm.expectRevert();
        mint.initialize(PORTAL, alice, c);
        RaidPassCurve impl = RaidPassCurve(payable(factory.implementation()));
        vm.expectRevert();
        impl.initialize(PORTAL, alice, c);

        // Invalid configs are rejected.
        uint256 fee = IBondingCurvePortal(PORTAL).SALT_LOCK_FEE();
        c.maxPasses = 10_001;
        vm.prank(creator);
        vm.expectRevert(RaidPassCurve.InvalidConfig.selector);
        factory.create{value: fee}(c);

        vm.warp(mint.saleDeadline());
        vm.prank(alice);
        vm.expectRevert(RaidPassCurve.SaleClosed.selector);
        mint.mint{value: PRICE}();
    }

    /// @dev BNB Chain rejects any transaction above 16,777,216 gas. Run with `forge test --isolate`.
    function test_04_theHeaviestTransactionFitsTheGasCap() public {
        RaidPassCurveConfig memory c = _config("curve-gas");
        c.maxPasses = 60;
        RaidPassCurve mint = _create(c);

        vm.prank(alice);
        mint.mint{value: 10 * PRICE}();
        vm.prank(bob);
        mint.mint{value: 50 * PRICE}();
        uint256 launchGas = vm.lastCallGas().gasTotalUsed;
        assertTrue(mint.launched());
        assertLt(launchGas, 16_777_216 * 3 / 4, "largest mint + launch leaves a quarter of the cap spare");
        emit log_named_uint("mint 50 passes + curve launch, gas", launchGas);
    }
}
