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
///         vault that splits and pays them: the holder stream, callout rounds, the 24-hour claim window, and the
///         team wallet being paid without sending a transaction.
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

        // The split of the passdown: 35% holders, 10% callout-unlocked, 30% callout pool, 25% platform.
        (uint256 pot, uint256 pool,,) = _round(token, epoch);
        assertEq(pot, 0.01 ether);
        assertEq(pool, 0.03 ether);
        assertEq(team.balance - teamBefore, 0.025 ether, "the platform share went straight to the team wallet");
        assertEq(vault.platformAccrued(), 0);
        (uint256 totalStaked, uint256 rate, uint256 finish, uint256 queued) = vault.streamOf(token);
        assertEq(totalStaked, 0);
        assertEq(rate * 3 days + queued, 0.035 ether, "the holder share is streaming or waiting, to the wei");
        assertEq(finish, block.timestamp + 3 days);

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
        vm.assume(value > 0);
        address token = address(0xBEEF);
        vm.deal(bob, value);
        uint256 teamBefore = team.balance;
        vm.prank(bob);
        vault.deposit{value: value}(token);

        (uint256 pot, uint256 pool,,) = _round(token, vault.currentEpoch());
        (, uint256 rate,, uint256 queued) = vault.streamOf(token);
        uint256 toTeam = team.balance - teamBefore;
        assertEq(pot, uint256(value) * 1000 / 10_000);
        assertEq(pool, uint256(value) * 3000 / 10_000);
        assertEq(rate * 3 days + queued, uint256(value) * 3500 / 10_000);
        assertEq(rate * 3 days + queued + pot + pool + toTeam, value);
        assertEq(vault.platformAccrued(), 0);
        (uint256 received, uint256 paid) = vault.ledgerOf(token);
        assertEq(received, uint256(value) - toTeam, "the token's ledger holds everything but the platform share");
        assertEq(paid, 0);
        assertEq(address(vault).balance, received);
    }

    function test_07_theTeamIsPaidWithoutSendingAnythingAndItsShareCanOnlyBeLowered() public {
        // The platform's 25% reaches the team wallet inside the deposit that pays the fee.
        address token = address(0xBEEF);
        uint256 before = team.balance;
        vm.prank(bob);
        vault.deposit{value: 1 ether}(token);
        assertEq(team.balance - before, 0.25 ether);
        assertEq(vault.platformAccrued(), 0);

        // A team wallet that refuses BNB does not stop fees coming in: its money waits for `collect`.
        Refuser refuser = new Refuser();
        vm.prank(guardian);
        vault.setTeamWallet(address(refuser));
        vm.prank(bob);
        vault.deposit{value: 1 ether}(token);
        assertEq(vault.platformAccrued(), 0.25 ether);
        vm.expectRevert(CallZVault.BnbTransferFailed.selector);
        vault.collect(10);
        // BNB sent without a token is the team's too.
        vm.prank(bob);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        vm.prank(guardian);
        vault.setTeamWallet(team);
        before = team.balance;
        vm.prank(carol); // anyone can trigger it; it only ever pays the team wallet
        assertEq(vault.collect(10), 1.25 ether);
        assertEq(team.balance - before, 1.25 ether);
        vm.expectRevert(CallZVault.NothingToClaim.selector);
        vault.collect(10);

        vm.expectRevert(CallZVault.NotGuardian.selector);
        vault.setSplit(3500, 1000, 3000, 2500);
        vm.startPrank(guardian);
        vm.expectRevert(CallZVault.InvalidSplit.selector);
        vault.setSplit(3000, 1000, 3000, 3000); // platform above 25%
        vm.expectRevert(CallZVault.InvalidSplit.selector);
        vault.setSplit(3500, 1000, 3000, 2000); // does not add up
        vault.setSplit(4500, 1500, 4000, 0);
        vm.expectRevert(CallZVault.InvalidRules.selector);
        vault.setRules(0, 3, 100);
        vm.expectRevert(CallZVault.InvalidRules.selector);
        vault.setRules(4, 3, 100);
        vault.setRules(2, 5, 0);
        vm.expectRevert(CallZVault.ZeroAddress.selector);
        vault.setAttester(address(0));
        vault.setAttester(bob);
        vault.transferGuardian(alice);
        vm.stopPrank();
        assertEq(vault.attester(), bob);
        vm.prank(alice);
        vault.acceptGuardian();
        assertEq(vault.guardian(), alice);

        address other = address(0xCAFE);
        before = team.balance;
        vm.prank(bob);
        vault.deposit{value: 1 ether}(other);
        (uint256 pot, uint256 pool,,) = _round(other, vault.currentEpoch());
        assertEq(pot, 0.15 ether);
        assertEq(pool, 0.4 ether);
        assertEq(team.balance, before, "platform share is 0 after the change");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Vault: holders by weight
    // ─────────────────────────────────────────────────────────────────────────

    function test_08_stakersShareTheHolderStreamByWeight() public {
        (, address token) = _launch();
        IERC20 erc = IERC20(token);
        uint256[] memory none = new uint256[](0);
        vm.prank(alice);
        erc.transfer(bob, 100e18);

        // A day passes with nobody staked. That day's stream is not lost: it goes back to the queue.
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(alice);
        erc.approve(address(vault), 300e18);
        vault.stake(token, 300e18);
        vm.stopPrank();
        vm.startPrank(bob);
        erc.approve(address(vault), 100e18);
        vault.stake(token, 100e18);
        vm.stopPrank();
        assertEq(erc.balanceOf(address(vault)), 400e18);
        assertEq(vault.staked(token, alice), 300e18);

        // The whole 0.035 BNB holder share streams over the next 3 days, 3:1.
        vm.warp(block.timestamp + 1 days);
        assertApproxEqRel(vault.earned(token, alice), uint256(0.035 ether) * 3 / 4 / 3, 1e12);
        assertApproxEqRel(vault.earned(token, bob), uint256(0.035 ether) / 4 / 3, 1e12);
        vm.warp(block.timestamp + 5 days);
        assertApproxEqRel(vault.earned(token, alice), uint256(0.035 ether) * 3 / 4, 1e12);
        assertApproxEqRel(vault.earned(token, bob), uint256(0.035 ether) / 4, 1e12);

        uint256 before = alice.balance;
        uint256 owed = vault.earned(token, alice);
        vm.prank(alice);
        assertEq(vault.claim(token, none), owed);
        assertEq(alice.balance - before, owed);
        vm.expectRevert(CallZVault.NothingToClaim.selector);
        vm.prank(alice);
        vault.claim(token, none);

        // New fees join the stream; a stake comes back in full at any time and keeps what it earned.
        vm.prank(carol);
        vault.deposit{value: 4 ether}(token);
        vm.warp(block.timestamp + 3 days);
        assertApproxEqRel(vault.earned(token, alice), uint256(1.4 ether) * 3 / 4, 1e12);
        vm.startPrank(bob);
        vm.expectRevert(CallZVault.InsufficientStake.selector);
        vault.unstake(token, 100e18 + 1);
        vault.unstake(token, 100e18);
        vm.stopPrank();
        assertEq(erc.balanceOf(bob), 100e18);
        uint256 bobOwed = vault.earned(token, bob);
        assertApproxEqRel(bobOwed, uint256(0.035 ether) / 4 + uint256(1.4 ether) / 4, 1e12);
        before = bob.balance;
        vm.prank(bob);
        vault.claim(token, none);
        assertEq(bob.balance - before, bobOwed);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Vault: callouts
    // ─────────────────────────────────────────────────────────────────────────

    function test_09_verifiedCalloutsUnlockTheHolderShareAndEarnFromThePool() public {
        (, address token) = _launch();
        IERC20 erc = IERC20(token);
        vm.prank(alice);
        erc.transfer(bob, 100_000_000e18); // alice 400M, bob 100M
        vm.warp((vault.currentEpoch() + 1) * DAY + 1 hours); // a fresh round
        uint256 epoch = vault.currentEpoch();

        // Trading fees fill the round: a 5 BNB buy pays 0.1 BNB, so 0.01 to the pot and 0.03 to the pool.
        vm.prank(carol);
        router.buy{value: 5 ether}(token, _path(WBNB, token), 1, block.timestamp);
        (uint256 pot, uint256 pool,,) = _round(token, epoch);
        assertEq(pot, 0.01 ether);
        assertEq(pool, 0.03 ether);

        // Alice records one verified link, bob two.
        _submit(alice, token, 0, "https://x.com/alice/status/1");
        _submit(bob, token, 1, "https://pump.fun/callouts/0xabc/7f179b33-b00a-4c2e-a119-153b48b7f9d6");
        _submit(bob, token, 2, "https://fomo.family/tokens/bnb/0xabc?r=bob&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3");
        uint256 totalWeight;
        uint256 links;
        (,, totalWeight, links) = _round(token, epoch);
        assertEq(links, 3);
        assertEq(totalWeight, 500_000_000e18, "both unlocked with what they hold");
        assertTrue(vault.usedLink(keccak256("https://x.com/alice/status/1")));

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
        // The round is over. One transaction pays alice both her buckets: four fifths of the 10% share (she holds
        // 400M of the 500M that unlocked) and one of the four links' worth of the pool.
        (,,,,, uint256 aliceUnlocked, uint256 aliceCallout) = vault.progress(token, epoch, alice);
        assertEq(aliceUnlocked, 0.01 ether * 4 / 5);
        assertEq(aliceCallout, 0.03 ether / 4);
        uint256 before = alice.balance;
        vm.startPrank(alice);
        assertEq(vault.claim(token, _epochs(epoch)), 0.0155 ether);
        vm.expectRevert(CallZVault.NothingToClaim.selector);
        vault.claim(token, _epochs(epoch));
        vm.stopPrank();
        assertEq(alice.balance - before, 0.0155 ether);

        // 24 hours after the round ended, the claim window shuts. Bob never claimed.
        (,,,,,, uint256 deadline,) = vault.roundOf(token, epoch);
        assertEq(deadline, (epoch + 1) * DAY + 24 hours);
        vm.warp(deadline + 1);
        (,,,,, uint256 bobUnlocked, uint256 bobCallout) = vault.progress(token, epoch, bob);
        assertEq(bobUnlocked + bobCallout, 0);
        vm.expectRevert(CallZVault.NothingToClaim.selector);
        vm.prank(bob);
        vault.claim(token, _epochs(epoch));

        // Everything unclaimed goes to the team wallet: the launch round nobody called out in (0.01 + 0.03), and
        // what bob left in this one (0.002 of the 10% share, 0.0225 of the pool).
        (uint256 rounds, uint256 pending) = vault.pendingSweep(10);
        assertEq(rounds, 2);
        assertEq(pending, 0.04 ether + 0.0245 ether);
        before = team.balance;
        vm.prank(carol);
        assertEq(vault.collect(10), 0.0645 ether);
        assertEq(team.balance - before, 0.0645 ether);
        assertEq(vault.sweepCursor(), vault.roundCount());
        vm.expectRevert(CallZVault.NothingToClaim.selector);
        vault.collect(10);
    }

    /// @dev The team does not have to send anything to be paid: the next fee that arrives sweeps a finished round.
    function test_10_theNextFeeSweepsAFinishedRoundToTheTeamWallet() public {
        (, address token) = _launch();
        uint256 epoch = vault.currentEpoch();
        (uint256 pot, uint256 pool,,) = _round(token, epoch);
        assertEq(pot + pool, 0.04 ether);

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
        assertEq(team.balance - before, 0.25 ether + 0.04 ether);
        assertEq(vault.sweepCursor(), 1);
        (,,,,,,, bool swept) = vault.roundOf(token, epoch);
        assertTrue(swept);
        (uint256 received, uint256 paid) = vault.ledgerOf(token);
        assertEq(paid, 0.04 ether);
        assertLe(paid, received);
    }

    /// @dev Buying, unlocking and selling earns nothing from the 10% share: it is paid on what is still held.
    function test_11_unlockingAndSellingEarnsNothing() public {
        (, address token) = _launch();
        IERC20 erc = IERC20(token);
        vm.warp((vault.currentEpoch() + 1) * DAY + 1 hours);
        uint256 epoch = vault.currentEpoch();
        vm.prank(carol);
        vault.deposit{value: 1 ether}(token);

        _submit(alice, token, 0, "https://x.com/alice/status/9");
        vm.startPrank(alice);
        erc.transfer(bob, erc.balanceOf(alice)); // moves everything out after unlocking
        vm.stopPrank();
        _submit(bob, token, 0, "https://x.com/bob/status/9"); // the same tokens unlock again from another wallet

        vm.warp((epoch + 1) * DAY + 1);
        // Alice holds nothing now: she is paid for her link, and nothing from the holder share.
        vm.prank(alice);
        assertEq(vault.claim(token, _epochs(epoch)), 0.15 ether);
        // Bob is paid his half of the holder share and his link. Alice's half stays in the round.
        vm.prank(bob);
        assertEq(vault.claim(token, _epochs(epoch)), 0.05 ether + 0.15 ether);
        (uint256 pot,, uint256 claimedPot,,,,,) = vault.roundOf(token, epoch);
        assertEq(pot - claimedPot, 0.05 ether);

        // After the window it goes to the team wallet, with the launch round's unclaimed 0.04.
        vm.warp(vault.claimDeadline(epoch) + 1);
        uint256 before = team.balance;
        vault.collect(10);
        assertEq(team.balance - before, 0.05 ether + 0.04 ether);
    }

    /// @dev Two tokens share the vault. Everything one token can pay out, claimed or swept in full, never passes
    ///      what its own fees brought in, and the other token's money is still there afterwards.
    function test_12_aTokenCanNeverPayOutMoreThanItsFeesBroughtIn() public {
        (, address a) = _launch();
        address b = FLAP_BNB_TOKEN;
        vm.prank(carol);
        router.buy{value: 10 ether}(b, _path(WBNB, b), 1, block.timestamp); // 0.2 BNB of fees booked under b
        (uint256 receivedB,) = vault.ledgerOf(b);
        assertEq(receivedB, 0.2 ether * 75 / 100);
        (uint256 receivedA, uint256 paidA) = vault.ledgerOf(a);
        assertEq(receivedA, 0.075 ether, "the launch fee, less the platform share");
        assertEq(paidA, 0);

        // Drain everything token a can pay: the callout share and pool, the whole stream, and the sweeps.
        vm.warp((vault.currentEpoch() + 1) * DAY + 1 hours);
        uint256 epoch = vault.currentEpoch();
        vm.prank(carol);
        vault.deposit{value: 1 ether}(a);
        vm.startPrank(alice);
        IERC20(a).approve(address(vault), 1000e18);
        vault.stake(a, 1000e18);
        vm.stopPrank();
        _submit(alice, a, 0, "https://x.com/alice/status/12");
        vm.warp((epoch + 1) * DAY + 1 hours);
        vm.prank(alice);
        vault.claim(a, _epochs(epoch));
        vm.warp(block.timestamp + 5 days);
        vm.prank(alice);
        vault.claim(a, new uint256[](0));
        vault.collect(10);

        (receivedA, paidA) = vault.ledgerOf(a);
        assertEq(receivedA, 0.075 ether + 0.75 ether);
        assertLe(paidA, receivedA, "never more out than its fees brought in");
        assertApproxEqAbs(paidA, receivedA, 1e6, "and all of it was payable, to the last dust");

        // Token b paid only its own swept round (its 10% and 30% of 0.2 BNB): its holder stream is still there,
        // and so is every wei the two ledgers say is left.
        (, uint256 paidB) = vault.ledgerOf(b);
        assertEq(paidB, 0.08 ether);
        assertEq(vault.platformAccrued(), 0);
        assertEq(address(vault).balance, (receivedB - paidB) + (receivedA - paidA));
    }

    /// @dev Wallets can carry delegated code (EIP-7702). The attester's plain signature still counts then, and a
    ///      signature from anyone else still does not.
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
