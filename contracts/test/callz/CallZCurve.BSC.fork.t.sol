// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";

import {CallZCurve, CallZCurveConfig, CallZCurveInfo, IBondingCurvePortal} from "src/callz/CallZCurve.sol";
import {CallZCurveFactory} from "src/callz/CallZCurveFactory.sol";
import {IDividend} from "src/flap/IDividend.sol";

/// @dev Trading on Flap's bonding curve, for the tests that need taxed trades.
interface ICurveSwap {
    struct ExactInputParams {
        address inputToken; // address(0) = BNB
        address outputToken;
        uint256 inputAmount;
        uint256 minOutputAmount;
        bytes permitData;
    }

    function swapExactInput(ExactInputParams calldata params) external payable returns (uint256 outputAmount);
}

interface ICurveTaxToken {
    function dividendContract() external view returns (address);
    function taxProcessor() external view returns (address);
}

interface ICurveTaxProcessor {
    function dispatch() external;
    function pendingDividendQuoteTokenBalance() external view returns (uint256);
}

/// @notice CallZCurve against Flap's live bonding curve Portal on a fork of BNB Chain. Nothing is pranked on
///         the Portal: this is the same permissionless path a real deployment uses. Needs BSC_RPC_URL.
contract CallZCurveBSCForkTest is Test {
    address internal constant PORTAL = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;
    address internal constant TAX_TOKEN_V3_IMPL = 0x024f18294970B5c76c0691b87f138A0317156422;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    uint256 internal constant PRICE = 0.01 ether;
    uint256 internal constant NFTS = 10;

    CallZCurveFactory internal factory;
    address internal creator = address(uint160(0xC0DE0001));
    address internal alice = address(uint160(0xC0DE0002));
    address internal bob = address(uint160(0xC0DE0003));
    address internal trader = address(uint160(0xC0DE0004));
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
        vm.deal(trader, 20 ether);
        factory = new CallZCurveFactory(PORTAL);
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

    function _config(bytes32 seed) internal returns (CallZCurveConfig memory c) {
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

    function _create(CallZCurveConfig memory c) internal returns (CallZCurve mint) {
        uint256 fee = IBondingCurvePortal(PORTAL).SALT_LOCK_FEE();
        vm.prank(creator);
        mint = CallZCurve(payable(factory.create{value: fee}(c)));
    }

    function _expectInvalid(CallZCurveConfig memory c) internal {
        uint256 fee = IBondingCurvePortal(PORTAL).SALT_LOCK_FEE();
        vm.prank(creator);
        vm.expectRevert(CallZCurve.InvalidConfig.selector);
        factory.create{value: fee}(c);
    }

    function _ids(uint256 from, uint256 to) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](to - from + 1);
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = from + i;
        }
    }

    /// @dev A mint of 10 NFTs that has launched: Alice minted NFTs 1 to 4 and Bob NFTs 5 to 10.
    function _launched(bytes32 seed) internal returns (CallZCurve mint) {
        mint = _create(_config(seed));
        vm.prank(alice);
        mint.mint{value: 4 * PRICE}();
        vm.prank(bob);
        mint.mint{value: 6 * PRICE}();
        assertTrue(mint.launched(), "the mint launched");
    }

    /// @dev The trader buys on the curve and sells half back, twice, then the tax is dispatched: the dividend
    ///      part of the buy and sell tax reaches the token's dividend contract.
    function _tradeAndDispatch(address token) internal {
        vm.startPrank(trader);
        for (uint256 i; i < 2; ++i) {
            uint256 got = ICurveSwap(PORTAL).swapExactInput{value: 0.5 ether}(
                ICurveSwap.ExactInputParams(address(0), token, 0.5 ether, 0, "")
            );
            IERC20(token).approve(PORTAL, got / 2);
            ICurveSwap(PORTAL).swapExactInput(ICurveSwap.ExactInputParams(token, address(0), got / 2, 0, ""));
        }
        vm.stopPrank();
        ICurveTaxProcessor(ICurveTaxToken(token).taxProcessor()).dispatch();
    }

    function test_01_fullJourneyOnTheBondingCurve() public {
        CallZCurveConfig memory c = _config("curve-journey");
        address predicted = factory.predict(creator, c.salt);
        CallZCurve mint = _create(c);

        assertEq(address(mint), predicted, "the mint address is known before creation");
        assertEq(mint.creator(), creator);
        assertEq(mint.cap(), PRICE * NFTS);
        assertEq(mint.targetRaise(), PRICE * NFTS);
        assertEq(mint.maxNFTs(), NFTS, "cap / nftPrice NFTs are for sale");
        assertEq(mint.name(), "Raid Example CallZ Pass");
        assertEq(factory.mintCount(), 1);

        // Alice mints 4 NFTs and sells one to Bob before the launch.
        vm.prank(alice);
        mint.mint{value: 4 * PRICE}();
        assertFalse(mint.launched(), "cap not reached yet");
        vm.prank(alice);
        mint.transferFrom(alice, bob, 4);
        vm.prank(alice);
        vm.expectRevert(CallZCurve.NotLaunched.selector);
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

        CallZCurveInfo memory i = mint.info();
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
        vm.expectRevert(CallZCurve.NothingToClaim.selector);
        mint.claim();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallZCurve.AlreadyClaimed.selector, 1));
        mint.claimNFTs(_ids(1, 1));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallZCurve.NotHolder.selector, 5));
        mint.claimNFTs(_ids(5, 5));
        assertEq(mint.ownerOf(2), alice);
        assertEq(mint.nftsOf(alice).length, 3);

        // The mint is over and nothing can be refunded.
        vm.prank(bob);
        vm.expectRevert(CallZCurve.AlreadyLaunched.selector);
        mint.mint{value: PRICE}();
        assertFalse(mint.refundAvailable());

        emit log_named_uint("tokens per NFT (wei)", share);
        emit log_named_uint("unspent BNB per NFT (wei)", bnbShare);
    }

    function test_02_overflowOnTheLastMintIsRefunded() public {
        CallZCurve mint = _create(_config("curve-overflow"));

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
        CallZCurve mint = _create(_config("curve-refund"));

        vm.prank(alice);
        mint.mint{value: 4 * PRICE}();
        vm.prank(alice);
        mint.transferFrom(alice, bob, 3);

        vm.prank(alice);
        vm.expectRevert(CallZCurve.RefundUnavailable.selector);
        mint.refund();

        vm.warp(mint.saleDeadline());
        assertEq(mint.refundableOf(alice), 3 * PRICE);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallZCurve.NotHolder.selector, 3));
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
        vm.expectRevert(CallZCurve.NothingToRefund.selector);
        mint.refund();
    }

    function test_04_configRules() public {
        // The cap is at most 10 BNB.
        CallZCurveConfig memory c = _config("curve-config");
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
        CallZCurve mint = _create(c);
        assertEq(mint.maxNFTs(), 10);
    }

    function test_05_thePortalAcceptsBothEndsOfTheTaxRange() public {
        CallZCurveConfig memory low = _config("curve-tax-low");
        low.buyTaxBps = 100;
        low.sellTaxBps = 100;
        CallZCurve a = _create(low);
        vm.prank(alice);
        a.mint{value: NFTS * PRICE}();
        assertTrue(a.launched(), "1% taxes launch");

        CallZCurveConfig memory high = _config("curve-tax-high");
        high.buyTaxBps = 1000;
        high.sellTaxBps = 1000;
        CallZCurve b = _create(high);
        vm.prank(bob);
        b.mint{value: NFTS * PRICE}();
        assertTrue(b.launched(), "10% taxes launch");
    }

    function test_06_guards() public {
        CallZCurve mint = _create(_config("curve-guards"));

        vm.startPrank(alice);
        vm.expectRevert(CallZCurve.ZeroQuantity.selector);
        mint.mint();
        vm.expectRevert(abi.encodeWithSelector(CallZCurve.WrongPayment.selector, PRICE + 1, PRICE));
        mint.mint{value: PRICE + 1}();
        vm.stopPrank();

        // BNB cannot be sent to the mint directly.
        vm.prank(alice);
        (bool ok,) = address(mint).call{value: 1 ether}("");
        assertFalse(ok, "direct payments are rejected");

        // The clone and the implementation cannot be initialized again.
        CallZCurveConfig memory c = _config("curve-reinit");
        vm.expectRevert();
        mint.initialize(PORTAL, alice, c);
        CallZCurve impl = CallZCurve(payable(factory.implementation()));
        vm.expectRevert();
        impl.initialize(PORTAL, alice, c);

        vm.warp(mint.saleDeadline());
        vm.prank(alice);
        vm.expectRevert(CallZCurve.SaleClosed.selector);
        mint.mint{value: PRICE}();
    }

    /// @dev BNB Chain rejects any transaction above 16,777,216 gas. Run with `forge test --isolate`.
    function test_07_theHeaviestTransactionFitsTheGasCap() public {
        CallZCurveConfig memory c = _config("curve-gas");
        c.cap = 70 * PRICE;
        CallZCurve mint = _create(c);

        vm.prank(alice);
        mint.mint{value: 10 * PRICE}();
        // 60 are left: more than the per-call maximum is refused.
        vm.prank(bob);
        vm.expectRevert(CallZCurve.MintTooLarge.selector);
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

    /// @dev Until an NFT claims, its tokens are held by the mint, and the mint is a holder like any other: the
    ///      token pays it BNB dividends. They belong to the NFTs that have not claimed, and nothing stays behind.
    function test_08_dividendsOfUnclaimedTokensArePaidToTheirNFTs() public {
        CallZCurve mint = _launched("curve-dividends");
        address token = mint.token();
        IDividend dividend = IDividend(mint.dividend());
        uint256 bnbShare = mint.bnbPerNFT();

        assertEq(address(dividend), ICurveTaxToken(token).dividendContract(), "the token's dividend contract");
        assertEq(mint.wbnb(), WBNB, "dividends are held as WBNB");
        assertEq(dividend.dividendToken(), WBNB, "the token pays its dividends in BNB");
        assertFalse(dividend.excludedFromDividends(address(mint)), "the mint is not excluded from dividends");
        (uint256 share,,) = dividend.userInfo(address(mint));
        assertEq(share, IERC20(token).balanceOf(address(mint)), "the mint's dividend share is the tokens it holds");
        assertEq(dividend.totalShares(), share, "at launch the unclaimed NFTs are the only holders");

        // Taxed trading on the curve: the mint earns dividends on the tokens of the unclaimed NFTs.
        _tradeAndDispatch(token);
        uint256 earned = dividend.withdrawableDividendOf(address(mint));
        assertGt(earned, 0, "the tokens of unclaimed NFTs earn dividends");

        // Alice claims her 4 NFTs: they are paid 4/10 of the dividends, in BNB, with their tokens.
        uint256 alicePart = earned * 4 / NFTS;
        assertEq(mint.claimableBnbOf(alice), 4 * bnbShare + alicePart, "alice's claimable BNB");
        uint256 before_ = alice.balance;
        vm.prank(alice);
        mint.claim();
        assertEq(alice.balance - before_, 4 * bnbShare + alicePart, "4 of 10 NFTs are paid 4/10 of the dividends");
        assertEq(IERC20(token).balanceOf(alice), 4 * mint.tokensPerNFT(), "alice's tokens came with them");
        assertEq(mint.claimedCount(), 4);
        assertEq(dividend.withdrawableDividendOf(address(mint)), 0, "the claim collected what the mint had earned");
        assertEq(IERC20(WBNB).balanceOf(address(mint)), earned - alicePart, "the rest waits for the 6 other NFTs");
        assertEq(mint.claimableBnbOf(alice), 0, "an NFT is paid once");

        // More trading. Anyone can make the dividend contract push the mint's dividends, and it pushes WBNB.
        _tradeAndDispatch(token);
        uint256 more = dividend.withdrawableDividendOf(address(mint));
        assertGt(more, 0, "the 6 unclaimed NFTs keep earning");
        address[] memory holders = new address[](1);
        holders[0] = address(mint);
        vm.prank(trader);
        dividend.distributeDividend(holders);
        uint256 held = IERC20(WBNB).balanceOf(address(mint));
        assertEq(held, earned - alicePart + more, "a stranger's push lands in the mint as WBNB");

        // Bob claims the last 6 NFTs: they take everything that is left.
        assertEq(mint.claimableBnbOf(bob), 6 * bnbShare + held, "bob's claimable BNB");
        before_ = bob.balance;
        vm.prank(bob);
        mint.claimNFTs(_ids(5, 10));
        assertEq(bob.balance - before_, 6 * bnbShare + held, "the last NFTs are paid all the dividends left");
        assertEq(IERC20(WBNB).balanceOf(address(mint)), 0, "no WBNB is left in the mint");
        assertEq(dividend.withdrawableDividendOf(address(mint)), 0, "no dividends are left for the mint to collect");
        assertLt(address(mint).balance, NFTS, "only rounding dust of the unspent BNB is left in the mint");

        // With every NFT claimed the mint holds no share, so nothing can accrue to it again.
        (share,,) = dividend.userInfo(address(mint));
        assertEq(share, 0, "the mint is no longer a holder");
        _tradeAndDispatch(token);
        assertEq(dividend.withdrawableDividendOf(address(mint)), 0, "nothing accrues to the mint after the last claim");
        assertGt(dividend.withdrawableDividendOf(alice), 0, "alice now earns on the tokens she claimed");

        // BNB still cannot be sent to the mint directly.
        vm.prank(alice);
        (bool ok,) = address(mint).call{value: 1 ether}("");
        assertFalse(ok, "direct payments are rejected after the launch too");
    }

    /// @dev The launch's own first buy is taxed, and the mint is the only holder when that tax is dispatched: the
    ///      dividend part of it comes back to the NFTs that paid for the buy.
    function test_09_theLaunchBuysDividendsComeBackToTheNFTs() public {
        CallZCurve mint = _launched("curve-launch-tax");
        address token = mint.token();
        IDividend dividend = IDividend(mint.dividend());
        ICurveTaxProcessor processor = ICurveTaxProcessor(ICurveTaxToken(token).taxProcessor());

        uint256 pending = processor.pendingDividendQuoteTokenBalance();
        assertGt(pending, 0, "the launch buy paid tax, and part of it is for dividends");
        processor.dispatch();
        uint256 earned = dividend.withdrawableDividendOf(address(mint));
        assertApproxEqAbs(earned, pending, 10, "the mint is the only holder, so all of it is the NFTs'");

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;
        vm.prank(alice);
        mint.claim();
        vm.prank(bob);
        mint.claim();
        uint256 bnbShare = mint.bnbPerNFT();
        assertEq(alice.balance - aliceBefore, 4 * bnbShare + earned * 4 / NFTS, "alice's 4 NFTs");
        assertEq(bob.balance - bobBefore, 6 * bnbShare + (earned - earned * 4 / NFTS), "bob's 6 NFTs take the rest");
        assertEq(IERC20(WBNB).balanceOf(address(mint)), 0, "no WBNB is left in the mint");
        assertEq(dividend.withdrawableDividendOf(address(mint)), 0, "no dividends are left for the mint to collect");
        emit log_named_uint("dividends returned to the NFTs (wei)", earned);
    }

    /// @dev Flap's dividend contract is not ours. If collecting from it ever fails, NFTs still claim their tokens,
    ///      and what could not be collected is paid with the next claim that can collect it.
    function test_10_aFailingDividendContractDoesNotBlockClaims() public {
        CallZCurve mint = _launched("curve-dividend-down");
        address token = mint.token();
        IDividend dividend = IDividend(mint.dividend());
        _tradeAndDispatch(token);
        uint256 earned = dividend.withdrawableDividendOf(address(mint));
        assertGt(earned, 0, "the mint has dividends to collect");

        // Fault injection: every call that collects the mint's dividends reverts.
        vm.mockCallRevert(
            address(dividend),
            abi.encodeWithSignature("withdrawDividendsFor(address,bool)", address(mint), false),
            "dividend contract down"
        );
        uint256 before_ = alice.balance;
        vm.prank(alice);
        mint.claim();
        assertEq(IERC20(token).balanceOf(alice), 4 * mint.tokensPerNFT(), "alice still claimed her tokens");
        assertEq(alice.balance - before_, 4 * mint.bnbPerNFT(), "no dividends could be collected for her");
        assertEq(dividend.withdrawableDividendOf(address(mint)), earned, "they are still the mint's to collect");

        vm.clearMockedCalls();
        before_ = bob.balance;
        vm.prank(bob);
        mint.claim();
        assertEq(bob.balance - before_, 6 * mint.bnbPerNFT() + earned, "the next claim collects and pays them");
        assertEq(IERC20(WBNB).balanceOf(address(mint)), 0, "no WBNB is left in the mint");
        assertEq(dividend.withdrawableDividendOf(address(mint)), 0, "no dividends are left for the mint to collect");
    }
}
