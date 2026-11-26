// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/token/ERC20/extensions/IERC20Metadata.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {CallZPancake, CallZPancakeConfig, IPancakeFactory} from "src/callz/CallZPancake.sol";
import {CallZPancakeFactory} from "src/callz/CallZPancakeFactory.sol";
import {DeployCallZPancake} from "script/DeployCallZPancake.s.sol";

interface IPancakeRouterLike {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory);
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory);
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

interface IPancakePairLike {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function MINIMUM_LIQUIDITY() external view returns (uint256);
    function sync() external;
}

interface IWBNBLike {
    function deposit() external payable;
}

/// @dev A buyer that tries to mint and to refund again every time the mint pays it.
contract ReentrantBuyer {
    CallZPancake internal immutable target;
    uint256 public payments;
    bytes4 public mintError;
    bytes4 public refundError;

    constructor(CallZPancake target_) {
        target = target_;
    }

    function buy() external payable {
        target.mint{value: msg.value}();
    }

    function refund() external {
        target.refund();
    }

    receive() external payable {
        ++payments;
        try target.mint{value: msg.value}() {}
        catch (bytes memory reason) {
            mintError = bytes4(reason);
        }
        try target.refund() {}
        catch (bytes memory reason) {
            refundError = bytes4(reason);
        }
    }
}

/// @dev Stands where the PancakeSwap factory would be and, in the middle of the launch, tries every action of the
///      mint that called it. Pair creation itself is passed on to the real factory.
contract ReentrantPancakeFactory {
    address internal immutable real;
    CallZPancake public target;
    bool public entered;
    bytes4 public mintError;
    bytes4 public refundError;
    bytes4 public refundNFTsError;
    bytes4 public claimError;
    bytes4 public claimNFTsError;

    constructor(address real_) {
        real = real_;
    }

    /// @dev Buys NFTs, so that a refund or a claim would have something to pay if the lock failed.
    function arm(CallZPancake target_) external payable {
        target = target_;
        target_.mint{value: msg.value}();
    }

    function getPair(address a, address b) external view returns (address) {
        return IPancakeFactory(real).getPair(a, b);
    }

    function createPair(address a, address b) external returns (address) {
        entered = true;
        uint256[] memory ids = target.nftsOf(address(this));
        try target.mint{value: target.nftPrice()}() {}
        catch (bytes memory reason) {
            mintError = bytes4(reason);
        }
        try target.refund() {}
        catch (bytes memory reason) {
            refundError = bytes4(reason);
        }
        try target.refundNFTs(ids) {}
        catch (bytes memory reason) {
            refundNFTsError = bytes4(reason);
        }
        try target.claim() {}
        catch (bytes memory reason) {
            claimError = bytes4(reason);
        }
        try target.claimNFTs(ids) {}
        catch (bytes memory reason) {
            claimNFTsError = bytes4(reason);
        }
        return IPancakeFactory(real).createPair(a, b);
    }

    receive() external payable {}
}

/// @notice CallZPancake against the live PancakeSwap V2 factory, router and WBNB on a fork of BNB Chain.
///         Needs BSC_RPC_URL. Run with `forge test --isolate` so the gas test measures whole transactions.
contract CallZPancakeBSCForkTest is Test {
    address internal constant PANCAKE_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    IPancakeRouterLike internal constant ROUTER = IPancakeRouterLike(0x10ED43C718714eb63d5aA57B78B54704E256024E);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 internal constant MINIMUM_LIQUIDITY = 1000;
    /// @dev BNB Chain rejects any transaction above this much gas.
    uint256 internal constant TX_GAS_CAP = 16_777_216;

    uint256 internal constant PRICE = 0.01 ether;
    uint256 internal constant NFTS = 10;

    CallZPancakeFactory internal factory;
    // Plain numbered addresses. The usual named test accounts come from published private keys, and on BNB Chain
    // several of them carry an EIP-7702 delegation that forwards any BNB they receive.
    address internal creator = address(uint160(0xC0DE0001));
    address internal alice = address(uint160(0xC0DE0002));
    address internal bob = address(uint160(0xC0DE0003));
    address internal carol = address(uint160(0xC0DE0004));
    address internal dave = address(uint160(0xC0DE0005));
    address internal attacker = address(uint160(0xC0DE0006));
    uint256 internal saltCounter;

    function setUp() public {
        string memory rpcUrl = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpcUrl);
        require(block.chainid == 56, "BSC_RPC_URL is not BNB Chain");
        address[6] memory accounts = [creator, alice, bob, carol, dave, attacker];
        for (uint256 i; i < accounts.length; ++i) {
            require(accounts[i].code.length == 0, "a test account has code on BNB Chain");
            vm.deal(accounts[i], 20 ether);
        }
        factory = new CallZPancakeFactory(PANCAKE_FACTORY, WBNB);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _config() internal pure returns (CallZPancakeConfig memory c) {
        c.name = "Call Example";
        c.symbol = "CALLX";
        c.meta = "bafkreig4y5nwb4izyilbbmiydumvkld446d4k7j4ohg3x3q2lfel3fo4yq";
        c.nftPrice = PRICE;
        c.cap = PRICE * NFTS;
        c.saleDuration = 1 days;
        c.poolShareBps = 5000;
    }

    function _create(CallZPancakeConfig memory c) internal returns (CallZPancake mint) {
        vm.prank(creator);
        mint = CallZPancake(factory.create(c, bytes32(++saltCounter)));
    }

    function _expectInvalid(CallZPancakeConfig memory c) internal {
        vm.prank(creator);
        vm.expectRevert(CallZPancake.InvalidConfig.selector);
        factory.create(c, bytes32(++saltCounter));
    }

    function _ids(uint256 from, uint256 to) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](to - from + 1);
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = from + i;
        }
    }

    function _repeat(bytes1 char, uint256 count) internal pure returns (string memory) {
        bytes memory out = new bytes(count);
        for (uint256 i; i < count; ++i) {
            out[i] = char;
        }
        return string(out);
    }

    /// @dev The token address a mint will launch: the first contract the clone creates.
    function _predictToken(CallZPancake mint) internal pure returns (address) {
        return vm.computeCreateAddress(address(mint), 1);
    }

    /// @dev The pair's reserves, read in the pair's own token order and returned as (token, WBNB).
    function _reserves(address pair, address token) internal view returns (uint256 tokenReserve, uint256 wbnbReserve) {
        (uint112 reserve0, uint112 reserve1,) = IPancakePairLike(pair).getReserves();
        (tokenReserve, wbnbReserve) =
            IPancakePairLike(pair).token0() == token ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    /// @dev `account` holds exactly `expected`, in any order, and the list agrees with `ownerOf`.
    function _assertHolds(CallZPancake mint, address account, uint256[] memory expected) internal view {
        uint256[] memory held = mint.nftsOf(account);
        assertEq(held.length, expected.length, "number of NFTs in the holder's list");
        assertEq(mint.balanceOf(account), expected.length, "ERC721 balance");
        for (uint256 i; i < expected.length; ++i) {
            assertEq(mint.ownerOf(expected[i]), account, "ownerOf");
            bool found;
            for (uint256 j; j < held.length; ++j) {
                if (held[j] == expected[i]) found = true;
            }
            assertTrue(found, "NFT is in its holder's list");
        }
    }

    /// @dev Everything that must be true right after a launch, before any claim or trade.
    /// @param syncedDonation   WBNB that was already in the pair's reserves before the launch.
    /// @param unsyncedDonation WBNB that sat in the pair without being in its reserves.
    function _assertLaunchState(CallZPancake mint, uint256 syncedDonation, uint256 unsyncedDonation) internal view {
        assertTrue(mint.launched(), "launched");
        address token = mint.token();
        address pair = mint.pair();
        assertEq(token, _predictToken(mint), "the token is the first contract the mint created");
        assertGt(token.code.length, 0, "token deployed");
        assertEq(pair, IPancakeFactory(PANCAKE_FACTORY).getPair(token, WBNB), "the PancakeSwap pair of token and WBNB");
        assertGt(pair.code.length, 0, "pair deployed");

        uint256 raised = mint.raised();
        uint256 count = mint.maxNFTs();
        uint256 share = mint.tokensPerNFT();
        uint256 poolTokens = TOTAL_SUPPLY - share * count;
        assertEq(raised, mint.cap(), "the whole cap was raised");
        assertEq(mint.minted(), count, "sold out");
        assertEq(mint.poolTokens(), poolTokens);

        // The token: a fixed supply, split between the pair and the mint and nobody else.
        assertEq(IERC20(token).totalSupply(), TOTAL_SUPPLY, "fixed supply");
        assertEq(IERC20(token).balanceOf(pair), poolTokens, "pool tokens are in the pair");
        assertEq(IERC20(token).balanceOf(address(mint)), count * share, "the mint holds exactly every NFT's share");
        assertEq(poolTokens + count * share, TOTAL_SUPPLY, "no token is left without an owner");

        // The pair: reserves in its own token order.
        (uint256 tokenReserve, uint256 wbnbReserve) = _reserves(pair, token);
        assertEq(tokenReserve, poolTokens, "token reserve");
        assertEq(wbnbReserve, raised + syncedDonation + unsyncedDonation, "WBNB reserve");
        assertEq(IERC20(WBNB).balanceOf(pair), wbnbReserve, "WBNB in the pair");

        // The LP: all of it burned.
        IPancakePairLike lp = IPancakePairLike(pair);
        uint256 lpSupply = lp.totalSupply();
        assertEq(lp.MINIMUM_LIQUIDITY(), MINIMUM_LIQUIDITY);
        assertEq(lpSupply, FixedPointMathLib.sqrt(poolTokens * (raised + unsyncedDonation)), "LP minted");
        assertEq(lp.balanceOf(address(0)), MINIMUM_LIQUIDITY, "the pair's own minimum liquidity");
        assertEq(lp.balanceOf(DEAD), lpSupply - MINIMUM_LIQUIDITY, "every other LP token is at the dead address");
        assertEq(lp.balanceOf(address(mint)), 0, "the mint holds no LP");

        // The mint: nothing left but the NFTs' tokens.
        assertEq(address(mint).balance, 0, "no BNB left in the mint");
        assertEq(IERC20(WBNB).balanceOf(address(mint)), 0, "no WBNB left in the mint");
    }

    function _launchedLog(Vm.Log[] memory logs, address emitter) internal pure returns (Vm.Log memory found) {
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == CallZPancake.Launched.selector) {
                found = logs[i];
                ++count;
            }
        }
        require(count == 1, "expected exactly one Launched event");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_01_fullJourneyIntoAPancakePool() public {
        // The addresses the deploy script uses are the ones the live router trades on.
        assertEq(ROUTER.factory(), PANCAKE_FACTORY, "PancakeSwap V2 factory");
        assertEq(ROUTER.WETH(), WBNB, "WBNB");

        CallZPancakeConfig memory c = _config();
        bytes32 salt = bytes32(++saltCounter);
        address predicted = factory.predict(creator, salt);
        vm.expectEmit(true, true, false, true, address(factory));
        emit CallZPancakeFactory.CallZPancakeCreated(predicted, creator, c.name, c.symbol, c.nftPrice, c.cap);
        vm.prank(creator);
        CallZPancake mint = CallZPancake(factory.create(c, salt));

        assertEq(address(mint), predicted, "the mint address is known before creation");
        assertEq(factory.mintCount(), 1);
        assertEq(factory.mints(0), address(mint));
        assertEq(mint.pancakeFactory(), PANCAKE_FACTORY);
        assertEq(mint.wbnb(), WBNB);
        assertEq(mint.creator(), creator);
        assertEq(mint.tokenName(), "Call Example");
        assertEq(mint.tokenSymbol(), "CALLX");
        assertEq(mint.meta(), c.meta);
        assertEq(mint.nftPrice(), PRICE);
        assertEq(mint.cap(), PRICE * NFTS);
        assertEq(mint.targetRaise(), PRICE * NFTS);
        assertEq(mint.maxNFTs(), NFTS, "cap / nftPrice NFTs are for sale");
        assertEq(mint.saleDeadline(), block.timestamp + 1 days);
        assertEq(mint.poolShareBps(), 5000);
        assertEq(mint.version(), "1.0.0");
        assertEq(mint.name(), "Call Example CallZ Pass");
        assertEq(mint.symbol(), "CALLX-PASS");
        uint256 share = TOTAL_SUPPLY / 2 / NFTS;
        assertEq(mint.tokensPerNFT(), share, "the planned share is readable before the launch");
        assertEq(mint.poolTokens(), TOTAL_SUPPLY / 2);
        assertEq(mint.raised(), 0);
        assertEq(mint.minted(), 0);
        assertFalse(mint.launched());
        assertFalse(mint.refundAvailable());
        assertEq(mint.token(), address(0));
        assertEq(mint.pair(), address(0));

        // Alice mints 4 NFTs and sells one to Bob before the launch.
        vm.expectEmit(true, false, false, true, address(mint));
        emit CallZPancake.Minted(alice, 1, 4, 4 * PRICE);
        vm.prank(alice);
        mint.mint{value: 4 * PRICE}();
        assertFalse(mint.launched(), "cap not reached yet");
        assertEq(mint.raised(), 4 * PRICE);
        assertEq(address(mint).balance, 4 * PRICE);
        vm.prank(alice);
        mint.transferFrom(alice, bob, 4);
        vm.prank(alice);
        vm.expectRevert(CallZPancake.NotLaunched.selector);
        mint.claim();
        assertEq(mint.claimableOf(alice), 0, "nothing to claim before the launch");

        vm.prank(bob);
        mint.mint{value: 3 * PRICE}();
        assertFalse(mint.launched());
        assertEq(mint.token(), address(0), "no token before the cap");

        // Carol mints the last 3: that mint deploys the token and seeds the pool with the whole raise.
        vm.recordLogs();
        vm.prank(carol);
        mint.mint{value: 3 * PRICE}();
        Vm.Log memory log = _launchedLog(vm.getRecordedLogs(), address(mint));

        _assertLaunchState(mint, 0, 0);
        address token = mint.token();
        address pair = mint.pair();
        assertEq(mint.tokensPerNFT(), share, "the real share is the planned one");
        assertEq(address(uint160(uint256(log.topics[1]))), token, "Launched: token");
        assertEq(address(uint160(uint256(log.topics[2]))), pair, "Launched: pair");
        assertEq(
            log.data, abi.encode(PRICE * NFTS, TOTAL_SUPPLY / 2, share), "Launched: raised, poolTokens, tokensPerNFT"
        );
        assertEq(IERC20Metadata(token).name(), "Call Example");
        assertEq(IERC20Metadata(token).symbol(), "CALLX");
        assertEq(IERC20Metadata(token).decimals(), 18);

        // Each NFT claims an equal share, once, to whoever holds it.
        assertEq(mint.claimableOf(alice), 3 * share);
        assertEq(mint.claimableOf(bob), 4 * share);
        assertEq(mint.claimableOf(carol), 3 * share);
        vm.expectEmit(true, true, false, true, address(mint));
        emit CallZPancake.Claimed(1, alice, share);
        vm.prank(alice);
        mint.claimNFTs(_ids(1, 1));
        assertEq(mint.claimableOf(alice), 2 * share);
        vm.prank(alice);
        mint.claim();
        assertEq(IERC20(token).balanceOf(alice), 3 * share, "alice holds 3 NFTs");
        vm.prank(bob);
        mint.claim();
        assertEq(IERC20(token).balanceOf(bob), 4 * share, "bob holds 4 NFTs, one bought from alice");
        vm.prank(carol);
        mint.claim();
        assertEq(IERC20(token).balanceOf(carol), 3 * share);
        assertEq(IERC20(token).balanceOf(address(mint)), 0, "every share has been claimed");
        assertEq(mint.claimableOf(alice), 0);

        // An NFT claims once and stays with its holder.
        vm.prank(alice);
        vm.expectRevert(CallZPancake.NothingToClaim.selector);
        mint.claim();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallZPancake.AlreadyClaimed.selector, 1));
        mint.claimNFTs(_ids(1, 1));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallZPancake.NotHolder.selector, 5));
        mint.claimNFTs(_ids(5, 5));
        _assertHolds(mint, alice, _ids(1, 3));
        _assertHolds(mint, bob, _ids(4, 7));
        _assertHolds(mint, carol, _ids(8, 10));
        assertTrue(mint.claimed(1));
        assertGt(bytes(mint.tokenURI(1)).length, 0);

        // A claimed NFT that changes hands does not claim again.
        vm.prank(alice);
        mint.transferFrom(alice, dave, 1);
        assertEq(mint.claimableOf(dave), 0);
        vm.prank(dave);
        vm.expectRevert(CallZPancake.NothingToClaim.selector);
        mint.claim();

        // The mint is over and nothing can be refunded.
        vm.prank(bob);
        vm.expectRevert(CallZPancake.AlreadyLaunched.selector);
        mint.mint{value: PRICE}();
        assertFalse(mint.refundAvailable());
        assertEq(mint.refundableOf(bob), 0);
        vm.prank(bob);
        vm.expectRevert(CallZPancake.RefundUnavailable.selector);
        mint.refund();
        vm.warp(mint.saleDeadline());
        assertFalse(mint.refundAvailable(), "no refund after a launch, even past the deadline");
        vm.prank(bob);
        vm.expectRevert(CallZPancake.RefundUnavailable.selector);
        mint.refundNFTs(_ids(5, 5));

        // A real buy through the PancakeSwap router. The buyer receives exactly the router's quote: no tax.
        address[] memory buyPath = new address[](2);
        buyPath[0] = WBNB;
        buyPath[1] = token;
        uint256 buyQuote = ROUTER.getAmountsOut(0.01 ether, buyPath)[1];
        assertGt(buyQuote, 0);
        vm.prank(dave);
        ROUTER.swapExactETHForTokens{value: 0.01 ether}(buyQuote, buyPath, dave, block.timestamp);
        assertEq(IERC20(token).balanceOf(dave), buyQuote, "the buy delivered the quoted amount");

        // A real sell of claimed tokens. The pair receives exactly what was sold and pays the router's quote.
        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = WBNB;
        uint256 sellAmount = share;
        uint256 sellQuote = ROUTER.getAmountsOut(sellAmount, sellPath)[1];
        assertGt(sellQuote, 0);
        uint256 pairTokensBefore = IERC20(token).balanceOf(pair);
        uint256 aliceBnbBefore = alice.balance;
        vm.startPrank(alice);
        IERC20(token).approve(address(ROUTER), sellAmount);
        ROUTER.swapExactTokensForETH(sellAmount, sellQuote, sellPath, alice, block.timestamp);
        vm.stopPrank();
        assertEq(IERC20(token).balanceOf(pair), pairTokensBefore + sellAmount, "the sell reached the pair in full");
        assertEq(IERC20(token).balanceOf(alice), 3 * share - sellAmount);
        assertEq(alice.balance, aliceBnbBefore + sellQuote, "the sell paid the quoted BNB");

        // Trading does not create or free any LP.
        IPancakePairLike lp = IPancakePairLike(pair);
        assertEq(lp.balanceOf(DEAD), lp.totalSupply() - MINIMUM_LIQUIDITY);
        assertEq(IERC20(token).totalSupply(), TOTAL_SUPPLY, "the supply never changes");

        emit log_named_uint("tokens per NFT (wei)", share);
        emit log_named_uint("LP burned (wei)", lp.balanceOf(DEAD));
    }

    function test_02_overflowOnTheLastMintIsRefunded() public {
        CallZPancake mint = _create(_config());

        vm.prank(alice);
        mint.mint{value: 8 * PRICE}();

        // Bob asks for 5 but only 2 are left: he gets 2, the launch runs, and 3 prices come back.
        uint256 before_ = bob.balance;
        vm.expectEmit(true, false, false, true, address(mint));
        emit CallZPancake.Minted(bob, 9, 2, 2 * PRICE);
        vm.prank(bob);
        mint.mint{value: 5 * PRICE}();

        assertEq(mint.balanceOf(bob), 2, "bob got what was left");
        assertEq(bob.balance, before_ - 2 * PRICE, "bob paid for 2 and got the rest back");
        assertEq(mint.minted(), NFTS);
        assertEq(mint.raised(), PRICE * NFTS, "the raise landed exactly on the cap");
        // Bob's change went back to him and not into the pool: the pool holds exactly the cap.
        _assertLaunchState(mint, 0, 0);
    }

    function test_03_burnToRefundWhenTheCapIsMissed() public {
        CallZPancake mint = _create(_config());

        vm.prank(alice);
        mint.mint{value: 4 * PRICE}();
        vm.prank(alice);
        mint.transferFrom(alice, bob, 2);
        // The holder lists follow the transfer.
        uint256[] memory aliceIds = new uint256[](3);
        aliceIds[0] = 1;
        aliceIds[1] = 3;
        aliceIds[2] = 4;
        _assertHolds(mint, alice, aliceIds);
        _assertHolds(mint, bob, _ids(2, 2));

        vm.prank(alice);
        vm.expectRevert(CallZPancake.RefundUnavailable.selector);
        mint.refund();
        assertEq(mint.refundableOf(alice), 0);

        vm.warp(mint.saleDeadline());
        assertTrue(mint.refundAvailable());
        assertEq(mint.refundableOf(alice), 3 * PRICE);
        assertEq(mint.refundableOf(bob), PRICE);

        // The sale is closed for good: even a mint that would reach the cap is refused, so no launch can follow.
        vm.prank(carol);
        vm.expectRevert(CallZPancake.SaleClosed.selector);
        mint.mint{value: 6 * PRICE}();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallZPancake.NotHolder.selector, 2));
        mint.refundNFTs(_ids(2, 2));
        vm.expectEmit(true, true, false, true, address(mint));
        emit CallZPancake.Refunded(3, alice, PRICE);
        vm.prank(alice);
        mint.refundNFTs(_ids(3, 3));
        aliceIds = new uint256[](2);
        aliceIds[0] = 1;
        aliceIds[1] = 4;
        _assertHolds(mint, alice, aliceIds);
        assertEq(mint.raised(), 3 * PRICE);
        assertEq(address(mint).balance, 3 * PRICE);
        vm.prank(alice);
        mint.refund();
        assertEq(alice.balance, 20 ether - PRICE, "alice got three of her four prices back");
        vm.prank(bob);
        mint.refund();
        assertEq(bob.balance, 20 ether + PRICE, "the refund follows the NFT");

        assertEq(mint.burned(), 4);
        assertEq(mint.raised(), 0);
        assertEq(address(mint).balance, 0);
        _assertHolds(mint, alice, new uint256[](0));
        _assertHolds(mint, bob, new uint256[](0));
        vm.expectRevert();
        mint.ownerOf(1);
        vm.prank(alice);
        vm.expectRevert(CallZPancake.NothingToRefund.selector);
        mint.refund();
        vm.prank(alice);
        vm.expectRevert(CallZPancake.NothingToRefund.selector);
        mint.refundNFTs(new uint256[](0));

        // Nothing was launched and nothing can be: no token, no pair, no claim, no mint.
        assertFalse(mint.launched());
        assertEq(mint.token(), address(0));
        assertEq(mint.pair(), address(0));
        address neverDeployed = _predictToken(mint);
        assertEq(neverDeployed.code.length, 0, "no token was deployed");
        assertEq(IPancakeFactory(PANCAKE_FACTORY).getPair(neverDeployed, WBNB), address(0), "no pair was created");
        vm.prank(alice);
        vm.expectRevert(CallZPancake.NotLaunched.selector);
        mint.claim();
        vm.prank(carol);
        vm.expectRevert(CallZPancake.SaleClosed.selector);
        mint.mint{value: NFTS * PRICE}();
        vm.warp(mint.saleDeadline() + 365 days);
        vm.prank(carol);
        vm.expectRevert(CallZPancake.SaleClosed.selector);
        mint.mint{value: 6 * PRICE}();
    }

    function test_04_configRules() public {
        CallZPancakeConfig memory c;

        // Name: 1 to 64 bytes.
        c = _config();
        c.name = "";
        _expectInvalid(c);
        c.name = _repeat("N", 65);
        _expectInvalid(c);
        c.name = _repeat("N", 64);
        assertEq(bytes(_create(c).tokenName()).length, 64);
        c.name = "N";
        _create(c);

        // Symbol: 1 to 32 bytes.
        c = _config();
        c.symbol = "";
        _expectInvalid(c);
        c.symbol = _repeat("S", 33);
        _expectInvalid(c);
        c.symbol = _repeat("S", 32);
        assertEq(bytes(_create(c).tokenSymbol()).length, 32);
        c.symbol = "S";
        _create(c);

        // Metadata reference: up to 128 bytes, may be empty.
        c = _config();
        c.meta = _repeat("m", 129);
        _expectInvalid(c);
        c.meta = _repeat("m", 128);
        assertEq(bytes(_create(c).meta()).length, 128);
        c.meta = "";
        assertEq(bytes(_create(c).meta()).length, 0);

        // The price is not zero.
        c = _config();
        c.nftPrice = 0;
        _expectInvalid(c);
        c.nftPrice = 1;
        c.cap = 1;
        assertEq(_create(c).maxNFTs(), 1, "the smallest mint: one NFT for one wei");

        // The cap is not zero and is an exact multiple of the price.
        c = _config();
        c.cap = 0;
        _expectInvalid(c);
        c.cap = PRICE * NFTS + 1;
        _expectInvalid(c);
        c.cap = PRICE * NFTS - 1;
        _expectInvalid(c);
        c.cap = PRICE / 2;
        _expectInvalid(c);
        c.cap = PRICE;
        assertEq(_create(c).maxNFTs(), 1);

        // The cap is at most 10 BNB.
        c = _config();
        c.nftPrice = 1 ether;
        c.cap = 11 ether;
        _expectInvalid(c);
        c.nftPrice = 10 ether + 1;
        c.cap = 10 ether + 1;
        _expectInvalid(c);
        c.nftPrice = 1 ether;
        c.cap = 10 ether;
        assertEq(_create(c).maxNFTs(), 10);
        c.nftPrice = 10 ether;
        assertEq(_create(c).maxNFTs(), 1);

        // At most 10,000 NFTs.
        c = _config();
        c.nftPrice = 0.0001 ether;
        c.cap = 10_001 * 0.0001 ether;
        _expectInvalid(c);
        c.cap = 10_000 * 0.0001 ether;
        assertEq(_create(c).maxNFTs(), 10_000);

        // The mint window is 10 minutes to 30 days.
        c = _config();
        c.saleDuration = 10 minutes - 1;
        _expectInvalid(c);
        c.saleDuration = 0;
        _expectInvalid(c);
        c.saleDuration = 10 minutes;
        assertEq(_create(c).saleDeadline(), block.timestamp + 10 minutes);
        c.saleDuration = 30 days;
        assertEq(_create(c).saleDeadline(), block.timestamp + 30 days);
        c.saleDuration = 30 days + 1;
        _expectInvalid(c);

        // The pool takes 10% to 90% of the supply.
        c = _config();
        c.poolShareBps = 999;
        _expectInvalid(c);
        c.poolShareBps = 0;
        _expectInvalid(c);
        c.poolShareBps = 1000;
        assertEq(_create(c).poolShareBps(), 1000);
        c.poolShareBps = 9000;
        assertEq(_create(c).poolShareBps(), 9000);
        c.poolShareBps = 9001;
        _expectInvalid(c);
        c.poolShareBps = 10_000;
        _expectInvalid(c);

        // Neither the factory nor a mint accepts a zero address.
        vm.expectRevert(CallZPancakeFactory.ZeroAddress.selector);
        new CallZPancakeFactory(address(0), WBNB);
        vm.expectRevert(CallZPancakeFactory.ZeroAddress.selector);
        new CallZPancakeFactory(PANCAKE_FACTORY, address(0));
        c = _config();
        CallZPancake raw = CallZPancake(LibClone.clone(factory.implementation()));
        vm.expectRevert(CallZPancake.InvalidConfig.selector);
        raw.initialize(address(0), WBNB, creator, c);
        vm.expectRevert(CallZPancake.InvalidConfig.selector);
        raw.initialize(PANCAKE_FACTORY, address(0), creator, c);
        vm.expectRevert(CallZPancake.InvalidConfig.selector);
        raw.initialize(PANCAKE_FACTORY, WBNB, address(0), c);
    }

    function test_05_mintGuards() public {
        CallZPancakeConfig memory c = _config();
        c.cap = 100 * PRICE;
        CallZPancake mint = _create(c);

        vm.startPrank(alice);
        vm.expectRevert(CallZPancake.ZeroQuantity.selector);
        mint.mint();
        vm.expectRevert(CallZPancake.ZeroQuantity.selector);
        mint.mint{value: PRICE - 1}();
        vm.expectRevert(abi.encodeWithSelector(CallZPancake.WrongPayment.selector, PRICE + 1, PRICE));
        mint.mint{value: PRICE + 1}();
        vm.expectRevert(abi.encodeWithSelector(CallZPancake.WrongPayment.selector, 3 * PRICE - 1, 2 * PRICE));
        mint.mint{value: 3 * PRICE - 1}();
        // At most 50 NFTs per call.
        vm.expectRevert(CallZPancake.MintTooLarge.selector);
        mint.mint{value: 51 * PRICE}();
        mint.mint{value: 50 * PRICE}();
        vm.stopPrank();
        assertEq(mint.balanceOf(alice), 50);
        assertEq(mint.raised(), 50 * PRICE);

        // BNB cannot be sent to the mint directly, with or without data.
        vm.prank(alice);
        (bool ok,) = address(mint).call{value: 1 ether}("");
        assertFalse(ok, "direct payments are rejected");
        vm.prank(alice);
        (ok,) = address(mint).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok, "payments to unknown functions are rejected");
        assertEq(address(mint).balance, 50 * PRICE);

        // Nothing to claim or refund while the mint is open.
        vm.startPrank(alice);
        vm.expectRevert(CallZPancake.NotLaunched.selector);
        mint.claim();
        vm.expectRevert(CallZPancake.NotLaunched.selector);
        mint.claimNFTs(_ids(1, 1));
        vm.expectRevert(CallZPancake.RefundUnavailable.selector);
        mint.refund();
        vm.expectRevert(CallZPancake.RefundUnavailable.selector);
        mint.refundNFTs(_ids(1, 1));
        vm.stopPrank();

        // One second before the deadline a mint still goes through; at the deadline it does not.
        vm.warp(mint.saleDeadline() - 1);
        vm.prank(bob);
        mint.mint{value: PRICE}();
        vm.warp(mint.saleDeadline());
        vm.prank(bob);
        vm.expectRevert(CallZPancake.SaleClosed.selector);
        mint.mint{value: PRICE}();

        // After a launch nothing more can be minted, and an empty claim list is refused.
        CallZPancake sold = _create(_config());
        vm.prank(alice);
        sold.mint{value: NFTS * PRICE}();
        assertTrue(sold.launched());
        vm.startPrank(alice);
        vm.expectRevert(CallZPancake.AlreadyLaunched.selector);
        sold.mint{value: PRICE}();
        vm.expectRevert(CallZPancake.NothingToClaim.selector);
        sold.claimNFTs(new uint256[](0));
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(CallZPancake.NothingToClaim.selector);
        sold.claim();
    }

    /// @dev The state the router cannot handle: the pair exists and holds WBNB in its reserves, with no tokens.
    ///      On BNB Chain `sync()` cannot run on a pair before both of its tokens exist, so the test first shows
    ///      that the attacker's own `sync()` reverts, and then forces the same reserves a successful `sync()`
    ///      would have written. In that state `addLiquidityETH` reverts and the launch still succeeds.
    function test_06_poisonedPreCreatedPairStillLaunches() public {
        CallZPancake mint = _create(_config());
        vm.prank(alice);
        mint.mint{value: 8 * PRICE}();

        // The attacker predicts the token address, creates the pair first and sends WBNB to it.
        address predicted = _predictToken(mint);
        uint256 donation = 0.05 ether;
        vm.startPrank(attacker);
        address pair = IPancakeFactory(PANCAKE_FACTORY).createPair(predicted, WBNB);
        IWBNBLike(WBNB).deposit{value: donation}();
        IERC20(WBNB).transfer(pair, donation);
        vm.stopPrank();

        // On the live pair, sync() reads the balance of a token that has no code yet, and reverts.
        vm.prank(attacker);
        vm.expectRevert();
        IPancakePairLike(pair).sync();

        // Force the poisoned state all the same: give the token address code that answers zero to any call, let
        // the attacker's sync() go through, then remove that code again.
        vm.etch(predicted, hex"60206000f3");
        vm.prank(attacker);
        IPancakePairLike(pair).sync();
        vm.etch(predicted, "");
        assertEq(predicted.code.length, 0);
        (uint256 tokenReserve, uint256 wbnbReserve) = _reserves(pair, predicted);
        assertEq(tokenReserve, 0, "poisoned: no token reserve");
        assertEq(wbnbReserve, donation, "poisoned: WBNB reserve");

        // The router can no longer add liquidity to this pair.
        vm.prank(attacker);
        vm.expectRevert(bytes("PancakeLibrary: INSUFFICIENT_LIQUIDITY"));
        ROUTER.addLiquidityETH{value: 0.1 ether}(predicted, 1 ether, 0, 0, DEAD, block.timestamp);

        // The launch does not go through the router, and succeeds.
        vm.prank(bob);
        mint.mint{value: 2 * PRICE}();

        assertEq(mint.pair(), pair, "the launch used the pair the attacker created");
        // The attacker's WBNB is now pool liquidity that nobody can take out.
        _assertLaunchState(mint, donation, 0);
        assertEq(IERC20(WBNB).balanceOf(attacker), 0);
        assertEq(IPancakePairLike(pair).balanceOf(attacker), 0, "the attacker holds no LP");

        // Claims and trading work as usual.
        uint256 share = mint.tokensPerNFT();
        vm.prank(alice);
        mint.claim();
        assertEq(IERC20(mint.token()).balanceOf(alice), 8 * share);
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = mint.token();
        uint256 quote = ROUTER.getAmountsOut(0.01 ether, path)[1];
        vm.prank(dave);
        ROUTER.swapExactETHForTokens{value: 0.01 ether}(quote, path, dave, block.timestamp);
        assertEq(IERC20(mint.token()).balanceOf(dave), quote);
    }

    /// @dev What an attacker can really do before the token exists: create the pair and send WBNB to it.
    function test_07_preCreatedPairHoldingDonatedWbnbStillLaunches() public {
        CallZPancake mint = _create(_config());
        vm.prank(alice);
        mint.mint{value: 8 * PRICE}();

        address predicted = _predictToken(mint);
        uint256 donation = 0.05 ether;
        vm.startPrank(attacker);
        address pair = IPancakeFactory(PANCAKE_FACTORY).createPair(predicted, WBNB);
        IWBNBLike(WBNB).deposit{value: donation}();
        IERC20(WBNB).transfer(pair, donation);
        vm.stopPrank();
        (uint256 tokenReserve, uint256 wbnbReserve) = _reserves(pair, predicted);
        assertEq(tokenReserve + wbnbReserve, 0, "the donation is not in the reserves");

        vm.prank(bob);
        mint.mint{value: 2 * PRICE}();

        assertEq(mint.pair(), pair);
        // The donation joined the pool with the raise; all the LP it earned is burned with the rest.
        _assertLaunchState(mint, 0, donation);
        assertEq(IPancakePairLike(pair).balanceOf(attacker), 0);
    }

    function test_08_preCreatedEmptyPairStillLaunches() public {
        CallZPancake mint = _create(_config());
        vm.prank(alice);
        mint.mint{value: 8 * PRICE}();

        address predicted = _predictToken(mint);
        vm.prank(attacker);
        address pair = IPancakeFactory(PANCAKE_FACTORY).createPair(predicted, WBNB);
        assertEq(IPancakeFactory(PANCAKE_FACTORY).getPair(predicted, WBNB), pair);

        vm.prank(bob);
        mint.mint{value: 2 * PRICE}();

        assertEq(mint.pair(), pair, "the launch used the existing pair");
        _assertLaunchState(mint, 0, 0);
    }

    function test_09_reinitialiseIsBlocked() public {
        CallZPancakeConfig memory c = _config();
        CallZPancake mint = _create(c);

        // A clone is initialised once, by the factory, in the transaction that deploys it.
        vm.prank(creator);
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        mint.initialize(PANCAKE_FACTORY, WBNB, creator, c);
        vm.prank(attacker);
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        mint.initialize(attacker, attacker, attacker, c);
        assertEq(mint.creator(), creator);
        assertEq(mint.pancakeFactory(), PANCAKE_FACTORY);

        // The implementation is locked from its constructor on: it can never be initialised or take a mint.
        CallZPancake impl = CallZPancake(factory.implementation());
        vm.prank(attacker);
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        impl.initialize(PANCAKE_FACTORY, WBNB, attacker, c);
        assertEq(impl.creator(), address(0));
        assertEq(impl.cap(), 0);
        vm.prank(attacker);
        vm.expectRevert(CallZPancake.SaleClosed.selector);
        impl.mint{value: PRICE}();

        // Still blocked after the launch.
        vm.prank(alice);
        mint.mint{value: NFTS * PRICE}();
        assertTrue(mint.launched());
        vm.prank(attacker);
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        mint.initialize(attacker, attacker, attacker, c);

        // The same creator and salt cannot deploy twice; another creator with that salt gets another address.
        bytes32 salt = bytes32(saltCounter);
        vm.prank(creator);
        vm.expectRevert();
        factory.create(c, salt);
        assertTrue(factory.predict(attacker, salt) != address(mint));
        vm.prank(attacker);
        address other = factory.create(c, salt);
        assertEq(other, factory.predict(attacker, salt));
        assertEq(CallZPancake(other).creator(), attacker);
        assertEq(factory.mintCount(), 2);
    }

    function test_10_reentryThroughPaymentsGainsNothing() public {
        // Missed cap: a holder that calls back when it is refunded gets its price once.
        CallZPancake missed = _create(_config());
        ReentrantBuyer holder = new ReentrantBuyer(missed);
        holder.buy{value: 3 * PRICE}();
        vm.prank(alice);
        missed.mint{value: 2 * PRICE}();
        vm.warp(missed.saleDeadline());
        holder.refund();
        assertEq(holder.payments(), 1);
        assertEq(address(holder).balance, 3 * PRICE, "refunded once");
        assertEq(holder.mintError(), CallZPancake.SaleClosed.selector);
        assertEq(holder.refundError(), CallZPancake.NothingToRefund.selector);
        assertEq(address(missed).balance, 2 * PRICE, "alice's BNB is untouched");
        assertEq(missed.raised(), 2 * PRICE);
        vm.prank(alice);
        missed.refund();
        assertEq(address(missed).balance, 0);

        // Reached cap: a last buyer that calls back when it gets its change cannot mint or refund.
        CallZPancake sold = _create(_config());
        ReentrantBuyer last = new ReentrantBuyer(sold);
        vm.prank(alice);
        sold.mint{value: 8 * PRICE}();
        last.buy{value: 5 * PRICE}();
        assertEq(last.payments(), 1);
        assertEq(address(last).balance, 3 * PRICE, "change returned once");
        assertEq(last.mintError(), CallZPancake.AlreadyLaunched.selector);
        assertEq(last.refundError(), CallZPancake.RefundUnavailable.selector);
        assertEq(sold.balanceOf(address(last)), 2);
        _assertLaunchState(sold, 0, 0);
    }

    /// @dev The lock that covers the launch itself. A stand-in for the PancakeSwap factory calls back into the
    ///      mint from inside the launch; every action is refused and the launch completes untouched.
    function test_11_nothingCanReenterDuringTheLaunch() public {
        ReentrantPancakeFactory hostile = new ReentrantPancakeFactory(PANCAKE_FACTORY);
        CallZPancakeFactory hostileFactory = new CallZPancakeFactory(address(hostile), WBNB);
        vm.prank(creator);
        CallZPancake mint = CallZPancake(hostileFactory.create(_config(), bytes32(uint256(1))));

        hostile.arm{value: 2 * PRICE}(mint);
        vm.deal(address(hostile), 1 ether);
        vm.prank(alice);
        mint.mint{value: 8 * PRICE}();

        assertTrue(hostile.entered(), "the stand-in factory was called during the launch");
        assertEq(hostile.mintError(), CallZPancake.LaunchInProgress.selector);
        assertEq(hostile.refundError(), CallZPancake.RefundUnavailable.selector);
        assertEq(hostile.refundNFTsError(), CallZPancake.RefundUnavailable.selector);
        assertEq(hostile.claimError(), CallZPancake.NotLaunched.selector);
        assertEq(hostile.claimNFTsError(), CallZPancake.NotLaunched.selector);
        assertEq(address(hostile).balance, 1 ether, "nothing was paid out during the launch");
        assertEq(mint.balanceOf(address(hostile)), 2);
        _assertLaunchState(mint, 0, 0);
    }

    /// @dev If the launch cannot complete, the mint that would have triggered it reverts as a whole, and every
    ///      buyer can still get the price back after the deadline.
    function test_12_aLaunchThatCannotCompleteLeavesRefundsOpen() public {
        CallZPancake mint = _create(_config());
        vm.prank(alice);
        mint.mint{value: 8 * PRICE}();

        vm.mockCallRevert(
            PANCAKE_FACTORY, abi.encodeWithSelector(IPancakeFactory.createPair.selector), bytes("pair creation is down")
        );
        vm.prank(bob);
        vm.expectRevert(bytes("pair creation is down"));
        mint.mint{value: 2 * PRICE}();

        assertFalse(mint.launched());
        assertEq(mint.minted(), 8, "the failed mint left no trace");
        assertEq(mint.raised(), 8 * PRICE);
        assertEq(address(mint).balance, 8 * PRICE);
        assertEq(mint.balanceOf(bob), 0);
        assertEq(bob.balance, 20 ether);
        assertEq(_predictToken(mint).code.length, 0, "the token deployment was rolled back with the rest");

        vm.warp(mint.saleDeadline());
        vm.prank(alice);
        mint.refund();
        assertEq(alice.balance, 20 ether, "alice got everything back");
        assertEq(address(mint).balance, 0);
        vm.clearMockedCalls();
    }

    /// @dev BNB Chain rejects any transaction above 16,777,216 gas. Run with `forge test --isolate`.
    ///      The heaviest transaction: 50 NFTs to a buyer who held none, the longest name, symbol and metadata,
    ///      a pair that does not exist yet, and change to return.
    function test_13_theHeaviestTransactionFitsTheGasCap() public {
        CallZPancakeConfig memory c = _config();
        c.name = _repeat("N", 64);
        c.symbol = _repeat("S", 32);
        c.meta = _repeat("m", 128);
        c.cap = 70 * PRICE;
        CallZPancake mint = _create(c);

        vm.prank(alice);
        mint.mint{value: 10 * PRICE}();
        // 60 are left: more than the per-call maximum is refused.
        vm.prank(bob);
        vm.expectRevert(CallZPancake.MintTooLarge.selector);
        mint.mint{value: 51 * PRICE}();

        vm.prank(alice);
        mint.mint{value: 10 * PRICE}();
        uint256 before_ = bob.balance;
        vm.prank(bob);
        mint.mint{value: 55 * PRICE}();
        uint256 launchGas = vm.lastCallGas().gasTotalUsed;

        assertEq(mint.balanceOf(bob), 50);
        assertEq(bob.balance, before_ - 50 * PRICE);
        _assertLaunchState(mint, 0, 0);
        assertLt(launchGas, TX_GAS_CAP, "largest mint + launch fits BNB Chain's per-transaction gas cap");
        assertLt(launchGas, TX_GAS_CAP * 3 / 4, "largest mint + launch leaves a quarter of the cap spare");
        emit log_named_uint("mint 50 NFTs + token + pair + liquidity, gas", launchGas);
        emit log_named_uint("share of the gas cap used, bps", launchGas * 10_000 / TX_GAS_CAP);

        // The other two calls that grow with the number of NFTs held, measured for 50 NFTs. A holder with more
        // NFTs than one call can carry uses claimNFTs / refundNFTs in batches.
        vm.prank(bob);
        mint.claim();
        uint256 claimGas = vm.lastCallGas().gasTotalUsed;
        assertEq(IERC20(mint.token()).balanceOf(bob), 50 * mint.tokensPerNFT());
        assertLt(claimGas, TX_GAS_CAP);
        emit log_named_uint("claim() for 50 NFTs, gas", claimGas);

        CallZPancake missed = _create(c);
        vm.prank(carol);
        missed.mint{value: 50 * PRICE}();
        vm.warp(missed.saleDeadline());
        vm.prank(carol);
        missed.refund();
        uint256 refundGas = vm.lastCallGas().gasTotalUsed;
        assertEq(carol.balance, 20 ether);
        assertLt(refundGas, TX_GAS_CAP);
        emit log_named_uint("refund() for 50 NFTs, gas", refundGas);
    }

    function test_14_bothEndsOfThePoolShareRangeLaunch() public {
        // 10% to the pool, and a number of NFTs that does not divide the rest evenly.
        CallZPancakeConfig memory low = _config();
        low.poolShareBps = 1000;
        low.cap = 7 * PRICE;
        CallZPancake a = _create(low);
        uint256 lowShare = (TOTAL_SUPPLY - TOTAL_SUPPLY / 10) / 7;
        uint256 dust = (TOTAL_SUPPLY - TOTAL_SUPPLY / 10) - 7 * lowShare;
        assertEq(dust, 4, "this split leaves 4 wei of token over");
        assertEq(a.tokensPerNFT(), lowShare);
        vm.prank(alice);
        a.mint{value: 7 * PRICE}();
        _assertLaunchState(a, 0, 0);
        (uint256 tokenReserve, uint256 wbnbReserve) = _reserves(a.pair(), a.token());
        assertEq(tokenReserve, TOTAL_SUPPLY / 10 + dust, "10% of the supply, plus the dust, is in the pool");
        assertEq(wbnbReserve, 7 * PRICE);
        assertEq(a.tokensPerNFT(), lowShare);
        vm.prank(alice);
        a.claim();
        assertEq(IERC20(a.token()).balanceOf(alice), 7 * lowShare);
        assertEq(IERC20(a.token()).balanceOf(address(a)), 0, "nothing is stranded in the mint");

        // 90% to the pool.
        CallZPancakeConfig memory high = _config();
        high.poolShareBps = 9000;
        CallZPancake b = _create(high);
        uint256 highShare = TOTAL_SUPPLY / 10 / NFTS;
        assertEq(b.tokensPerNFT(), highShare);
        vm.prank(bob);
        b.mint{value: NFTS * PRICE}();
        _assertLaunchState(b, 0, 0);
        (tokenReserve, wbnbReserve) = _reserves(b.pair(), b.token());
        assertEq(tokenReserve, TOTAL_SUPPLY * 9 / 10, "90% of the supply is in the pool");
        assertEq(wbnbReserve, NFTS * PRICE);
        vm.prank(bob);
        b.claim();
        assertEq(IERC20(b.token()).balanceOf(bob), NFTS * highShare);
        assertEq(IERC20(b.token()).balanceOf(address(b)), 0);
    }

    /// @dev Runs the deploy script itself on the fork. Nothing is sent to BNB Chain.
    function test_15_theDeployScriptDeploysAWorkingFactory() public {
        CallZPancakeFactory deployed = new DeployCallZPancake().run();

        // CREATE2 through the deterministic deployer: the address depends only on the bytecode, the constructor
        // arguments and the salt.
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(CallZPancakeFactory).creationCode, abi.encode(PANCAKE_FACTORY, WBNB)));
        assertEq(
            address(deployed),
            vm.computeCreate2Address(keccak256("CallZPancakeFactory.v1"), initCodeHash, CREATE2_FACTORY),
            "deployed through the deterministic deployer"
        );
        assertEq(deployed.pancakeFactory(), PANCAKE_FACTORY);
        assertEq(deployed.wbnb(), WBNB);
        assertGt(deployed.implementation().code.length, 0);
        assertEq(deployed.mintCount(), 0);

        // The factory it deployed creates a mint that sells out and launches.
        vm.prank(creator);
        CallZPancake mint = CallZPancake(deployed.create(_config(), bytes32(uint256(1))));
        assertEq(address(mint), deployed.predict(creator, bytes32(uint256(1))));
        vm.prank(alice);
        mint.mint{value: NFTS * PRICE}();
        _assertLaunchState(mint, 0, 0);

        emit log_named_address("CallZPancakeFactory (deterministic)", address(deployed));
        emit log_named_address("implementation", deployed.implementation());
    }

    /// @dev For every allowed pool share and NFT count, the pool and the NFTs together own the whole supply.
    function testFuzz_16_theSplitLeavesNoTokenWithoutAnOwner(uint16 poolShareBps, uint256 count) public {
        poolShareBps = uint16(bound(poolShareBps, 1000, 9000));
        count = bound(count, 1, 10_000);
        CallZPancakeConfig memory c = _config();
        c.nftPrice = 0.001 ether;
        c.cap = count * 0.001 ether;
        c.poolShareBps = poolShareBps;
        CallZPancake mint = _create(c);

        uint256 basePool = TOTAL_SUPPLY * poolShareBps / 10_000;
        uint256 share = mint.tokensPerNFT();
        uint256 pool = mint.poolTokens();
        assertEq(mint.maxNFTs(), count);
        assertEq(share, (TOTAL_SUPPLY - basePool) / count);
        assertGt(share, 0);
        assertEq(pool + share * count, TOTAL_SUPPLY, "pool + every NFT's share is the whole supply");
        assertGe(pool, basePool);
        assertLt(pool - basePool, count, "the dust is smaller than one wei per NFT");
    }
}
