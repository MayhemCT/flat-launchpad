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
    uint256 internal constant NFTS = 10;

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
        vm.deal(alice, 20 ether);
        vm.deal(bob, 20 ether);
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
        c.nftPrice = PRICE;
        c.cap = PRICE * NFTS;
        c.saleDuration = 1 days;
        c.buyTaxBps = 300;
        c.sellTaxBps = 500;
    }

    function _create(RaidPassCurveConfig memory c) internal returns (RaidPassCurve mint) {
        uint256 fee = IBondingCurvePortal(PORTAL).SALT_LOCK_FEE();
        vm.prank(creator);
        mint = RaidPassCurve(payable(factory.create{value: fee}(c)));
    }

    function _expectInvalid(RaidPassCurveConfig memory c) internal {
        uint256 fee = IBondingCurvePortal(PORTAL).SALT_LOCK_FEE();
        vm.prank(creator);
        vm.expectRevert(RaidPassCurve.InvalidConfig.selector);
        factory.create{value: fee}(c);
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
        assertEq(mint.cap(), PRICE * NFTS);
        assertEq(mint.targetRaise(), PRICE * NFTS);
        assertEq(mint.maxNFTs(), NFTS, "cap / nftPrice NFTs are for sale");
        assertEq(mint.name(), "Raid Example RaidPass");
        assertEq(factory.mintCount(), 1);

        // Alice mints 4 NFTs and sells one to Bob before the launch.
        vm.prank(alice);
        mint.mint{value: 4 * PRICE}();
        assertFalse(mint.launched(), "cap not reached yet");
        vm.prank(alice);
        mint.transferFrom(alice, bob, 4);
        vm.prank(alice);
        vm.expectRevert(RaidPassCurve.NotLaunched.selector);
        mint.claim();

        // Bob mints the last 6: that mint creates the token and buys on the curve with the whole raise.
        vm.prank(bob);
        mint.mint{value: 6 * PRICE}();

        assertTrue(mint.launched(), "the mint that reached the cap launched the token");
        address token = mint.token();
        assertTrue(token.code.length > 0, "token deployed");
        assertEq(uint16(uint160(token)), 0x7777, "vanity suffix");
        assertEq(token, ClonesUpgradeable.predictDeterministicAddress(TAX_TOKEN_V3_IMPL, c.salt, PORTAL));

        uint256 share = mint.tokensPerNFT();
        uint256 bnbShare = mint.bnbPerNFT();
        assertGt(share, 0, "the raise bought tokens on the curve");
        assertGe(IERC20(token).balanceOf(address(mint)), share * NFTS, "the mint holds every NFT's share");
        assertLt(address(mint).balance - bnbShare * NFTS, NFTS, "only unspent BNB (and rounding dust) is left");

        RaidPassCurveInfo memory i = mint.info();
        assertTrue(i.launched);
        assertEq(i.token, token);
        assertEq(i.minted, NFTS);
        assertEq(i.buyTaxBps, 300);
        assertEq(i.sellTaxBps, 500);

        // Each NFT claims an equal share, once, to whoever holds it.
        assertEq(mint.claimableOf(alice), 3 * share);
        assertEq(mint.claimableOf(bob), 7 * share);
        uint256 aliceBnb = alice.balance;
        vm.prank(alice);
        mint.claimNFTs(_ids(1, 1));
        vm.prank(alice);
        mint.claim();
        assertEq(IERC20(token).balanceOf(alice), 3 * share, "alice holds 3 NFTs");
        assertEq(alice.balance, aliceBnb + 3 * bnbShare);
        vm.prank(bob);
        mint.claim();
        assertEq(IERC20(token).balanceOf(bob), 7 * share, "bob holds 7 NFTs, one bought from alice");

        // An NFT claims once and stays with its holder.
        vm.prank(alice);
        vm.expectRevert(RaidPassCurve.NothingToClaim.selector);
        mint.claim();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaidPassCurve.AlreadyClaimed.selector, 1));
        mint.claimNFTs(_ids(1, 1));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaidPassCurve.NotHolder.selector, 5));
        mint.claimNFTs(_ids(5, 5));
        assertEq(mint.ownerOf(2), alice);
        assertEq(mint.nftsOf(alice).length, 3);

        // The mint is over and nothing can be refunded.
        vm.prank(bob);
        vm.expectRevert(RaidPassCurve.AlreadyLaunched.selector);
        mint.mint{value: PRICE}();
        assertFalse(mint.refundAvailable());

        emit log_named_uint("tokens per NFT (wei)", share);
        emit log_named_uint("unspent BNB per NFT (wei)", bnbShare);
    }

    function test_02_overflowOnTheLastMintIsRefunded() public {
        RaidPassCurve mint = _create(_config("curve-overflow"));

        vm.prank(alice);
        mint.mint{value: 8 * PRICE}();

        // Bob asks for 5 but only 2 are left: he gets 2, the launch runs, and 3 prices come back.
        uint256 before_ = bob.balance;
        vm.prank(bob);
        mint.mint{value: 5 * PRICE}();

        assertEq(mint.balanceOf(bob), 2, "bob got what was left");
        assertEq(bob.balance, before_ - 2 * PRICE, "bob paid for 2 and got the rest back");
        assertEq(mint.minted(), NFTS);
        assertEq(mint.raised(), PRICE * NFTS, "the raise landed exactly on the cap");
        assertTrue(mint.launched(), "the overflowing mint still launched");
        // Bob's change was not counted as unspent launch BNB.
        assertEq(mint.bnbPerNFT(), 0);
        assertLt(address(mint).balance, NFTS);
    }

    function test_03_burnToRefundWhenTheCapIsMissed() public {
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
        vm.expectRevert(abi.encodeWithSelector(RaidPassCurve.NotHolder.selector, 3));
        mint.refundNFTs(_ids(3, 3));
        vm.prank(alice);
        mint.refundNFTs(_ids(1, 1));
        vm.prank(alice);
        mint.refund();
        assertEq(alice.balance, 20 ether - PRICE, "alice got three of her four prices back");
        vm.prank(bob);
        mint.refund();
        assertEq(bob.balance, 20 ether + PRICE, "the refund follows the NFT");

        assertEq(mint.burned(), 4);
        assertEq(mint.raised(), 0);
        assertEq(address(mint).balance, 0);
        assertFalse(mint.launched());
        vm.prank(alice);
        vm.expectRevert(RaidPassCurve.NothingToRefund.selector);
        mint.refund();
    }

    function test_04_configRules() public {
        // The cap is at most 10 BNB.
        RaidPassCurveConfig memory c = _config("curve-config");
        c.nftPrice = 1 ether;
        c.cap = 11 ether;
        _expectInvalid(c);

        // The cap is an exact multiple of the price.
        c.cap = 1.5 ether;
        _expectInvalid(c);

        // Taxes stay inside Flap's range for a tax token on the curve.
        c.cap = 10 ether;
        c.buyTaxBps = 99;
        _expectInvalid(c);
        c.buyTaxBps = 300;
        c.sellTaxBps = 1001;
        _expectInvalid(c);

        // The mint window is bounded.
        c.sellTaxBps = 500;
        c.saleDuration = 60;
        _expectInvalid(c);

        // A 10 BNB cap is accepted.
        c.saleDuration = 1 days;
        RaidPassCurve mint = _create(c);
        assertEq(mint.maxNFTs(), 10);
    }

    function test_05_thePortalAcceptsBothEndsOfTheTaxRange() public {
        RaidPassCurveConfig memory low = _config("curve-tax-low");
        low.buyTaxBps = 100;
        low.sellTaxBps = 100;
        RaidPassCurve a = _create(low);
        vm.prank(alice);
        a.mint{value: NFTS * PRICE}();
        assertTrue(a.launched(), "1% taxes launch");

        RaidPassCurveConfig memory high = _config("curve-tax-high");
        high.buyTaxBps = 1000;
        high.sellTaxBps = 1000;
        RaidPassCurve b = _create(high);
        vm.prank(bob);
        b.mint{value: NFTS * PRICE}();
        assertTrue(b.launched(), "10% taxes launch");
    }

    function test_06_guards() public {
        RaidPassCurve mint = _create(_config("curve-guards"));

        vm.startPrank(alice);
        vm.expectRevert(RaidPassCurve.ZeroQuantity.selector);
        mint.mint();
        vm.expectRevert(abi.encodeWithSelector(RaidPassCurve.WrongPayment.selector, PRICE + 1, PRICE));
        mint.mint{value: PRICE + 1}();
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

        vm.warp(mint.saleDeadline());
        vm.prank(alice);
        vm.expectRevert(RaidPassCurve.SaleClosed.selector);
        mint.mint{value: PRICE}();
    }

    /// @dev BNB Chain rejects any transaction above 16,777,216 gas. Run with `forge test --isolate`.
    function test_07_theHeaviestTransactionFitsTheGasCap() public {
        RaidPassCurveConfig memory c = _config("curve-gas");
        c.cap = 70 * PRICE;
        RaidPassCurve mint = _create(c);

        vm.prank(alice);
        mint.mint{value: 10 * PRICE}();
        // 60 are left: more than the per-call maximum is refused.
        vm.prank(bob);
        vm.expectRevert(RaidPassCurve.MintTooLarge.selector);
        mint.mint{value: 51 * PRICE}();

        vm.prank(alice);
        mint.mint{value: 10 * PRICE}();
        vm.prank(bob);
        mint.mint{value: 50 * PRICE}();
        uint256 launchGas = vm.lastCallGas().gasTotalUsed;
        assertTrue(mint.launched());
        assertLt(launchGas, 16_777_216 * 3 / 4, "largest mint + launch leaves a quarter of the cap spare");
        emit log_named_uint("mint 50 NFTs + curve launch, gas", launchGas);
    }
}
