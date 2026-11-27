// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";

import {CallZPancake, CallZPancakeConfig} from "src/callz/CallZPancake.sol";
import {CallZPancakeFactory} from "src/callz/CallZPancakeFactory.sol";
import {CallZRouter} from "src/callz/CallZRouter.sol";
import {CallZVault, Submission} from "src/callz/CallZVault.sol";

interface IPancakeRouterView {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @notice CallZ's fees on a fork of BNB Chain: the 10% launch fee, the 2% trading fee through the CallZ router
///         (on a CallZ token and on two live Flap tax tokens, one pooled against BNB and one against USDT), and the
///         vault that splits and pays them: callout rounds, the snapshot of each caller's holdings, the 24-hour
///         claim window, and the team wallet being paid without sending a transaction.
///
///         Nothing is mocked: PancakeSwap, WBNB, USDT and the Flap tokens are the deployed ones.
///         Needs BSC_RPC_URL.
contract CallZFeesBSCForkTest is Test {
    address internal constant PANCAKE_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address internal constant PANCAKE_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    /// @dev Live Flap tax tokens that graduated to PancakeSwap: one pooled against BNB, one against USDT.
    address internal constant FLAP_BNB_TOKEN = 0x7C45614b3449CF2603262b3854C75A67d1517777;
    address internal constant FLAP_USDT_TOKEN = 0x4d1fC29De06b7a39bbeC1A3468104802d3277777;

    uint256 internal constant ATTESTER_KEY = 0xA77E57E12;
    uint256 internal constant DAY = 1 days;

    CallZVault internal vault;
    CallZRouter internal router;
    CallZPancakeFactory internal factory;

    address internal guardian = address(uint160(0xC0DE0011));
    address internal team = address(uint160(0xC0DE0012));
    address internal attester;
    address internal creator = address(uint160(0xC0DE0013));
    address internal alice = address(uint160(0xC0DE0014));
    address internal bob = address(uint160(0xC0DE0015));
    address internal carol = address(uint160(0xC0DE0016));
    uint256 internal nonce;

    function setUp() public {
        string memory rpcUrl = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpcUrl);
        require(block.chainid == 56, "BSC_RPC_URL is not BNB Chain");
        attester = vm.addr(ATTESTER_KEY);
        address[5] memory accounts = [team, creator, alice, bob, carol];
        for (uint256 i; i < accounts.length; ++i) {
            require(accounts[i].code.length == 0, "a test account has code on BNB Chain");
            vm.deal(accounts[i], 50 ether);
        }
        vault = new CallZVault(guardian, attester, team);
        router = new CallZRouter(PANCAKE_ROUTER, WBNB, address(vault), guardian, 200);
        factory = new CallZPancakeFactory(PANCAKE_FACTORY, WBNB, address(vault), guardian, 1000);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev A mint of 10 NFTs at 0.1 BNB, bought out by alice: launches a token with 1 BNB raised. Alice claims
    ///      her half of the supply.
    function _launch() internal returns (CallZPancake mint, address token) {
        CallZPancakeConfig memory c = CallZPancakeConfig({
            name: "Fee Test",
            symbol: "FEE",
            meta: "",
            nftPrice: 0.1 ether,
            cap: 1 ether,
            saleDuration: 1 days,
            poolShareBps: 5000
        });
        vm.prank(creator);
        mint = CallZPancake(factory.create(c, bytes32(++nonce)));
        vm.prank(alice);
        mint.mint{value: 1 ether}();
        token = mint.token();
        vm.prank(alice);
        mint.claim();
    }

    function _path(address a, address b) internal pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = a;
        path[1] = b;
    }

    function _path(address a, address b, address c) internal pure returns (address[] memory path) {
        path = new address[](3);
        path[0] = a;
        path[1] = b;
        path[2] = c;
    }

    /// @dev The market cap callouts are attested at unless a test says otherwise, in US dollars.
    uint256 internal mcap = 100_000;
    /// @dev What the attestation says the holder held when they posted. The default is what they hold right now.
    uint256 internal heldAtPost = type(uint256).max;

    function _attest(address holder, address token, uint8 kind, string memory link, uint256 key)
        internal
        returns (Submission memory s, bytes memory signature)
    {
        s = Submission({
            holder: holder,
            token: token,
            epoch: vault.currentEpoch(),
            kind: kind,
            linkHash: keccak256(bytes(link)),
            profileHash: bytes32(0),
            mcap: mcap,
            held: heldAtPost == type(uint256).max ? IERC20(token).balanceOf(holder) : heldAtPost,
            nonce: ++nonce,
            deadline: (vault.currentEpoch() + 1) * DAY
        });
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(key, vault.submissionDigest(s));
        signature = abi.encodePacked(r, sig, v);
    }

    function _submit(address holder, address token, uint8 kind, string memory link) internal {
        (Submission memory s, bytes memory signature) = _attest(holder, token, kind, link, ATTESTER_KEY);
        // Anyone can relay an approval: carol sends it, the holder is credited.
        vm.prank(carol);
        vault.submitAttested(s, link, signature);
    }

    function _epochs(uint256 epoch) internal pure returns (uint256[] memory list) {
        list = new uint256[](1);
        list[0] = epoch;
    }

    function _round(address token, uint256 epoch)
        internal
        view
        returns (uint256 pot, uint256 pool, uint256 totalWeight, uint256 links)
    {
        (pot, pool,,, totalWeight, links,,) = vault.roundOf(token, epoch);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Launch fee
    // ─────────────────────────────────────────────────────────────────────────

    function test_01_aLaunchPaysTenPercentOfTheRaiseToTheVault() public {
        uint256 teamBefore = team.balance;
        (CallZPancake mint, address token) = _launch();
        uint256 epoch = vault.currentEpoch();

        assertEq(mint.launchFeeBps(), 1000);
        assertEq(mint.vault(), address(vault));
        assertEq(address(vault).balance + team.balance - teamBefore, 0.1 ether, "10% of the 1 BNB raise");
        assertEq(address(mint).balance, 0, "the mint keeps nothing");
        assertEq(IERC20(WBNB).balanceOf(mint.pair()), 0.9 ether, "the rest is the pool's BNB side");

        // The split: 45% to the round's holder share, 30% to its callout pool, 25% to the team wallet.
        (uint256 pot, uint256 pool,,) = _round(token, epoch);
        assertEq(pot, 0, "nobody has called the token out yet, so the holder share joins the pool");
        assertEq(pool, 0.075 ether);
        assertEq(team.balance - teamBefore, 0.025 ether, "the platform share went straight to the team wallet");
        assertEq(vault.platformAccrued(), 0);
        assertEq(address(vault).balance, 0.075 ether);

        // A mint that misses its cap refunds the full price: the fee is only taken at launch.
        CallZPancakeConfig memory c = CallZPancakeConfig("Miss", "MISS", "", 0.1 ether, 1 ether, 1 hours, 5000);
        vm.prank(creator);
        CallZPancake missed = CallZPancake(factory.create(c, bytes32(++nonce)));
        vm.prank(bob);
        missed.mint{value: 0.5 ether}();
        vm.warp(block.timestamp + 1 hours);
        uint256 before = bob.balance;
        vm.prank(bob);
        missed.refund();
        assertEq(bob.balance - before, 0.5 ether);
    }

    function test_02_theGuardianSetsTheLaunchFeeForNewMintsOnly() public {
        (CallZPancake first,) = _launch();

        vm.expectRevert(CallZPancakeFactory.NotGuardian.selector);
        factory.setLaunchFee(0);
        vm.startPrank(guardian);
        vm.expectRevert(CallZPancakeFactory.FeeTooHigh.selector);
        factory.setLaunchFee(1001);
        factory.setLaunchFee(0);
        vm.stopPrank();

        uint256 vaultBefore = address(vault).balance;
        (CallZPancake second,) = _launch();
        assertEq(first.launchFeeBps(), 1000, "an existing mint keeps the fee it was created with");
        assertEq(second.launchFeeBps(), 0);
        assertEq(address(vault).balance, vaultBefore, "no fee at 0");
        assertEq(IERC20(WBNB).balanceOf(second.pair()), 1 ether, "the whole raise is in the pool");

        // The guardian role moves in two steps.
        vm.prank(guardian);
        factory.transferGuardian(bob);
        vm.expectRevert(CallZPancakeFactory.NotGuardian.selector);
        vm.prank(carol);
        factory.acceptGuardian();
        vm.prank(bob);
        factory.acceptGuardian();
        assertEq(factory.guardian(), bob);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Trading fee
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev What a fee adds to the vault and to the team wallet together: the whole fee.
    function _collected() internal view returns (uint256) {
        return address(vault).balance + team.balance;
    }

    function test_03_buyingAndSellingThroughTheRouterPaysTwoPercentInBnb() public {
        (, address token) = _launch();
        uint256 collectedBefore = _collected();
        IPancakeRouterView pancake = IPancakeRouterView(PANCAKE_ROUTER);

        // Buy with 1 BNB: 0.02 BNB to the vault, 0.98 BNB swapped, the tokens straight to the buyer.
        uint256 expected = pancake.getAmountsOut(0.98 ether, _path(WBNB, token))[1];
        vm.prank(bob);
        uint256 bought = router.buy{value: 1 ether}(token, _path(WBNB, token), expected, block.timestamp);
        assertEq(bought, expected);
        assertEq(IERC20(token).balanceOf(bob), expected);
        assertEq(_collected() - collectedBefore, 0.02 ether);

        // Sell them: 2% of the BNB that comes out goes to the vault, the rest to the seller.
        uint256 gross = pancake.getAmountsOut(bought, _path(token, WBNB))[1];
        uint256 fee = gross * 200 / 10_000;
        vm.startPrank(bob);
        IERC20(token).approve(address(router), bought);
        vm.expectRevert(abi.encodeWithSelector(CallZRouter.InsufficientOutput.selector, gross - fee, gross));
        router.sell(token, bought, _path(token, WBNB), gross, block.timestamp);
        uint256 before = bob.balance;
        uint256 out = router.sell(token, bought, _path(token, WBNB), gross - fee, block.timestamp);
        vm.stopPrank();
        assertEq(out, gross - fee);
        assertEq(bob.balance - before, gross - fee);
        assertEq(_collected() - collectedBefore, 0.02 ether + fee);

        // The router keeps nothing.
        assertEq(address(router).balance, 0);
        assertEq(IERC20(token).balanceOf(address(router)), 0);
        assertEq(IERC20(token).allowance(address(router), PANCAKE_ROUTER), 0);

        // A route that does not start at BNB and end at the token (or the reverse) is refused, and so is BNB from
        // anyone but PancakeSwap.
        vm.startPrank(bob);
        vm.expectRevert(CallZRouter.InvalidPath.selector);
        router.buy{value: 1 ether}(token, _path(WBNB, USDT), 0, block.timestamp);
        vm.expectRevert(CallZRouter.InvalidPath.selector);
        router.sell(token, 1, _path(token, USDT), 0, block.timestamp);
        vm.expectRevert(CallZRouter.ZeroAmount.selector);
        router.buy(token, _path(WBNB, token), 0, block.timestamp);
        (bool ok,) = address(router).call{value: 1}("");
        assertFalse(ok);
        vm.stopPrank();
    }

    /// @dev A Flap tax token pooled against BNB and one pooled against USDT: both trade through the router, the fee
    ///      reaches the vault in BNB, and the seller gets what a direct PancakeSwap sell pays, less the 2%.
    function test_04_liveFlapTaxTokensTradeThroughTheRouter() public {
        _roundTrip(FLAP_BNB_TOKEN, _path(WBNB, FLAP_BNB_TOKEN), _path(FLAP_BNB_TOKEN, WBNB));
        _roundTrip(FLAP_USDT_TOKEN, _path(WBNB, USDT, FLAP_USDT_TOKEN), _path(FLAP_USDT_TOKEN, USDT, WBNB));
    }

    function _roundTrip(address token, address[] memory buyPath, address[] memory sellPath) internal {
        uint256 collectedBefore = _collected();
        vm.prank(bob);
        uint256 bought = router.buy{value: 0.1 ether}(token, buyPath, 1, block.timestamp);
        assertGt(bought, 0);
        assertEq(_collected() - collectedBefore, 0.002 ether, "2% of the BNB in");

        // What a direct sell on PancakeSwap pays for the same tokens.
        uint256 snapshot = vm.snapshot();
        vm.startPrank(bob);
        IERC20(token).approve(PANCAKE_ROUTER, bought);
        uint256 before = bob.balance;
        IPancakeRouterView(PANCAKE_ROUTER).swapExactTokensForETHSupportingFeeOnTransferTokens(
            bought, 0, sellPath, bob, block.timestamp
        );
        uint256 direct = bob.balance - before;
        vm.stopPrank();
        vm.revertTo(snapshot);

        collectedBefore = _collected();
        vm.startPrank(bob);
        IERC20(token).approve(address(router), bought);
        before = bob.balance;
        uint256 out = router.sell(token, bought, sellPath, 1, block.timestamp);
        vm.stopPrank();
        uint256 fee = _collected() - collectedBefore;
        assertEq(bob.balance - before, out);
        assertGt(fee, 0);
        // The token is taxed once, as in a direct sell: proceeds before the CallZ fee match within 0.5%.
        assertApproxEqRel(out + fee, direct, 0.005e18, "same proceeds as a direct sell, before the fee");
        assertApproxEqAbs(fee, (out + fee) * 200 / 10_000, 1, "2% of the BNB out");
        assertEq(address(router).balance, 0);
        assertEq(IERC20(token).balanceOf(address(router)), 0);
    }

    function test_05_theGuardianSetsTheTradingFeeUpToTwoPercent() public {
        (, address token) = _launch();
        vm.expectRevert(CallZRouter.NotGuardian.selector);
        router.setFee(0);
        vm.startPrank(guardian);
        vm.expectRevert(CallZRouter.FeeTooHigh.selector);
        router.setFee(201);
        router.setFee(0);
        vm.stopPrank();
        vm.expectRevert(CallZRouter.FeeTooHigh.selector);
        new CallZRouter(PANCAKE_ROUTER, WBNB, address(vault), guardian, 201);

        uint256 collectedBefore = _collected();
        uint256 expected = IPancakeRouterView(PANCAKE_ROUTER).getAmountsOut(1 ether, _path(WBNB, token))[1];
        vm.prank(bob);
        assertEq(router.buy{value: 1 ether}(token, _path(WBNB, token), expected, block.timestamp), expected);
        assertEq(_collected(), collectedBefore, "no fee at 0");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Vault: split, platform, guardian
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_06_everyWeiOfADepositIsBooked(uint96 value) public {
        vm.assume(value >= 1e12);
        address token = address(0xBEEF);
        vm.deal(bob, value);
        uint256 teamBefore = team.balance;
        vm.prank(bob);
        vault.deposit{value: value}(token);

        (uint256 pot, uint256 pool,,) = _round(token, vault.currentEpoch());
        uint256 toTeam = team.balance - teamBefore;
        assertEq(pot, 0);
        assertEq(pool, uint256(value) * 4500 / 10_000 + uint256(value) * 3000 / 10_000);
        assertEq(pot + pool + toTeam, value);
        assertEq(vault.platformAccrued(), 0);
        (uint256 received, uint256 paid) = vault.ledgerOf(token);
        assertEq(received, pot + pool, "the token's ledger holds everything but the platform share");
        assertEq(paid, 0);
        assertEq(address(vault).balance, received);
    }

    function test_07_theTeamIsPaidWithoutSendingAnythingAndItsShareCanOnlyBeLowered() public {
        // A new team wallet is scheduled, and the one in place keeps being paid while it waits: the platform's
        // 25% reaches it inside the deposit that pays the fee.
        address token = address(0xBEEF);
        Refuser refuser = new Refuser();
        vm.prank(guardian);
        vault.scheduleTeamWallet(address(refuser));
        uint256 before = team.balance;
        vm.prank(bob);
        vault.deposit{value: 1 ether}(token);
        assertEq(team.balance - before, 0.25 ether);
        assertEq(vault.platformAccrued(), 0);

        // A team wallet that refuses BNB does not stop fees coming in: its money waits for `collect`. By the time
        // it is in place the first round's claim window has passed, so the next fee sweeps that round to it too.
        vm.warp(block.timestamp + vault.CHANGE_DELAY() + 1);
        vault.applyTeamWallet();
        vm.prank(bob);
        vault.deposit{value: 1 ether}(token);
        assertEq(vault.platformAccrued(), 0.25 ether + 0.75 ether);
        vm.expectRevert(CallZVault.BnbTransferFailed.selector);
        vault.collect(10);
        // BNB sent without a token is the team's too.
        vm.prank(bob);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        vm.prank(guardian);
        vault.scheduleTeamWallet(team);
        vm.warp(block.timestamp + vault.CHANGE_DELAY() + 1);
        vault.applyTeamWallet();
        before = team.balance;
        vm.prank(carol); // anyone can trigger it; it only ever pays the team wallet
        // What waited (1 + 1 BNB) and the second round, whose window has passed by now.
        assertEq(vault.collect(10), 2.75 ether);
        assertEq(team.balance - before, 2.75 ether);
        vm.expectRevert(CallZVault.NothingToClaim.selector);
        vault.collect(10);

        vm.expectRevert(CallZVault.NotGuardian.selector);
        vault.scheduleSplit(4500, 3000, 2500);
        vm.startPrank(guardian);
        vm.expectRevert(CallZVault.InvalidSplit.selector);
        vault.scheduleSplit(4500, 2500, 3000); // platform above 25%
        vm.expectRevert(CallZVault.InvalidSplit.selector);
        vault.scheduleSplit(4500, 3000, 2000); // does not add up
        vault.scheduleSplit(6000, 4000, 0);
        vm.expectRevert(CallZVault.InvalidRules.selector);
        vault.scheduleRules(0, 3, 100);
        vm.expectRevert(CallZVault.InvalidRules.selector);
        vault.scheduleRules(4, 3, 100);
        vault.scheduleRules(2, 5, 0);
        vm.expectRevert(CallZVault.ZeroAddress.selector);
        vault.scheduleAttester(address(0));
        vault.scheduleAttester(bob);
        vault.transferGuardian(alice);
        vm.stopPrank();

        // Neither change has taken effect: both are scheduled, in public, and wait out the delay.
        assertEq(vault.attester(), attester, "the attester is unchanged until the delay has passed");
        assertEq(vault.pendingAttester(), bob);
        assertEq(vault.platformBps(), 2500, "the split is unchanged until the delay has passed");
        assertEq(vault.splitEta(), block.timestamp + vault.CHANGE_DELAY());
        assertEq(vault.requiredLinks(), 1, "the round rules are unchanged until the delay has passed");
        assertEq(vault.rulesEta(), block.timestamp + vault.CHANGE_DELAY());
        vm.expectRevert(CallZVault.TooEarly.selector);
        vault.applyRules();
        vm.expectRevert(CallZVault.TooEarly.selector);
        vault.applyAttester();
        vm.expectRevert(CallZVault.TooEarly.selector);
        vault.applySplit();
        vm.warp(block.timestamp + vault.CHANGE_DELAY() - 1);
        vm.expectRevert(CallZVault.TooEarly.selector);
        vault.applySplit();
        vm.warp(block.timestamp + 1);
        // Once the wait is over anyone can put the change in place: it needs no second signature.
        vm.prank(carol);
        vault.applyAttester();
        vm.prank(carol);
        vault.applySplit();
        vm.prank(carol);
        vault.applyRules();
        assertEq(vault.attester(), bob);
        assertEq(vault.platformBps(), 0);
        assertEq(vault.requiredLinks(), 2);
        assertEq(vault.maxLinksPerEpoch(), 5);
        assertEq(vault.minHoldPpm(), 0);
        vm.expectRevert(CallZVault.NothingScheduled.selector);
        vault.applySplit();
        vm.expectRevert(CallZVault.NothingScheduled.selector);
        vault.applyRules();
        vm.prank(alice);
        vault.acceptGuardian();
        assertEq(vault.guardian(), alice);

        address other = address(0xCAFE);
        before = team.balance;
        vm.prank(bob);
        vault.deposit{value: 1 ether}(other);
        (uint256 pot, uint256 pool,,) = _round(other, vault.currentEpoch());
        assertEq(pot + pool, 1 ether);
        assertEq(team.balance, before, "platform share is 0 after the change");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Vault: callouts
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Nothing is staked: the vault reads the caller's wallet when their first callout of the round is
    ///      recorded, and that reading is their weight for the round.
    function test_08_theSnapshotIsTheWalletBalanceAndNothingLeavesTheWallet() public {
        (, address token) = _launch();
        IERC20 erc = IERC20(token);
        vm.prank(alice);
        erc.transfer(bob, 100_000_000e18); // alice 400M, bob 100M
        uint256 epoch = vault.currentEpoch();

        (, bool inShare, uint256 snapshot,,,,) = vault.progress(token, epoch, alice);
        assertFalse(inShare);
        assertEq(snapshot, 0);

        _submit(alice, token, 0, "https://x.com/alice/status/8");
        (uint256 links, bool nowIn, uint256 taken,,,,) = vault.progress(token, epoch, alice);
        assertEq(links, 1);
        assertTrue(nowIn);
        assertEq(taken, 400_000_000e18, "the snapshot is what her wallet held");
        assertEq(erc.balanceOf(alice), 400_000_000e18, "her tokens never left her wallet");
        assertEq(erc.balanceOf(address(vault)), 0, "the vault holds no tokens");
        assertEq(erc.allowance(alice, address(vault)), 0, "and was never approved to move any");

        // A snapshot is taken once a round: more tokens and more callouts afterwards do not change it.
        vm.prank(bob);
        erc.transfer(alice, 50_000_000e18);
        _submit(alice, token, 0, "https://x.com/alice/status/8b");
        (links,, taken,,,,) = vault.progress(token, epoch, alice);
        assertEq(links, 2);
        assertEq(taken, 400_000_000e18);
        (,, uint256 totalWeight,) = _round(token, epoch);
        assertEq(totalWeight, 400_000_000e18 * 10, "holdings times 1e6, over the 100,000 dollar market cap");
    }

    function test_09_verifiedCalloutsShareTheHolderShareAndEarnFromThePool() public {
        (, address token) = _launch();
        IERC20 erc = IERC20(token);
        vm.prank(alice);
        erc.transfer(bob, 100_000_000e18); // alice 400M, bob 100M
        vm.warp((vault.currentEpoch() + 1) * DAY + 1 hours); // a fresh round
        uint256 epoch = vault.currentEpoch();

        // Alice records one verified link, bob two.
        _submit(alice, token, 0, "https://x.com/alice/status/1");
        _submit(bob, token, 1, "https://pump.fun/callouts/0xabc/7f179b33-b00a-4c2e-a119-153b48b7f9d6");
        _submit(bob, token, 2, "https://fomo.family/tokens/bnb/0xabc?r=bob&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3");
        uint256 totalWeight;
        uint256 links;
        (,, totalWeight, links) = _round(token, epoch);
        assertEq(links, 3);
        assertEq(totalWeight, 500_000_000e18 * 10, "both called at the same market cap: weight follows holdings");
        assertTrue(vault.usedLink(keccak256("https://x.com/alice/status/1")));

        // Trading after their callouts fills the round: a 5 BNB buy pays 0.1 BNB, so 0.045 to the holder share and
        // 0.03 to the pool.
        vm.prank(carol);
        router.buy{value: 5 ether}(token, _path(WBNB, token), 1, block.timestamp);
        (uint256 pot, uint256 pool,,) = _round(token, epoch);
        assertEq(pot, 0.045 ether);
        assertEq(pool, 0.03 ether);

        _refusals(token, epoch);
        _claimsAndSweep(token, epoch);
    }

    function _refusals(address token, uint256 epoch) internal {
        IERC20 erc = IERC20(token);
        uint256 links;
        // What is refused.
        (Submission memory s, bytes memory signature) = _attest(alice, token, 0, "https://x.com/alice/status/1", ATTESTER_KEY);
        vm.expectRevert(CallZVault.LinkUsed.selector);
        vault.submitAttested(s, "https://x.com/alice/status/1", signature);
        (s, signature) = _attest(alice, token, 0, "https://x.com/alice/status/2", 0xBAD);
        vm.expectRevert(CallZVault.BadSignature.selector);
        vault.submitAttested(s, "https://x.com/alice/status/2", signature);
        (s, signature) = _attest(alice, token, 0, "https://x.com/alice/status/2", ATTESTER_KEY);
        vm.expectRevert(CallZVault.LinkMismatch.selector);
        vault.submitAttested(s, "https://x.com/alice/status/3", signature);
        s.holder = carol; // a signed approval cannot be moved to another holder
        vm.expectRevert(CallZVault.BadSignature.selector);
        vault.submitAttested(s, "https://x.com/alice/status/2", signature);
        (s, signature) = _attest(carol, token, 0, "https://x.com/carol/status/1", ATTESTER_KEY);
        uint256 carolHolds = erc.balanceOf(carol);
        vm.prank(carol);
        erc.transfer(address(0xdead), carolHolds); // carol holds nothing
        vm.expectRevert(CallZVault.BelowMinHold.selector);
        vault.submitAttested(s, "https://x.com/carol/status/1", signature);
        _submit(bob, token, 0, "https://x.com/bob/status/3");
        (s, signature) = _attest(bob, token, 0, "https://x.com/bob/status/4", ATTESTER_KEY);
        vm.expectRevert(CallZVault.TooManyLinks.selector); // three per holder per round
        vault.submitAttested(s, "https://x.com/bob/status/4", signature);
        (,,, links) = _round(token, epoch);
        assertEq(links, 4);

        // Nothing of a round is claimable while it runs.
        vm.expectRevert(CallZVault.NothingToClaim.selector);
        vm.prank(alice);
        vault.claim(token, _epochs(epoch));

        // An approval for a round that has ended is refused.
        (s, signature) = _attest(alice, token, 0, "https://x.com/alice/status/5", ATTESTER_KEY);
        vm.warp((epoch + 1) * DAY + 10);
        vm.expectRevert(CallZVault.WrongEpoch.selector);
        vault.submitAttested(s, "https://x.com/alice/status/5", signature);
    }

    function _claimsAndSweep(address token, uint256 epoch) internal {
        // The round is over. One transaction pays alice both her buckets: four fifths of the holder share (her
        // snapshot is 400M of the 500M) and one of the four links' worth of the pool.
        (,,,,, uint256 aliceHolder, uint256 aliceCallout) = vault.progress(token, epoch, alice);
        assertEq(aliceHolder, 0.045 ether * 4 / 5);
        assertEq(aliceCallout, 0.03 ether / 4);
        uint256 before = alice.balance;
        vm.startPrank(alice);
        assertEq(vault.claim(token, _epochs(epoch)), 0.0435 ether);
        vm.expectRevert(CallZVault.NothingToClaim.selector);
        vault.claim(token, _epochs(epoch));
        vm.stopPrank();
        assertEq(alice.balance - before, 0.0435 ether);

        // 24 hours after the round ended, the claim window shuts. Bob never claimed.
        (,,,,,, uint256 deadline,) = vault.roundOf(token, epoch);
        assertEq(deadline, (epoch + 1) * DAY + 24 hours);
        vm.warp(deadline + 1);
        (,,,,, uint256 bobHolder, uint256 bobCallout) = vault.progress(token, epoch, bob);
        assertEq(bobHolder + bobCallout, 0);
        vm.expectRevert(CallZVault.NothingToClaim.selector);
        vm.prank(bob);
        vault.claim(token, _epochs(epoch));

        // Everything unclaimed goes to the team wallet: the launch round nobody called out in (0.045 + 0.03),
        // and what bob left in this one (0.009 of the holder share, 0.0225 of the pool).
        (uint256 rounds, uint256 pending) = vault.pendingSweep(10);
        assertEq(rounds, 2);
        assertEq(pending, 0.075 ether + 0.0315 ether);
        before = team.balance;
        vm.prank(carol);
        assertEq(vault.collect(10), 0.1065 ether);
        assertEq(team.balance - before, 0.1065 ether);
        assertEq(vault.sweepCursor(), vault.roundCount());
        vm.expectRevert(CallZVault.NothingToClaim.selector);
        vault.collect(10);
    }

    /// @dev The team does not have to send anything to be paid: the next fee that arrives sweeps a finished round.
    function test_10_theNextFeeSweepsAFinishedRoundToTheTeamWallet() public {
        (, address token) = _launch();
        uint256 epoch = vault.currentEpoch();
        (uint256 pot, uint256 pool,,) = _round(token, epoch);
        assertEq(pot + pool, 0.075 ether);

        // While the claim window is open, a deposit sweeps nothing.
        vm.warp(vault.claimDeadline(epoch));
        uint256 before = team.balance;
        vm.prank(carol);
        vault.deposit{value: 1 ether}(token);
        assertEq(team.balance - before, 0.25 ether, "only the platform share");
        assertEq(vault.sweepCursor(), 0);

        // Once it has passed, the next deposit carries the round's unclaimed rewards to the team wallet.
        vm.warp(vault.claimDeadline(epoch) + 1);
        before = team.balance;
        vm.prank(carol);
        vault.deposit{value: 1 ether}(address(0xBEEF)); // a fee on any token does it
        assertEq(team.balance - before, 0.25 ether + 0.075 ether);
        assertEq(vault.sweepCursor(), 1);
        (,,,,,,, bool swept) = vault.roundOf(token, epoch);
        assertTrue(swept);
        (uint256 received, uint256 paid) = vault.ledgerOf(token);
        assertEq(paid, 0.075 ether);
        assertLe(paid, received);
    }

    /// @dev Calling out and then holding nothing at the checkpoint earns nothing from the holder share: it is paid
    ///      on what is still held, and what that caller gives up goes to the callers who hold, not to the team.
    function test_11_callingOutAndSellingEarnsNothingFromTheHolderShare() public {
        (, address token) = _launch();
        IERC20 erc = IERC20(token);
        vm.warp((vault.currentEpoch() + 1) * DAY + 1 hours);
        uint256 epoch = vault.currentEpoch();

        _submit(alice, token, 0, "https://x.com/alice/status/9");
        vm.startPrank(alice);
        erc.transfer(bob, erc.balanceOf(alice)); // moves everything out after her snapshot
        vm.stopPrank();
        _submit(bob, token, 0, "https://x.com/bob/status/9"); // the same tokens are snapshotted again in another wallet
        vm.prank(carol);
        vault.deposit{value: 1 ether}(token);

        vm.warp((epoch + 1) * DAY + 1);
        // Alice holds nothing now: she is paid for her link, and nothing from the holder share.
        vm.prank(alice);
        assertEq(vault.claim(token, _epochs(epoch)), 0.15 ether);
        // Bob holds the tokens: he is paid the whole holder share and his link. Alice's snapshot weighs nothing.
        vm.prank(bob);
        assertEq(vault.claim(token, _epochs(epoch)), 0.45 ether + 0.15 ether);
        (uint256 pot,, uint256 claimedPot,,,,,) = vault.roundOf(token, epoch);
        assertEq(pot - claimedPot, 0, "nothing of the holder share is left over for the team");

        // After the window only the launch round's unclaimed 0.075 goes to the team wallet.
        vm.warp(vault.claimDeadline(epoch) + 1);
        uint256 before = team.balance;
        vault.collect(10);
        assertEq(team.balance - before, 0.075 ether);
    }

    /// @dev Two tokens share the vault. Everything one token can pay out, claimed or swept in full, never passes
    ///      what its own fees brought in, and the other token's money is untouched by it.
    function test_12_aTokenCanNeverPayOutMoreThanItsFeesBroughtIn() public {
        (, address a) = _launch();
        address b = FLAP_BNB_TOKEN;
        vm.warp((vault.currentEpoch() + 1) * DAY + 1 hours);
        uint256 epoch = vault.currentEpoch();
        vm.prank(carol);
        router.buy{value: 10 ether}(b, _path(WBNB, b), 1, block.timestamp); // 0.2 BNB of fees booked under b
        (uint256 receivedB,) = vault.ledgerOf(b);
        assertEq(receivedB, 0.15 ether);
        (uint256 receivedA, uint256 paidA) = vault.ledgerOf(a);
        assertEq(receivedA, 0.075 ether, "the launch fee, less the platform share");
        assertEq(paidA, 0);

        // Pay out everything token a can pay: its callers claim the running round, the launch round is swept.
        _submit(alice, a, 0, "https://x.com/alice/status/12");
        vm.prank(carol);
        vault.deposit{value: 1 ether}(a);
        vm.warp((epoch + 1) * DAY + 1 hours);
        vm.prank(alice);
        assertEq(vault.claim(a, _epochs(epoch)), 0.75 ether);
        assertEq(vault.collect(1), 0.075 ether); // the launch round of a, the oldest in the queue

        (receivedA, paidA) = vault.ledgerOf(a);
        assertEq(receivedA, 0.825 ether);
        assertEq(paidA, receivedA, "all of it was payable, and not a wei more");

        // Token b's fees are all still there: its round is still open for its own callers.
        (, uint256 paidB) = vault.ledgerOf(b);
        assertEq(paidB, 0);
        assertEq(vault.platformAccrued(), 0);
        assertEq(address(vault).balance, receivedB, "what is left in the vault is exactly token b's");
    }

    /// @dev The earlier call earns more: it is weighted by the market cap it was made at, and it earns from the
    ///      trading that comes after it. A caller who sold part of their position is paid on what they still hold.
    function test_14_earlierCallsAtLowerMarketCapsEarnMoreAndSellingCutsThePayout() public {
        (, address token) = _launch();
        IERC20 erc = IERC20(token);
        vm.prank(alice);
        erc.transfer(bob, 250_000_000e18); // 250M each
        vm.warp((vault.currentEpoch() + 1) * DAY + 1 hours);
        uint256 epoch = vault.currentEpoch();

        // Alice calls it at a 50,000 dollar market cap. The trading that follows is hers alone.
        mcap = 50_000;
        _submit(alice, token, 0, "https://x.com/alice/status/14");
        vm.prank(carol);
        vault.deposit{value: 1 ether}(token);

        // Bob calls it at 100,000 with the same holdings: half her weight, and only for trading from here on.
        mcap = 100_000;
        _submit(bob, token, 0, "https://x.com/bob/status/14");
        vm.prank(carol);
        vault.deposit{value: 1 ether}(token);

        // A zero market cap is refused.
        mcap = 0;
        (Submission memory s, bytes memory signature) = _attest(alice, token, 0, "https://x.com/alice/status/14b", ATTESTER_KEY);
        vm.expectRevert(CallZVault.ZeroMarketCap.selector);
        vault.submitAttested(s, "https://x.com/alice/status/14b", signature);

        // Bob sells half of his position before the round ends.
        vm.prank(bob);
        erc.transfer(address(0xdead), 125_000_000e18);

        vm.warp((epoch + 1) * DAY + 1);
        (,,,,, uint256 aliceHolder, uint256 aliceCallout) = vault.progress(token, epoch, alice);
        (,,,,, uint256 bobHolder, uint256 bobCallout) = vault.progress(token, epoch, bob);
        // Bob's weight is halved because he holds half of his snapshot: a quarter of hers. Holder share: all 0.45
        // of the first BNB is hers, and the second is shared four to one.
        assertApproxEqAbs(aliceHolder, 0.45 ether + 0.36 ether, 10);
        assertApproxEqAbs(bobHolder, 0.09 ether, 10);
        assertLe(aliceHolder + bobHolder, 0.9 ether, "never more than the holder share");
        // The pool is per callout, whoever made it: 0.3 a BNB, two callouts.
        assertEq(aliceCallout, 0.3 ether);
        assertEq(bobCallout, 0.3 ether);

        vm.prank(alice);
        assertEq(vault.claim(token, _epochs(epoch)), aliceHolder + aliceCallout);
        vm.prank(bob);
        assertEq(vault.claim(token, _epochs(epoch)), bobHolder + bobCallout);
        (uint256 received, uint256 paid) = vault.ledgerOf(token);
        assertLe(paid, received);
    }

    /// @dev Tokens moved into a wallet only for the moment its callout is recorded add nothing: the snapshot is never
    ///      more than the wallet held when the callout was posted. And dust deposits open no round.
    function test_15_tokensPassingThroughDoNotInflateTheSnapshot() public {
        (, address token) = _launch();
        IERC20 erc = IERC20(token);
        vm.prank(alice);
        erc.transfer(bob, 1_000_000e18); // bob really holds 1M
        uint256 epoch = vault.currentEpoch();

        // Bob posted his callout holding 1M: that is what the reviewer attests.
        heldAtPost = 1_000_000e18;
        (Submission memory s, bytes memory signature) = _attest(bob, token, 0, "https://x.com/bob/status/15", ATTESTER_KEY);
        // 400M more is moved into his wallet just for the transaction that records it, and moved out afterwards.
        vm.prank(alice);
        erc.transfer(bob, 400_000_000e18);
        vault.submitAttested(s, "https://x.com/bob/status/15", signature);
        vm.prank(bob);
        erc.transfer(alice, 400_000_000e18);
        (,, uint256 snapshot,,,,) = vault.progress(token, epoch, bob);
        assertEq(snapshot, 1_000_000e18, "the snapshot is what he held when he posted, not what passed through his wallet");

        // The other way round: a wallet that sold between posting and recording is taken at what it holds now.
        heldAtPost = 100_000_000e18;
        (s, signature) = _attest(alice, token, 0, "https://x.com/alice/status/15", ATTESTER_KEY);
        uint256 sold = erc.balanceOf(alice) - 10_000_000e18;
        vm.prank(alice);
        erc.transfer(address(0xdead), sold);
        vault.submitAttested(s, "https://x.com/alice/status/15", signature);
        (,, snapshot,,,,) = vault.progress(token, epoch, alice);
        assertEq(snapshot, 10_000_000e18);
        heldAtPost = type(uint256).max;

        // A dust deposit opens no round: it goes to the team wallet and nothing joins the sweep queue.
        uint256 rounds = vault.roundCount();
        uint256 before = team.balance;
        vm.prank(carol);
        vault.deposit{value: 1e12 - 1}(address(0xD057));
        assertEq(vault.roundCount(), rounds);
        assertEq(team.balance - before, 1e12 - 1);
    }

    /// @dev One transaction collects a wallet's rewards across tokens, each booked against its own token's ledger.
    function test_16_oneClaimCollectsAcrossTokens() public {
        (, address a) = _launch();
        (, address b) = _launch();
        vm.warp((vault.currentEpoch() + 1) * DAY + 1 hours);
        uint256 epoch = vault.currentEpoch();
        _submit(alice, a, 0, "https://x.com/alice/status/16a");
        _submit(alice, b, 0, "https://x.com/alice/status/16b");
        vm.startPrank(carol);
        vault.deposit{value: 1 ether}(a);
        vault.deposit{value: 2 ether}(b);
        vm.stopPrank();

        address[] memory tokens = new address[](3);
        tokens[0] = a;
        tokens[1] = b;
        tokens[2] = address(0xBEEF); // owes nothing: skipped
        vm.warp((epoch + 1) * DAY + 1);
        uint256 before = alice.balance;
        vm.prank(alice);
        assertEq(vault.claimMany(tokens, _epochs(epoch)), 0.75 ether + 1.5 ether);
        assertEq(alice.balance - before, 2.25 ether);
        (, uint256 paidA) = vault.ledgerOf(a);
        (, uint256 paidB) = vault.ledgerOf(b);
        assertEq(paidA, 0.75 ether);
        assertEq(paidB, 1.5 ether);
        vm.expectRevert(CallZVault.NothingToClaim.selector);
        vm.prank(alice);
        vault.claimMany(tokens, _epochs(epoch));
    }

    /// @dev Wallets can carry delegated code (EIP-7702). The attester's plain signature still counts then, and a
    ///      signature from anyone else still does not.
    /// @dev Audit: one bag passed between two callers' wallets is paid once. Both wallets are in the round's holder
    ///      share with a snapshot of the same tokens. All the round's callers are read together at the
    ///      checkpoint, so the bag is in one wallet then, and moving it afterwards changes nothing.
    function test_17_oneBagPassedBetweenWalletsIsPaidOnce() public {
        (, address token) = _launch();
        IERC20 erc = IERC20(token);
        vm.warp((vault.currentEpoch() + 1) * DAY + 1 hours);
        uint256 epoch = vault.currentEpoch();

        // Alice calls the token out holding the bag, passes the whole bag to bob, and bob calls it out too.
        uint256 bag = erc.balanceOf(alice);
        _submit(alice, token, 0, "https://x.com/alice/status/17");
        vm.prank(alice);
        erc.transfer(bob, bag);
        _submit(bob, token, 0, "https://x.com/bob/status/17");
        (address[] memory callers, bool checkpointed) = vault.callersOf(token, epoch);
        assertEq(callers.length, 2, "both wallets are in the holder share");
        assertFalse(checkpointed);
        vm.prank(carol);
        vault.deposit{value: 1 ether}(token);

        // The round is still running: no checkpoint yet.
        vm.expectRevert(CallZVault.RoundRunning.selector);
        vault.checkpoint(token, epoch);

        vm.warp((epoch + 1) * DAY + 1);
        // Bob holds the bag and claims first. His claim takes the round's checkpoint: alice's wallet is read in
        // the same transaction and holds nothing.
        vm.prank(bob);
        assertEq(vault.claim(token, _epochs(epoch)), 0.45 ether + 0.15 ether, "bob: the holder share and his link");
        (, checkpointed) = vault.callersOf(token, epoch);
        assertTrue(checkpointed);

        // Now the bag goes back to alice, so that she holds her whole snapshot again when she claims.
        vm.prank(bob);
        erc.transfer(alice, bag);
        assertEq(erc.balanceOf(alice), bag);
        (,,,,, uint256 holderPayout,) = vault.progress(token, epoch, alice);
        assertEq(holderPayout, 0, "the page shows her nothing from the holder share");
        vm.prank(alice);
        assertEq(vault.claim(token, _epochs(epoch)), 0.15 ether, "alice: her link only. The bag was counted in bob's wallet");

        // The bag earned the holder share once, and a second checkpoint changes nothing.
        vault.checkpoint(token, epoch);
        (uint256 pot,, uint256 claimedPot,,,,,) = vault.roundOf(token, epoch);
        assertEq(pot, 0.45 ether);
        assertEq(claimedPot, 0.45 ether);
    }

    /// @dev Audit: a bag passed between two wallets takes nothing from the other callers. Alice calls the token
    ///      out, passes her bag to bob, bob calls it out too, and dave calls it out with his own tokens. The
    ///      bag is snapshotted twice, but at the checkpoint each caller weighs what they hold then: dave is paid
    ///      what he would have been paid had the second snapshot never been taken, and the team gets none of it.
    function test_20_aBagPassedBetweenWalletsTakesNothingFromTheOtherCallers() public {
        (, address token) = _launch();
        IERC20 erc = IERC20(token);
        address dave = address(uint160(0xC0DE0017));
        vm.prank(alice);
        erc.transfer(dave, 100_000_000e18); // alice 400M, dave 100M
        vm.warp((vault.currentEpoch() + 1) * DAY + 1 hours);
        uint256 epoch = vault.currentEpoch();

        _submit(alice, token, 0, "https://x.com/alice/status/20");
        vm.prank(alice);
        erc.transfer(bob, 400_000_000e18);
        _submit(bob, token, 0, "https://x.com/bob/status/20");
        _submit(dave, token, 0, "https://x.com/dave/status/20");
        (,, uint256 totalWeight,) = _round(token, epoch);
        assertEq(totalWeight, 900_000_000e18 * 10, "the snapshots count the bag twice");
        vm.prank(carol);
        vault.deposit{value: 1 ether}(token);

        vm.warp((epoch + 1) * DAY + 1);
        // Before anyone claims, the page already shows each caller what the checkpoint will fix.
        (,,,,, uint256 daveHolder,) = vault.progress(token, epoch, dave);
        assertApproxEqAbs(daveHolder, 0.09 ether, 10, "dave: a fifth of the holder share, as with one snapshot of the bag");
        vault.checkpoint(token, epoch);
        (,,,,, uint256 aliceHolder,) = vault.progress(token, epoch, alice);
        (,,,,, uint256 bobHolder,) = vault.progress(token, epoch, bob);
        (,,,,, uint256 daveFixed,) = vault.progress(token, epoch, dave);
        assertEq(aliceHolder, 0, "the wallet the bag left weighs nothing");
        assertApproxEqAbs(bobHolder, 0.36 ether, 10, "the bag earns once, where it is");
        assertEq(daveFixed, daveHolder);

        vm.prank(dave);
        assertEq(vault.claim(token, _epochs(epoch)), daveFixed + 0.1 ether);
        vm.prank(bob);
        vault.claim(token, _epochs(epoch));
        (uint256 pot,, uint256 claimedPot,,,,,) = vault.roundOf(token, epoch);
        assertLe(claimedPot, pot);
        assertLt(pot - claimedPot, 10, "the holder share went to the callers who hold, to the wei");
    }

    /// @dev Fees are shared between the callers who were in the round when they arrived, on what they hold at the
    ///      checkpoint. A caller who joined later earns nothing from a fee that arrived before them, even when
    ///      the earlier caller holds nothing at the checkpoint: that fee stays in the round and is swept.
    function test_21_aFeeWhoseCallersHoldNothingStaysInTheRound() public {
        (, address token) = _launch();
        IERC20 erc = IERC20(token);
        vm.prank(alice);
        erc.transfer(bob, 100_000_000e18); // alice 400M, bob 100M
        vm.warp((vault.currentEpoch() + 1) * DAY + 1 hours);
        uint256 epoch = vault.currentEpoch();

        _submit(alice, token, 0, "https://x.com/alice/status/21");
        vm.prank(carol);
        vault.deposit{value: 1 ether}(token); // alice is the only caller: 0.45 for her snapshot
        _submit(bob, token, 0, "https://x.com/bob/status/21");
        vm.prank(carol);
        vault.deposit{value: 1 ether}(token); // 0.45 between alice and bob
        vm.startPrank(alice);
        erc.transfer(address(0xdead), erc.balanceOf(alice)); // alice sells everything
        vm.stopPrank();

        vm.warp((epoch + 1) * DAY + 1);
        vm.prank(bob);
        assertEq(vault.claim(token, _epochs(epoch)), 0.45 ether + 0.3 ether, "bob: all of the second fee, and his link");
        vm.prank(alice);
        assertEq(vault.claim(token, _epochs(epoch)), 0.3 ether, "alice: her link only");
        (uint256 pot,, uint256 claimedPot,,,,,) = vault.roundOf(token, epoch);
        assertEq(pot - claimedPot, 0.45 ether, "the first fee was owed to nobody");

        vm.warp(vault.claimDeadline(epoch) + 1);
        uint256 before = team.balance;
        vault.collect(10);
        assertEq(team.balance - before, 0.45 ether + 0.075 ether, "it is swept with the launch round's 0.075");
    }

    /// @dev Audit: the guardian cannot replace the team wallet or change the round rules at once. Both are
    ///      scheduled in public, wait out the delay, can be dropped, and are put in place by anyone afterwards.
    function test_22_theTeamWalletAndTheRoundRulesWaitOutTheDelay() public {
        address next = address(uint160(0xC0DE0018));
        vm.expectRevert(CallZVault.NotGuardian.selector);
        vault.scheduleTeamWallet(next);
        vm.expectRevert(CallZVault.NotGuardian.selector);
        vault.scheduleRules(1, 3, 100);
        vm.expectRevert(CallZVault.NothingScheduled.selector);
        vault.applyTeamWallet();
        vm.expectRevert(CallZVault.NothingScheduled.selector);
        vault.applyRules();

        vm.startPrank(guardian);
        vm.expectRevert(CallZVault.ZeroAddress.selector);
        vault.scheduleTeamWallet(address(0));
        vm.expectRevert(CallZVault.NothingScheduled.selector);
        vault.cancelTeamWallet();
        vm.expectRevert(CallZVault.NothingScheduled.selector);
        vault.cancelRules();
        vault.scheduleTeamWallet(next);
        vault.scheduleRules(1, 2, 500);
        vm.stopPrank();
        assertEq(vault.pendingTeamWallet(), next);
        assertEq(vault.teamWalletEta(), block.timestamp + 2 days);
        assertEq(vault.rulesEta(), block.timestamp + 2 days);
        assertEq(vault.teamWallet(), team, "the team wallet in place is unchanged");
        assertEq(vault.maxLinksPerEpoch(), 3, "and so are the rules");

        // Only the guardian can drop a scheduled change, and a dropped one cannot be applied.
        vm.expectRevert(CallZVault.NotGuardian.selector);
        vault.cancelTeamWallet();
        vm.startPrank(guardian);
        vault.cancelTeamWallet();
        vault.cancelRules();
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(CallZVault.NothingScheduled.selector);
        vault.applyTeamWallet();
        vm.expectRevert(CallZVault.NothingScheduled.selector);
        vault.applyRules();

        // Scheduled again, each waits the full delay from the new schedule.
        vm.startPrank(guardian);
        vault.scheduleTeamWallet(next);
        vault.scheduleRules(1, 2, 500);
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days - 1);
        vm.expectRevert(CallZVault.TooEarly.selector);
        vault.applyTeamWallet();
        vm.expectRevert(CallZVault.TooEarly.selector);
        vault.applyRules();
        vm.warp(block.timestamp + 1);
        vm.startPrank(carol);
        vault.applyTeamWallet();
        vault.applyRules();
        vm.stopPrank();
        assertEq(vault.teamWallet(), next);
        assertEq(vault.pendingTeamWallet(), address(0));
        assertEq(vault.maxLinksPerEpoch(), 2);
        assertEq(vault.minHoldPpm(), 500);

        // The new wallet is the one paid from here on.
        uint256 before = next.balance;
        vm.prank(bob);
        vault.deposit{value: 1 ether}(address(0xBEEF));
        assertEq(next.balance - before, 0.25 ether);
    }

    /// @dev Audit: the guardian cannot swap the attester at once. The new one is scheduled in public and the old
    ///      one keeps signing until the delay has passed. What the guardian can do at once is stop callouts being
    ///      recorded, which is what a leaked attester key calls for.
    function test_18_aNewAttesterWaitsOutTheDelayAndAPauseStopsCalloutsAtOnce() public {
        (, address token) = _launch();
        uint256 newKey = 0xBEEF5EED;
        address newAttester = vm.addr(newKey);

        vm.expectRevert(CallZVault.NotGuardian.selector);
        vault.scheduleAttester(newAttester);
        vm.expectRevert(CallZVault.NothingScheduled.selector);
        vault.applyAttester();
        vm.prank(guardian);
        vault.scheduleAttester(newAttester);
        assertEq(vault.attesterEta(), block.timestamp + 2 days);

        // During the wait the scheduled attester's approvals are refused and the current one's are accepted.
        (Submission memory s, bytes memory signature) = _attest(alice, token, 0, "https://x.com/alice/status/18a", newKey);
        vm.expectRevert(CallZVault.BadSignature.selector);
        vault.submitAttested(s, "https://x.com/alice/status/18a", signature);
        _submit(alice, token, 0, "https://x.com/alice/status/18b");

        // A pause takes effect at once and stops every callout, whoever signed it. Claims are not touched.
        vm.expectRevert(CallZVault.NotGuardian.selector);
        vault.setSubmissionsPaused(true);
        vm.prank(guardian);
        vault.setSubmissionsPaused(true);
        (s, signature) = _attest(alice, token, 0, "https://x.com/alice/status/18c", ATTESTER_KEY);
        vm.expectRevert(CallZVault.SubmissionsPaused.selector);
        vault.submitAttested(s, "https://x.com/alice/status/18c", signature);
        vm.prank(guardian);
        vault.setSubmissionsPaused(false);

        // The guardian can drop a scheduled attester, and scheduling again restarts the wait.
        vm.prank(guardian);
        vault.cancelAttester();
        vm.expectRevert(CallZVault.NothingScheduled.selector);
        vault.applyAttester();
        vm.prank(guardian);
        vault.scheduleAttester(newAttester);
        vm.warp(block.timestamp + 2 days - 1);
        vm.expectRevert(CallZVault.TooEarly.selector);
        vault.applyAttester();
        vm.warp(block.timestamp + 1);
        vm.prank(carol);
        vault.applyAttester();
        assertEq(vault.attester(), newAttester);
        assertEq(vault.pendingAttester(), address(0));

        // From here on the new attester's approvals count and the old one's do not.
        (s, signature) = _attest(alice, token, 0, "https://x.com/alice/status/18d", ATTESTER_KEY);
        vm.expectRevert(CallZVault.BadSignature.selector);
        vault.submitAttested(s, "https://x.com/alice/status/18d", signature);
        (s, signature) = _attest(alice, token, 0, "https://x.com/alice/status/18e", newKey);
        vault.submitAttested(s, "https://x.com/alice/status/18e", signature);
        assertTrue(vault.usedLink(keccak256("https://x.com/alice/status/18e")));
    }

    /// @dev Audit: the checkpoint reads every caller of the round in one transaction, so a round's holder share
    ///      takes at most 256 holders, and reading 256 wallets fits in one transaction with room to spare. A
    ///      callout recorded after that is still counted, for the callout pool.
    function test_19_theCheckpointOfAFullRoundFitsInOneTransaction() public {
        (, address token) = _launch();
        IERC20 erc = IERC20(token);
        vm.warp((vault.currentEpoch() + 1) * DAY + 1 hours);
        uint256 epoch = vault.currentEpoch();
        uint256 cap = vault.MAX_ROUND_CALLERS();
        assertEq(cap, 256);

        // 257 wallets, each holding 1M tokens (0.1% of the supply), each with a verified callout.
        for (uint256 i; i <= cap; ++i) {
            address holder = address(uint160(0xCA11E7000) + uint160(i));
            vm.prank(alice);
            erc.transfer(holder, 1_000_000e18);
            _submit(holder, token, 0, string.concat("https://x.com/caller/status/", vm.toString(i)));
        }
        (address[] memory callers,) = vault.callersOf(token, epoch);
        assertEq(callers.length, cap, "the holder share is full at the cap");
        address late = address(uint160(0xCA11E7000) + uint160(cap));
        (uint256 links, bool inHolderShare,,,,,) = vault.progress(token, epoch, late);
        assertEq(links, 1, "the callout after the cap is recorded");
        assertFalse(inHolderShare, "and it is not in the holder share");

        vm.prank(carol);
        vault.deposit{value: 1 ether}(token);
        vm.warp((epoch + 1) * DAY + 1);

        uint256 gasBefore = gasleft();
        vault.checkpoint(token, epoch);
        uint256 used = gasBefore - gasleft();
        assertLt(used, 8_000_000, "the checkpoint of a full round is under 8M gas");
        (, bool checkpointed) = vault.callersOf(token, epoch);
        assertTrue(checkpointed);

        // Every one of the 257 links earns the same from the callout pool; the 256 in the holder share earn
        // from it too.
        vm.prank(late);
        uint256 linkOnly = vault.claim(token, _epochs(epoch));
        assertEq(linkOnly, uint256(0.3 ether) / 257, "the late caller is paid its link");
        vm.prank(callers[0]);
        assertGt(vault.claim(token, _epochs(epoch)), linkOnly, "a caller in the holder share is paid more than a link");
    }

    function test_13_anAttesterWalletWithDelegatedCodeStillApproves() public {
        (, address token) = _launch();
        vm.etch(attester, hex"ef01008a67b5020ee254ef48e3b6a04927f39baf7e408a");
        assertGt(attester.code.length, 0);

        (Submission memory s, bytes memory signature) = _attest(alice, token, 0, "https://x.com/alice/status/13", 0xBAD);
        vm.expectRevert(CallZVault.BadSignature.selector);
        vault.submitAttested(s, "https://x.com/alice/status/13", signature);
        _submit(alice, token, 0, "https://x.com/alice/status/13");
        assertTrue(vault.usedLink(keccak256("https://x.com/alice/status/13")));
    }
}

/// @dev A team wallet that takes no BNB.
contract Refuser {}
