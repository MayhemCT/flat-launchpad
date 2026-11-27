// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC721} from "solady/tokens/ERC721.sol";
import {Base64} from "solady/utils/Base64.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {LibString} from "solady/utils/LibString.sol";

import {
    CallZRoom,
    CallZRoomConfig,
    CallZRoomInfo,
    CallZRoomStanding,
    IRoomPancakeFactory
} from "src/callz/CallZRoom.sol";
import {CallZRoomFactory} from "src/callz/CallZRoomFactory.sol";
import {CallZRoomArt} from "src/callz/CallZRoomArt.sol";
import {CallZVault} from "src/callz/CallZVault.sol";

interface IRoomRouterLike {
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

interface IRoomPairLike {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function MINIMUM_LIQUIDITY() external view returns (uint256);
    function sync() external;
}

interface IRoomWBNBLike {
    function deposit() external payable;
}

/// @dev A contract wallet that takes BNB, refuses it, burns all the gas it is given, or takes it and answers with
///      a very large reply, as told.
contract RoomWallet {
    uint8 public constant ACCEPT = 0;
    uint8 public constant REJECT = 1;
    uint8 public constant BURN = 2;
    uint8 public constant BOMB = 3;

    uint8 public mode;
    uint256 public payments;

    function setMode(uint8 mode_) external {
        mode = mode_;
    }

    function mint(CallZRoom room) external payable {
        room.mint{value: msg.value}();
    }

    function refund(CallZRoom room) external {
        room.refund();
    }

    function withdraw(CallZRoom room) external {
        room.withdraw();
    }

    function claim(CallZRoom room) external {
        room.claim();
    }

    receive() external payable {
        uint8 mode_ = mode;
        if (mode_ == REJECT) revert("this wallet takes no BNB");
        if (mode_ == BURN) {
            // Uses up every unit of gas the call was given.
            assembly {
                invalid()
            }
        }
        if (mode_ == BOMB) {
            // 176,000 bytes of reply: about as much as 100,000 gas pays for.
            assembly {
                return(0, 176000)
            }
        }
        ++payments;
    }
}

/// @dev A wallet that can be a room's member, its creator, or both, and that calls back into the room every time
///      the room pays it. Which actions it tries is set by `attempts`.
contract RoomReenterer {
    uint8 public constant TRY_MINT = 1;
    uint8 public constant TRY_REFUND = 2;
    uint8 public constant TRY_WITHDRAW = 4;
    uint8 public constant TRY_CLAIM = 8;
    uint8 public constant TRY_LAUNCH = 16;
    uint8 public constant TRY_KICK = 32;
    bytes4 public constant NOT_TRIED = 0xffffffff;

    CallZRoom public room;
    bool public reject;
    uint8 public attempts;
    address public kickTarget;

    uint32 public payments;
    /// @dev The actions that went through during a payment.
    uint8 public succeeded;
    bytes4 public mintError = NOT_TRIED;
    bytes4 public refundError = NOT_TRIED;
    bytes4 public withdrawError = NOT_TRIED;
    bytes4 public claimError = NOT_TRIED;
    bytes4 public launchError = NOT_TRIED;
    bytes4 public kickError = NOT_TRIED;

    /// @dev Create a room this contract is the creator of.
    function create(CallZRoomFactory factory, CallZRoomConfig calldata c, bytes32 salt) external returns (CallZRoom) {
        room = CallZRoom(factory.create(c, salt));
        return room;
    }

    function join(CallZRoom room_) external {
        room = room_;
    }

    function arm(uint8 attempts_, address kickTarget_) external {
        attempts = attempts_;
        kickTarget = kickTarget_;
    }

    function setReject(bool reject_) external {
        reject = reject_;
    }

    function admit(address[] calldata wallets) external {
        room.admit(wallets);
    }

    function mint() external payable {
        room.mint{value: msg.value}();
    }

    function kick(address wallet) external {
        room.kick(wallet);
    }

    function launch() external {
        room.launch();
    }

    function refund() external {
        room.refund();
    }

    function withdraw() external {
        room.withdraw();
    }

    function claim() external {
        room.claim();
    }

    receive() external payable {
        if (reject) revert("this wallet takes no BNB");
        CallZRoom room_ = room;
        uint8 tries = attempts;
        uint8 done;
        ++payments;
        if ((tries & TRY_MINT) != 0) {
            try room_.mint{value: msg.value}() {
                done |= TRY_MINT;
            } catch (bytes memory reason) {
                mintError = bytes4(reason);
            }
        }
        if ((tries & TRY_REFUND) != 0) {
            try room_.refund() {
                done |= TRY_REFUND;
            } catch (bytes memory reason) {
                refundError = bytes4(reason);
            }
        }
        if ((tries & TRY_WITHDRAW) != 0) {
            try room_.withdraw() {
                done |= TRY_WITHDRAW;
            } catch (bytes memory reason) {
                withdrawError = bytes4(reason);
            }
        }
        if ((tries & TRY_CLAIM) != 0) {
            try room_.claim() {
                done |= TRY_CLAIM;
            } catch (bytes memory reason) {
                claimError = bytes4(reason);
            }
        }
        if ((tries & TRY_LAUNCH) != 0) {
            try room_.launch() {
                done |= TRY_LAUNCH;
            } catch (bytes memory reason) {
                launchError = bytes4(reason);
            }
        }
        if ((tries & TRY_KICK) != 0) {
            try room_.kick(kickTarget) {
                done |= TRY_KICK;
            } catch (bytes memory reason) {
                kickError = bytes4(reason);
            }
        }
        succeeded |= done;
    }
}

/// @dev Stands where the PancakeSwap factory would be, and is also the room's creator and one of its members. In
///      the middle of the launch it tries every action the room has. Pair creation itself is passed on to the
///      real factory.
contract RoomHostilePancakeFactory {
    address internal immutable real;
    CallZRoom public room;
    bool public reject;
    bool public entered;
    uint256 public payments;
    address public bystander;
    address public outsider;

    bytes4 public mintError;
    bytes4 public refundError;
    bytes4 public claimError;
    bytes4 public admitError;
    bytes4 public banError;
    bytes4 public kickError;
    bytes4 public launchError;
    bytes4 public withdrawError;
    bool public withdrawSucceeded;

    constructor(address real_) {
        real = real_;
    }

    function open(CallZRoomFactory roomFactory, CallZRoomConfig calldata c) external returns (CallZRoom) {
        room = CallZRoom(roomFactory.create(c, bytes32(uint256(1))));
        return room;
    }

    /// @param bystander_ A member the launch will try to kick.
    /// @param outsider_  A wallet the launch will try to admit and to bar.
    function aim(address bystander_, address outsider_) external {
        bystander = bystander_;
        outsider = outsider_;
    }

    function setReject(bool reject_) external {
        reject = reject_;
    }

    function admit(address[] calldata wallets) external {
        room.admit(wallets);
    }

    function setBanned(address wallet, bool banned) external {
        room.setBanned(wallet, banned);
    }

    function mint() external payable {
        room.mint{value: msg.value}();
    }

    function kick(address wallet) external {
        room.kick(wallet);
    }

    function launch() external {
        room.launch();
    }

    function claim() external {
        room.claim();
    }

    function getPair(address a, address b) external view returns (address) {
        return IRoomPancakeFactory(real).getPair(a, b);
    }

    function createPair(address a, address b) external returns (address) {
        entered = true;
        CallZRoom room_ = room;
        uint256 price = room_.seatPrice();
        address[] memory one = new address[](1);
        one[0] = outsider;
        try room_.mint{value: price}() {}
        catch (bytes memory reason) {
            mintError = bytes4(reason);
        }
        try room_.refund() {}
        catch (bytes memory reason) {
            refundError = bytes4(reason);
        }
        try room_.claim() {}
        catch (bytes memory reason) {
            claimError = bytes4(reason);
        }
        try room_.admit(one) {}
        catch (bytes memory reason) {
            admitError = bytes4(reason);
        }
        try room_.setBanned(outsider, true) {}
        catch (bytes memory reason) {
            banError = bytes4(reason);
        }
        try room_.kick(bystander) {}
        catch (bytes memory reason) {
            kickError = bytes4(reason);
        }
        try room_.launch() {}
        catch (bytes memory reason) {
            launchError = bytes4(reason);
        }
        try room_.withdraw() {
            withdrawSucceeded = true;
        } catch (bytes memory reason) {
            withdrawError = bytes4(reason);
        }
        return IRoomPancakeFactory(real).createPair(a, b);
    }

    receive() external payable {
        if (reject) revert("this wallet takes no BNB");
        ++payments;
    }
}

/// @notice CallZRoom, CallZRoomFactory and CallZRoomArt against the live PancakeSwap V2 factory, router and WBNB
///         on a fork of BNB Chain. Needs BSC_RPC_URL. Run with `forge test --isolate` so the gas test measures
///         whole transactions.
contract CallZRoomBSCForkTest is Test {
    address internal constant PANCAKE_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    IRoomRouterLike internal constant ROUTER = IRoomRouterLike(0x10ED43C718714eb63d5aA57B78B54704E256024E);
    /// @dev PancakeSwap's token: the token a gated room asks its members to hold in these tests.
    address internal constant CAKE = 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 internal constant MINIMUM_LIQUIDITY = 1000;
    /// @dev BNB Chain rejects any transaction above this much gas.
    uint256 internal constant TX_GAS_CAP = 16_777_216;

    uint256 internal constant PRICE = 0.01 ether;
    uint256 internal constant SEATS = 5;
    uint16 internal constant FEE_BPS = 1000;
    /// @dev BNB every test wallet starts with.
    uint256 internal constant START = 20 ether;
    string internal constant ALREADY_INITIALIZED = "Initializable: contract is already initialized";
    string internal constant JSON_PREFIX = "data:application/json;base64,";
    string internal constant SVG_PREFIX = "data:image/svg+xml;base64,";

    event Transfer(address indexed from, address indexed to, uint256 indexed id);

    CallZRoomFactory internal factory;
    CallZVault internal vault;
    address internal guardian = address(uint160(0xC0DE0007));
    address internal team = address(uint160(0xC0DE0012));
    // Plain numbered addresses. The usual named test accounts come from published private keys, and on BNB Chain
    // several of them carry an EIP-7702 delegation that forwards any BNB they receive.
    address internal creator = address(uint160(0xC0DE0001));
    address internal alice = address(uint160(0xC0DE0002));
    address internal bob = address(uint160(0xC0DE0003));
    address internal carol = address(uint160(0xC0DE0004));
    address internal dave = address(uint160(0xC0DE0005));
    address internal attacker = address(uint160(0xC0DE0006));
    address internal erin = address(uint160(0xC0DE0021));
    uint256 internal saltCounter;
    uint256 internal walletCounter;

    // The random-sequence tests.
    address[] internal actors;
    mapping(address wallet => uint256) internal startBalance;
    mapping(address wallet => bool) internal isContractWallet;
    uint256 internal creatorStart;
    uint256 internal mintedSeen;

    /// @dev What one random sequence went through.
    struct Outcome {
        bool launched;
        uint256 mints;
        uint256 kicks;
        uint256 owedKicks;
        uint256 refunds;
        uint256 withdrawals;
        uint256 claims;
    }

    function setUp() public {
        string memory rpcUrl = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpcUrl);
        require(block.chainid == 56, "BSC_RPC_URL is not BNB Chain");
        address[7] memory accounts = [creator, alice, bob, carol, dave, attacker, erin];
        for (uint256 i; i < accounts.length; ++i) {
            require(accounts[i].code.length == 0, "a test account has code on BNB Chain");
            vm.deal(accounts[i], START);
        }
        require(guardian.code.length == 0 && team.code.length == 0, "a role account has code on BNB Chain");
        vault = new CallZVault(guardian, guardian, team);
        factory = new CallZRoomFactory(PANCAKE_FACTORY, WBNB, address(vault), guardian, FEE_BPS);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _config() internal pure returns (CallZRoomConfig memory c) {
        c.name = "Call Room";
        c.symbol = "ROOM";
        c.image = "ipfs://bafkreig4y5nwb4izyilbbmiydumvkld446d4k7j4ohg3x3q2lfel3fo4yq";
        c.seatPrice = PRICE;
        c.seats = SEATS;
        c.saleDuration = 1 days;
        c.poolShareBps = 5000;
    }

    function _create(CallZRoomConfig memory c) internal returns (CallZRoom room) {
        vm.prank(creator);
        room = CallZRoom(factory.create(c, bytes32(++saltCounter)));
    }

    function _createWithSeats(uint256 seats) internal returns (CallZRoom) {
        CallZRoomConfig memory c = _config();
        c.seats = seats;
        return _create(c);
    }

    function _expectInvalid(CallZRoomConfig memory c) internal {
        vm.prank(creator);
        vm.expectRevert(CallZRoom.InvalidConfig.selector);
        factory.create(c, bytes32(++saltCounter));
    }

    function _one(address wallet) internal pure returns (address[] memory wallets) {
        wallets = new address[](1);
        wallets[0] = wallet;
    }

    function _repeat(bytes1 char, uint256 count) internal pure returns (string memory) {
        bytes memory out = new bytes(count);
        for (uint256 i; i < count; ++i) {
            out[i] = char;
        }
        return string(out);
    }

    /// @dev A numbered wallet with no code on BNB Chain, holding the starting balance.
    function _wallet(uint256 index) internal returns (address wallet) {
        wallet = address(uint160(0xC0DE1000 + index));
        require(wallet.code.length == 0, "a test wallet has code on BNB Chain");
        vm.deal(wallet, START);
    }

    function _admit(CallZRoom room, address wallet) internal {
        vm.prank(creator);
        room.admit(_one(wallet));
    }

    /// @dev The creator lets `wallet` in and it buys its pass.
    function _seat(CallZRoom room, address wallet) internal returns (uint256 id) {
        uint256 price = room.seatPrice();
        vm.prank(creator);
        room.admit(_one(wallet));
        vm.prank(wallet);
        room.mint{value: price}();
        id = room.seatOf(wallet);
    }

    /// @dev Fill every free seat with a fresh numbered wallet.
    function _fill(CallZRoom room) internal returns (address[] memory wallets) {
        uint256 free = room.seats() - room.seated();
        uint256 price = room.seatPrice();
        wallets = new address[](free);
        for (uint256 i; i < free; ++i) {
            wallets[i] = _wallet(walletCounter++);
        }
        vm.prank(creator);
        room.admit(wallets);
        for (uint256 i; i < free; ++i) {
            vm.prank(wallets[i]);
            room.mint{value: price}();
        }
    }

    function _launch(CallZRoom room) internal {
        vm.prank(creator);
        room.launch();
    }

    /// @dev The token address a room will launch: the first contract the clone creates.
    function _predictToken(CallZRoom room) internal pure returns (address) {
        return vm.computeCreateAddress(address(room), 1);
    }

    /// @dev The pair's reserves, read in the pair's own token order and returned as (token, WBNB).
    function _reserves(address pair, address token) internal view returns (uint256 tokenReserve, uint256 wbnbReserve) {
        (uint112 reserve0, uint112 reserve1,) = IRoomPairLike(pair).getReserves();
        (tokenReserve, wbnbReserve) =
            IRoomPairLike(pair).token0() == token ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    /// @dev What a fee adds to the vault and to the team wallet together: the whole fee.
    function _feeHolders() internal view returns (uint256) {
        return address(vault).balance + team.balance;
    }

    /// @dev The members are exactly `expected`, in any order, and the list agrees with the passes.
    function _assertMembers(CallZRoom room, address[] memory expected) internal view {
        (address[] memory wallets, uint256[] memory ids) = room.members(0, type(uint256).max);
        assertEq(wallets.length, expected.length, "number of members");
        assertEq(room.memberCount(), expected.length, "memberCount");
        assertEq(room.seated(), expected.length, "seated");
        for (uint256 i; i < expected.length; ++i) {
            bool found;
            for (uint256 j; j < wallets.length; ++j) {
                if (wallets[j] == expected[i]) {
                    found = true;
                    assertEq(ids[j], room.seatOf(expected[i]), "the list gives the member's pass");
                }
            }
            assertTrue(found, "member is in the list");
            assertGt(room.seatOf(expected[i]), 0, "a member has a pass");
            assertEq(room.ownerOf(room.seatOf(expected[i])), expected[i], "ownerOf");
            assertEq(room.balanceOf(expected[i]), 1, "one pass per member");
        }
    }

    function _assertNoPass(CallZRoom room, uint256 id) internal {
        vm.expectRevert(ERC721.TokenDoesNotExist.selector);
        room.ownerOf(id);
        vm.expectRevert(ERC721.TokenDoesNotExist.selector);
        room.tokenURI(id);
    }

    /// @dev Everything that must be true right after a launch, before any claim or trade.
    /// @param syncedDonation   WBNB that was already in the pair's reserves before the launch.
    /// @param unsyncedDonation WBNB that sat in the pair without being in its reserves.
    /// @param owedLeft         BNB the room still owes kicked wallets: all it may still hold.
    function _assertLaunchState(CallZRoom room, uint256 syncedDonation, uint256 unsyncedDonation, uint256 owedLeft)
        internal
        view
    {
        assertTrue(room.launched(), "launched");
        address token = room.token();
        address pair = room.pair();
        assertEq(token, _predictToken(room), "the token is the first contract the room created");
        assertGt(token.code.length, 0, "token deployed");
        assertEq(pair, IRoomPancakeFactory(PANCAKE_FACTORY).getPair(token, WBNB), "the pair of token and WBNB");
        assertGt(pair.code.length, 0, "pair deployed");

        uint256 count = room.seats();
        uint256 share = room.tokensPerSeat();
        uint256 poolTokens = TOTAL_SUPPLY - share * count;
        assertEq(room.seated(), count, "every seat is taken");
        assertEq(room.raised(), 0, "nothing is held for a launch any more");
        assertEq(room.poolTokens(), poolTokens);

        // The token: a fixed supply, split between the pair and the room and nobody else.
        assertEq(IERC20(token).totalSupply(), TOTAL_SUPPLY, "fixed supply");
        assertEq(IERC20(token).balanceOf(pair), poolTokens, "pool tokens are in the pair");
        assertEq(IERC20(token).balanceOf(address(room)), count * share, "the room holds exactly every pass's share");
        assertEq(IERC20(token).balanceOf(room.creator()), 0, "the creator was given no tokens");

        _assertPool(room, poolTokens, syncedDonation, unsyncedDonation);

        // The room: nothing left but what it owes kicked wallets.
        assertEq(address(room).balance, owedLeft, "no BNB left in the room but what it owes");
        assertEq(IERC20(WBNB).balanceOf(address(room)), 0, "no WBNB left in the room");
    }

    /// @dev The pair right after a launch: the pool tokens, the raise less the fee, and all the LP burned.
    function _assertPool(CallZRoom room, uint256 poolTokens, uint256 syncedDonation, uint256 unsyncedDonation)
        internal
        view
    {
        address pair = room.pair();
        uint256 raise = room.cap();
        uint256 net = raise - raise * room.launchFeeBps() / 10_000;

        // Reserves in the pair's own token order.
        (uint256 tokenReserve, uint256 wbnbReserve) = _reserves(pair, room.token());
        assertEq(tokenReserve, poolTokens, "token reserve");
        assertEq(wbnbReserve, net + syncedDonation + unsyncedDonation, "WBNB reserve");
        assertEq(IERC20(WBNB).balanceOf(pair), wbnbReserve, "WBNB in the pair");

        // The LP: all of it burned.
        IRoomPairLike lp = IRoomPairLike(pair);
        uint256 lpSupply = lp.totalSupply();
        assertEq(lp.MINIMUM_LIQUIDITY(), MINIMUM_LIQUIDITY);
        assertEq(lpSupply, FixedPointMathLib.sqrt(poolTokens * (net + unsyncedDonation)), "LP minted");
        assertEq(lp.balanceOf(address(0)), MINIMUM_LIQUIDITY, "the pair's own minimum liquidity");
        assertEq(lp.balanceOf(DEAD), lpSupply - MINIMUM_LIQUIDITY, "every other LP token is at the dead address");
        assertEq(lp.balanceOf(address(room)), 0, "the room holds no LP");
        assertEq(lp.balanceOf(room.creator()), 0, "the creator holds no LP");
    }

    /// @dev The one log `emitter` wrote with `topic0`, and how many there were.
    function _findLog(Vm.Log[] memory logs, address emitter, bytes32 topic0)
        internal
        pure
        returns (Vm.Log memory found, uint256 count)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic0) {
                found = logs[i];
                ++count;
            }
        }
    }

    function _topicAddress(bytes32 topic) internal pure returns (address) {
        return address(uint160(uint256(topic)));
    }

    /// @dev A pass's metadata as JSON text.
    function _json(CallZRoom room, uint256 id) internal view returns (string memory) {
        string memory uri = room.tokenURI(id);
        assertTrue(LibString.startsWith(uri, JSON_PREFIX), "tokenURI is a base64 JSON data address");
        return string(Base64.decode(LibString.slice(uri, bytes(JSON_PREFIX).length)));
    }

    /// @dev The drawn pass inside a pass's metadata, as SVG text.
    function _svg(string memory json) internal pure returns (string memory) {
        string memory picture = vm.parseJsonString(json, ".image");
        assertTrue(LibString.startsWith(picture, SVG_PREFIX), "the picture is a base64 SVG data address");
        return string(Base64.decode(LibString.slice(picture, bytes(SVG_PREFIX).length)));
    }

    function _status(CallZRoom room, uint256 id) internal view returns (string memory) {
        string memory json = _json(room, id);
        assertEq(vm.parseJsonString(json, ".attributes[0].trait_type"), "Status");
        return vm.parseJsonString(json, ".attributes[0].value");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Creation
    // ─────────────────────────────────────────────────────────────────────────

    function test_01_creationPredictsTheAddressAndTheRoomReadsBackItsConfig() public {
        // The addresses the room factory was given are the ones the live router trades on.
        assertEq(ROUTER.factory(), PANCAKE_FACTORY, "PancakeSwap V2 factory");
        assertEq(ROUTER.WETH(), WBNB, "WBNB");
        assertEq(factory.pancakeFactory(), PANCAKE_FACTORY);
        assertEq(factory.wbnb(), WBNB);
        assertEq(factory.vault(), address(vault));
        assertEq(factory.guardian(), guardian);
        assertEq(factory.launchFeeBps(), FEE_BPS);
        assertGt(factory.implementation().code.length, 0);
        assertGt(factory.art().code.length, 0);
        assertEq(factory.roomCount(), 0);

        CallZRoomConfig memory c = _config();
        c.gateToken = CAKE;
        c.gateAmount = 5e18;
        c.poolShareBps = 4000;
        bytes32 salt = bytes32(++saltCounter);
        address predicted = factory.predict(creator, salt);
        assertEq(predicted.code.length, 0, "nothing is at the predicted address yet");
        assertFalse(factory.isRoom(predicted));

        vm.expectEmit(true, true, false, true, address(factory));
        emit CallZRoomFactory.CallZRoomCreated(predicted, creator, c.name, c.symbol, c.seatPrice, c.seats);
        vm.prank(creator);
        CallZRoom room = CallZRoom(factory.create(c, salt));

        assertEq(address(room), predicted, "the room address is known before creation");
        assertTrue(factory.isRoom(address(room)));
        assertFalse(factory.isRoom(factory.implementation()), "the implementation is not a room");
        assertFalse(factory.isRoom(alice));
        assertEq(factory.roomCount(), 1);
        assertEq(factory.rooms(0), address(room));

        uint256 share = (TOTAL_SUPPLY - TOTAL_SUPPLY * 4000 / 10_000) / SEATS;
        CallZRoomInfo memory i = room.info();
        assertEq(i.creator, creator);
        assertEq(i.tokenName, c.name);
        assertEq(i.tokenSymbol, c.symbol);
        assertEq(i.image, c.image);
        assertEq(i.seatPrice, PRICE);
        assertEq(i.seats, SEATS);
        assertEq(i.seated, 0);
        assertEq(i.minted, 0);
        assertEq(i.raised, 0);
        assertEq(i.saleDeadline, block.timestamp + 1 days);
        assertEq(i.poolShareBps, 4000);
        assertEq(i.launchFeeBps, FEE_BPS);
        assertEq(i.gateToken, CAKE);
        assertEq(i.gateAmount, 5e18);
        assertEq(i.tokensPerSeat, share);
        assertFalse(i.launched);
        assertEq(i.token, address(0));
        assertEq(i.pair, address(0));

        assertEq(room.pancakeFactory(), PANCAKE_FACTORY);
        assertEq(room.wbnb(), WBNB);
        assertEq(room.vault(), address(vault));
        assertEq(room.art(), factory.art());
        assertEq(room.cap(), PRICE * SEATS);
        assertEq(room.targetRaise(), PRICE * SEATS);
        assertEq(room.poolTokens(), TOTAL_SUPPLY - share * SEATS);
        assertEq(room.version(), "1.0.0");
        assertEq(room.name(), "Call Room CallZ Pass");
        assertEq(room.symbol(), "ROOM-PASS");
        assertEq(room.priceText(), "0.01 BNB");
        assertEq(room.memberCount(), 0);
        assertFalse(room.refundAvailable());

        // The same creator and salt cannot deploy twice; another creator with that salt gets another address.
        vm.prank(creator);
        vm.expectRevert(CallZRoomFactory.SaltUsed.selector);
        factory.create(c, salt);
        assertTrue(factory.predict(attacker, salt) != address(room));
        vm.prank(attacker);
        address other = factory.create(c, salt);
        assertEq(other, factory.predict(attacker, salt));
        assertEq(CallZRoom(other).creator(), attacker);
        assertEq(factory.roomCount(), 2);
        assertEq(factory.rooms(1), other);
        assertTrue(factory.isRoom(other));
    }

    function test_02_badConfigsAreRefused() public {
        CallZRoomConfig memory c;

        // The price is not zero.
        c = _config();
        c.seatPrice = 0;
        _expectInvalid(c);
        // A price too large to multiply is refused like any other, not with an arithmetic error.
        c.seatPrice = type(uint256).max;
        _expectInvalid(c);

        // 1 to 1000 seats.
        c = _config();
        c.seats = 0;
        _expectInvalid(c);
        c.seatPrice = 0.001 ether;
        c.seats = 1001;
        _expectInvalid(c);
        c.seats = 1000;
        assertEq(_create(c).seats(), 1000);

        // price * seats is at most 10 BNB.
        c = _config();
        c.seatPrice = 1 ether;
        c.seats = 11;
        _expectInvalid(c);
        c.seatPrice = 10 ether + 1;
        c.seats = 1;
        _expectInvalid(c);
        c.seatPrice = 0.01 ether + 1;
        c.seats = 1000;
        _expectInvalid(c);
        c.seatPrice = 1 ether;
        c.seats = 10;
        assertEq(_create(c).cap(), 10 ether);
        c.seatPrice = 10 ether;
        c.seats = 1;
        assertEq(_create(c).cap(), 10 ether);
        c.seatPrice = 0.01 ether;
        c.seats = 1000;
        assertEq(_create(c).cap(), 10 ether);

        // The pool takes 10% to 90% of the supply.
        c = _config();
        c.poolShareBps = 999;
        _expectInvalid(c);
        c.poolShareBps = 0;
        _expectInvalid(c);
        c.poolShareBps = 9001;
        _expectInvalid(c);
        c.poolShareBps = 10_000;
        _expectInvalid(c);
        c.poolShareBps = 1000;
        assertEq(_create(c).poolShareBps(), 1000);
        c.poolShareBps = 9000;
        assertEq(_create(c).poolShareBps(), 9000);

        // The sale lasts 10 minutes to 30 days.
        c = _config();
        c.saleDuration = 10 minutes - 1;
        _expectInvalid(c);
        c.saleDuration = 0;
        _expectInvalid(c);
        c.saleDuration = 30 days + 1;
        _expectInvalid(c);
        c.saleDuration = 10 minutes;
        assertEq(_create(c).saleDeadline(), block.timestamp + 10 minutes);
        c.saleDuration = 30 days;
        assertEq(_create(c).saleDeadline(), block.timestamp + 30 days);

        // Name: 1 to 64 bytes.
        c = _config();
        c.name = "";
        _expectInvalid(c);
        c.name = _repeat("N", 65);
        _expectInvalid(c);
        c.name = _repeat("N", 64);
        assertEq(bytes(_create(c).tokenName()).length, 64);

        // Symbol: 1 to 32 bytes.
        c = _config();
        c.symbol = "";
        _expectInvalid(c);
        c.symbol = _repeat("S", 33);
        _expectInvalid(c);
        c.symbol = _repeat("S", 32);
        assertEq(bytes(_create(c).tokenSymbol()).length, 32);

        // Picture address: up to 200 bytes, may be empty.
        c = _config();
        c.image = _repeat("i", 201);
        _expectInvalid(c);
        c.image = _repeat("i", 200);
        assertEq(bytes(_create(c).image()).length, 200);
        c.image = "";
        assertEq(bytes(_create(c).image()).length, 0);

        // A holding requirement names a real token and an amount, or is absent altogether.
        c = _config();
        c.gateToken = CAKE;
        c.gateAmount = 0;
        _expectInvalid(c);
        c.gateToken = address(0);
        c.gateAmount = 1;
        _expectInvalid(c);
        c.gateToken = alice;
        c.gateAmount = 1;
        _expectInvalid(c);
        c.gateToken = CAKE;
        assertEq(_create(c).gateToken(), CAKE);
    }

    function test_03_neitherTheFactoryNorARoomAcceptsAZeroAddressOrAnExcessiveFee() public {
        vm.expectRevert(CallZRoomFactory.ZeroAddress.selector);
        new CallZRoomFactory(address(0), WBNB, address(vault), guardian, 0);
        vm.expectRevert(CallZRoomFactory.ZeroAddress.selector);
        new CallZRoomFactory(PANCAKE_FACTORY, address(0), address(vault), guardian, 0);
        vm.expectRevert(CallZRoomFactory.ZeroAddress.selector);
        new CallZRoomFactory(PANCAKE_FACTORY, WBNB, address(0), guardian, 0);
        vm.expectRevert(CallZRoomFactory.ZeroAddress.selector);
        new CallZRoomFactory(PANCAKE_FACTORY, WBNB, address(vault), address(0), 0);
        vm.expectRevert(CallZRoomFactory.FeeTooHigh.selector);
        new CallZRoomFactory(PANCAKE_FACTORY, WBNB, address(vault), guardian, 1001);

        CallZRoomConfig memory c = _config();
        address art = factory.art();
        CallZRoom raw = CallZRoom(LibClone.clone(factory.implementation()));
        vm.expectRevert(CallZRoom.InvalidConfig.selector);
        raw.initialize(address(0), WBNB, creator, address(vault), 0, art, c);
        vm.expectRevert(CallZRoom.InvalidConfig.selector);
        raw.initialize(PANCAKE_FACTORY, address(0), creator, address(vault), 0, art, c);
        vm.expectRevert(CallZRoom.InvalidConfig.selector);
        raw.initialize(PANCAKE_FACTORY, WBNB, address(0), address(vault), 0, art, c);
        vm.expectRevert(CallZRoom.InvalidConfig.selector);
        raw.initialize(PANCAKE_FACTORY, WBNB, creator, address(vault), 0, address(0), c);
        vm.expectRevert(CallZRoom.InvalidConfig.selector);
        raw.initialize(PANCAKE_FACTORY, WBNB, creator, address(vault), 1001, art, c);
        // A fee needs a vault to go to.
        vm.expectRevert(CallZRoom.InvalidConfig.selector);
        raw.initialize(PANCAKE_FACTORY, WBNB, creator, address(0), 1, art, c);
    }

    function test_04_aRoomIsInitialisedOnceAndTheImplementationNever() public {
        CallZRoomConfig memory c = _config();
        CallZRoom room = _create(c);
        address art = factory.art();

        // A clone is initialised once, by the factory, in the transaction that deploys it.
        vm.prank(creator);
        vm.expectRevert(bytes(ALREADY_INITIALIZED));
        room.initialize(PANCAKE_FACTORY, WBNB, creator, address(vault), 0, art, c);
        vm.prank(attacker);
        vm.expectRevert(bytes(ALREADY_INITIALIZED));
        room.initialize(attacker, attacker, attacker, attacker, 0, attacker, c);
        assertEq(room.creator(), creator);
        assertEq(room.pancakeFactory(), PANCAKE_FACTORY);
        assertEq(room.launchFeeBps(), FEE_BPS);

        // The implementation is locked from its constructor on: it can never be initialised or take a mint.
        CallZRoom impl = CallZRoom(factory.implementation());
        vm.prank(attacker);
        vm.expectRevert(bytes(ALREADY_INITIALIZED));
        impl.initialize(PANCAKE_FACTORY, WBNB, attacker, address(vault), 0, art, c);
        assertEq(impl.creator(), address(0));
        assertEq(impl.cap(), 0);
        vm.prank(attacker);
        vm.expectRevert(CallZRoom.SaleClosed.selector);
        impl.mint{value: PRICE}();
        vm.prank(attacker);
        vm.expectRevert(CallZRoom.NotCreator.selector);
        impl.admit(_one(attacker));
        vm.prank(attacker);
        vm.expectRevert(CallZRoom.NotCreator.selector);
        impl.launch();

        // Still blocked after the launch.
        _fill(room);
        _launch(room);
        vm.prank(attacker);
        vm.expectRevert(bytes(ALREADY_INITIALIZED));
        room.initialize(attacker, attacker, attacker, attacker, 0, attacker, c);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Getting in
    // ─────────────────────────────────────────────────────────────────────────

    function test_05_onlyAnAdmittedWalletMintsAndOnlyOnce() public {
        CallZRoom room = _createWithSeats(3);

        // A wallet the creator has not let in.
        vm.prank(alice);
        vm.expectRevert(CallZRoom.NotAdmitted.selector);
        room.mint{value: PRICE}();
        assertFalse(room.standingOf(alice).admitted);

        vm.expectEmit(true, false, false, true, address(room));
        emit CallZRoom.Admitted(alice);
        vm.prank(creator);
        room.admit(_one(alice));
        assertTrue(room.admitted(alice));
        assertTrue(room.standingOf(alice).admitted);
        assertEq(room.seated(), 0, "being let in takes no seat");

        // Exactly the price, no more and no less.
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.WrongPayment.selector, 0, PRICE));
        room.mint();
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.WrongPayment.selector, PRICE - 1, PRICE));
        room.mint{value: PRICE - 1}();
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.WrongPayment.selector, PRICE + 1, PRICE));
        room.mint{value: PRICE + 1}();
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.WrongPayment.selector, 2 * PRICE, PRICE));
        room.mint{value: 2 * PRICE}();
        vm.stopPrank();
        assertEq(address(room).balance, 0);
        assertEq(alice.balance, START);

        vm.expectEmit(true, true, true, true, address(room));
        emit Transfer(address(0), alice, 1);
        vm.expectEmit(true, true, false, true, address(room));
        emit CallZRoom.Minted(alice, 1, PRICE);
        vm.prank(alice);
        room.mint{value: PRICE}();

        assertEq(room.ownerOf(1), alice);
        assertEq(room.balanceOf(alice), 1);
        assertEq(room.seatOf(alice), 1);
        assertFalse(room.admitted(alice), "the admission is used up");
        assertEq(room.minted(), 1);
        assertEq(room.seated(), 1);
        assertEq(room.raised(), PRICE);
        assertEq(address(room).balance, PRICE);
        assertEq(alice.balance, START - PRICE);
        _assertMembers(room, _one(alice));
        CallZRoomStanding memory s = room.standingOf(alice);
        assertFalse(s.admitted);
        assertFalse(s.banned);
        assertEq(s.seat, 1);
        assertFalse(s.claimed);
        assertEq(s.owed, 0);
        assertTrue(s.meetsGate, "a room without a requirement is met by everyone");

        // One pass per wallet, even if the creator lets it in again.
        vm.prank(alice);
        vm.expectRevert(CallZRoom.AlreadyMember.selector);
        room.mint{value: PRICE}();
        vm.prank(creator);
        room.admit(_one(alice));
        assertFalse(room.admitted(alice), "a member is passed over");
        vm.prank(alice);
        vm.expectRevert(CallZRoom.AlreadyMember.selector);
        room.mint{value: PRICE}();
        assertEq(room.minted(), 1);
        assertEq(room.raised(), PRICE);

        // The member list, read in pages.
        _seat(room, bob);
        (address[] memory wallets, uint256[] memory ids) = room.members(0, 1);
        assertEq(wallets.length, 1);
        assertEq(wallets[0], alice);
        assertEq(ids[0], 1);
        (wallets, ids) = room.members(1, 5);
        assertEq(wallets.length, 1);
        assertEq(wallets[0], bob);
        assertEq(ids[0], 2);
        (wallets, ids) = room.members(2, 5);
        assertEq(wallets.length, 0);
        (wallets, ids) = room.members(99, 5);
        assertEq(wallets.length, 0, "a page past the end is empty");
        assertEq(ids.length, 0);
    }

    function test_06_theCreatorAloneLetsWalletsInAndOnlyWhileTheSaleIsOpen() public {
        CallZRoom room = _createWithSeats(3);

        // Nobody else decides who gets in, who is removed, or when the room launches.
        vm.startPrank(attacker);
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.admit(_one(attacker));
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.revoke(_one(alice));
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.setBanned(alice, true);
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.kick(alice);
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.launch();
        vm.stopPrank();
        // Not the factory either, nor its guardian.
        vm.prank(address(factory));
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.admit(_one(attacker));
        vm.prank(guardian);
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.admit(_one(attacker));
        assertFalse(room.admitted(attacker));

        // At most 100 wallets per call.
        address[] memory many = new address[](101);
        for (uint256 i; i < many.length; ++i) {
            many[i] = address(uint160(0xC0DE5000 + i));
        }
        vm.prank(creator);
        vm.expectRevert(CallZRoom.TooManyWallets.selector);
        room.admit(many);
        assertFalse(room.admitted(many[0]), "nobody of a refused list is in");
        address[] memory hundred = new address[](100);
        for (uint256 i; i < hundred.length; ++i) {
            hundred[i] = many[i];
        }
        vm.prank(creator);
        room.admit(hundred);
        assertTrue(room.admitted(hundred[0]));
        assertTrue(room.admitted(hundred[99]));
        assertFalse(room.admitted(many[100]));
        // The same wallets again: all passed over.
        vm.prank(creator);
        room.admit(hundred);

        // The zero address is refused, and takes the whole call with it.
        address[] memory pair = new address[](2);
        pair[0] = alice;
        pair[1] = address(0);
        vm.prank(creator);
        vm.expectRevert(CallZRoom.InvalidConfig.selector);
        room.admit(pair);
        assertFalse(room.admitted(alice));

        // An admission can be taken back until the pass is bought.
        _admit(room, bob);
        vm.expectEmit(true, false, false, true, address(room));
        emit CallZRoom.AdmissionRevoked(bob);
        vm.prank(creator);
        room.revoke(_one(bob));
        assertFalse(room.admitted(bob));
        vm.prank(bob);
        vm.expectRevert(CallZRoom.NotAdmitted.selector);
        room.mint{value: PRICE}();
        // Revoking a wallet that is not admitted, or a member, changes nothing.
        _seat(room, carol);
        vm.prank(creator);
        room.revoke(_one(carol));
        assertEq(room.seatOf(carol), 1);
        assertEq(room.seated(), 1);

        // One second before the deadline wallets are still let in; at the deadline they are not.
        _admit(room, alice);
        vm.warp(room.saleDeadline() - 1);
        _admit(room, dave);
        assertTrue(room.admitted(dave));
        vm.warp(room.saleDeadline());
        vm.prank(creator);
        vm.expectRevert(CallZRoom.SaleClosed.selector);
        room.admit(_one(erin));
        vm.prank(creator);
        vm.expectRevert(CallZRoom.SaleClosed.selector);
        room.admit(new address[](0));
        // Admitted in time, too late to buy.
        vm.prank(alice);
        vm.expectRevert(CallZRoom.SaleClosed.selector);
        room.mint{value: PRICE}();
    }

    function test_07_aFullRoomAndAClosedSaleRefuseMints() public {
        CallZRoom room = _createWithSeats(3);
        address[] memory four = new address[](4);
        four[0] = alice;
        four[1] = bob;
        four[2] = carol;
        four[3] = dave;
        vm.prank(creator);
        room.admit(four);

        vm.prank(alice);
        room.mint{value: PRICE}();
        vm.prank(bob);
        room.mint{value: PRICE}();
        vm.prank(carol);
        room.mint{value: PRICE}();
        assertEq(room.seated(), 3);
        assertEq(room.raised(), room.cap());

        // Dave was let in, but every seat is taken.
        vm.prank(dave);
        vm.expectRevert(CallZRoom.RoomFull.selector);
        room.mint{value: PRICE}();
        assertTrue(room.admitted(dave), "his admission still stands");
        assertEq(dave.balance, START);
        assertEq(address(room).balance, 3 * PRICE);

        // A seat that is freed can be taken by him.
        vm.prank(creator);
        room.kick(carol);
        vm.prank(dave);
        room.mint{value: PRICE}();
        assertEq(room.seatOf(dave), 4);

        // One second before the deadline a mint still goes through; at the deadline it does not.
        CallZRoom late = _createWithSeats(3);
        vm.prank(creator);
        late.admit(four);
        vm.warp(late.saleDeadline() - 1);
        vm.prank(alice);
        late.mint{value: PRICE}();
        vm.warp(late.saleDeadline());
        vm.prank(bob);
        vm.expectRevert(CallZRoom.SaleClosed.selector);
        late.mint{value: PRICE}();
        vm.warp(late.saleDeadline() + 365 days);
        vm.prank(bob);
        vm.expectRevert(CallZRoom.SaleClosed.selector);
        late.mint{value: PRICE}();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. The token a room requires
    // ─────────────────────────────────────────────────────────────────────────

    function test_08_aRoomWithATokenGateRefusesWalletsThatHoldTooLittle() public {
        uint256 required = 100e18;
        CallZRoomConfig memory c = _config();
        c.gateToken = CAKE;
        c.gateAmount = required;
        CallZRoom room = _create(c);

        deal(CAKE, alice, required - 1);
        deal(CAKE, bob, required);
        deal(CAKE, carol, 0);
        assertEq(IERC20(CAKE).balanceOf(alice), required - 1);
        assertFalse(room.standingOf(alice).meetsGate);
        assertTrue(room.standingOf(bob).meetsGate);
        assertFalse(room.standingOf(carol).meetsGate);

        // One base unit short: refused by the room, whatever the creator wants.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.GateNotMet.selector, alice, required - 1, required));
        room.admit(_one(alice));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.GateNotMet.selector, carol, uint256(0), required));
        room.admit(_one(carol));
        assertFalse(room.admitted(alice));
        vm.prank(alice);
        vm.expectRevert(CallZRoom.NotAdmitted.selector);
        room.mint{value: PRICE}();

        // One wallet that holds too little takes the whole call with it.
        address[] memory both = new address[](2);
        both[0] = bob;
        both[1] = carol;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.GateNotMet.selector, carol, uint256(0), required));
        room.admit(both);
        assertFalse(room.admitted(bob));

        // Holding exactly the amount is enough.
        vm.prank(creator);
        room.admit(_one(bob));
        assertTrue(room.admitted(bob));
        vm.prank(bob);
        room.mint{value: PRICE}();
        assertEq(room.seatOf(bob), 1);

        // `meetsGate` follows the balance.
        deal(CAKE, alice, required);
        assertTrue(room.standingOf(alice).meetsGate);
        vm.prank(creator);
        room.admit(_one(alice));
        assertTrue(room.admitted(alice));
        deal(CAKE, alice, required - 1);
        assertFalse(room.standingOf(alice).meetsGate);

        // The holding is checked when the wallet is let in, not when it buys: an admitted wallet that no longer
        // holds the amount still buys its pass.
        assertTrue(room.admitted(alice));
        vm.prank(alice);
        room.mint{value: PRICE}();
        assertEq(room.seatOf(alice), 2);
        assertFalse(room.standingOf(alice).meetsGate);

        // A room without a requirement is met by everyone.
        CallZRoom open = _create(_config());
        assertTrue(open.standingOf(carol).meetsGate);
        _admit(open, carol);
        assertTrue(open.admitted(carol));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Kick and ban
    // ─────────────────────────────────────────────────────────────────────────

    function test_09_kickBurnsThePassBansTheWalletRepaysThePriceAndFreesTheSeat() public {
        CallZRoom room = _createWithSeats(3);
        _seat(room, alice);
        _seat(room, bob);
        _seat(room, carol);
        assertEq(room.seated(), 3);

        vm.prank(attacker);
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.kick(alice);
        vm.prank(alice);
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.kick(bob);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.NotMember.selector, dave));
        room.kick(dave);

        uint256 creatorBefore = creator.balance;
        vm.expectEmit(true, true, true, true, address(room));
        emit Transfer(alice, address(0), 1);
        vm.expectEmit(true, false, false, true, address(room));
        emit CallZRoom.BanSet(alice, true);
        vm.expectEmit(true, true, false, true, address(room));
        emit CallZRoom.Kicked(alice, 1, PRICE);
        vm.prank(creator);
        room.kick(alice);

        // The pass is gone, the wallet is barred, and its whole price is back.
        _assertNoPass(room, 1);
        assertEq(room.balanceOf(alice), 0);
        assertEq(room.seatOf(alice), 0);
        assertTrue(room.banned(alice));
        assertTrue(room.standingOf(alice).banned);
        assertEq(alice.balance, START, "the kicked wallet got exactly its price back");
        assertEq(room.owed(alice), 0);
        assertEq(creator.balance, creatorBefore, "the creator got nothing");
        assertEq(room.raised(), 2 * PRICE);
        assertEq(room.seated(), 2);
        assertEq(room.minted(), 3, "issued passes keep counting");
        assertEq(address(room).balance, 2 * PRICE);
        address[] memory left = new address[](2);
        left[0] = bob;
        left[1] = carol;
        _assertMembers(room, left);

        // Kicked twice is impossible, and a barred wallet cannot come back.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.NotMember.selector, alice));
        room.kick(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.Banned.selector, alice));
        room.mint{value: PRICE}();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.Banned.selector, alice));
        room.admit(_one(alice));

        // The seat is free: the next wallet gets a new number, never the burned one.
        assertEq(_seat(room, dave), 4);
        assertEq(room.minted(), 4);
        assertEq(room.seated(), 3);
        assertEq(room.raised(), 3 * PRICE);
        _assertNoPass(room, 1);

        // And again, with the member in the middle of the list.
        vm.prank(creator);
        room.kick(bob);
        assertEq(bob.balance, START);
        assertEq(_seat(room, erin), 5);
        _assertNoPass(room, 1);
        _assertNoPass(room, 2);
        left = new address[](3);
        left[0] = carol;
        left[1] = dave;
        left[2] = erin;
        _assertMembers(room, left);

        // A wallet whose bar is lifted and that is let in again gets a new pass, not its old one.
        vm.prank(creator);
        room.kick(erin);
        vm.prank(creator);
        room.setBanned(alice, false);
        assertEq(_seat(room, alice), 6);
        assertEq(room.ownerOf(6), alice);
        _assertNoPass(room, 1);
        _assertNoPass(room, 5);
        assertEq(room.minted(), 6);
        assertEq(room.seated(), 3);
        assertEq(address(room).balance, 3 * PRICE);
        assertEq(room.raised(), 3 * PRICE);
    }

    function test_10_kickingAWalletThatCannotTakeBnbLeavesItsPriceOwed() public {
        CallZRoom room = _createWithSeats(3);
        RoomWallet rejecter = new RoomWallet();
        RoomWallet burner = new RoomWallet();
        _admit(room, address(rejecter));
        _admit(room, address(burner));
        rejecter.mint{value: PRICE}(room);
        burner.mint{value: PRICE}(room);
        _seat(room, alice);
        rejecter.setMode(rejecter.REJECT());
        burner.setMode(burner.BURN());

        // A wallet that refuses BNB is removed all the same.
        vm.expectEmit(true, true, false, true, address(room));
        emit CallZRoom.Kicked(address(rejecter), 1, PRICE);
        vm.prank(creator);
        room.kick(address(rejecter));
        assertEq(room.seatOf(address(rejecter)), 0);
        assertTrue(room.banned(address(rejecter)));
        _assertNoPass(room, 1);
        assertEq(address(rejecter).balance, 0);
        assertEq(room.owed(address(rejecter)), PRICE, "its price waits for it");
        assertEq(room.standingOf(address(rejecter)).owed, PRICE);

        // So is one that burns all the gas it is given: the kick costs a bounded amount.
        vm.prank(creator);
        room.kick(address(burner));
        uint256 kickGas = vm.lastCallGas().gasTotalUsed;
        assertLt(kickGas, 300_000, "a wallet cannot make its own removal expensive");
        assertEq(room.seatOf(address(burner)), 0);
        assertEq(room.owed(address(burner)), PRICE);
        emit log_named_uint("kick of a wallet that burns its gas, gas", kickGas);

        // What is owed is not part of the raise, and stays in the room.
        assertEq(room.raised(), PRICE);
        assertEq(room.seated(), 1);
        assertEq(address(room).balance, 3 * PRICE);

        // A wallet that takes its price and answers with as large a reply as its gas allows is paid, and its
        // removal still costs a bounded amount.
        RoomWallet bomber = new RoomWallet();
        _admit(room, address(bomber));
        bomber.mint{value: PRICE}(room);
        bomber.setMode(bomber.BOMB());
        vm.prank(creator);
        room.kick(address(bomber));
        kickGas = vm.lastCallGas().gasTotalUsed;
        assertLt(kickGas, 400_000, "a large reply cannot make a removal expensive");
        assertEq(address(bomber).balance, PRICE);
        assertEq(room.owed(address(bomber)), 0);
        assertEq(room.seatOf(address(bomber)), 0);
        assertEq(address(room).balance, 3 * PRICE);
        emit log_named_uint("kick of a wallet that answers with 176,000 bytes, gas", kickGas);

        // While they still cannot take BNB, `withdraw` fails and the amount stays owed.
        vm.expectRevert(CallZRoom.EthTransferFailed.selector);
        rejecter.withdraw(room);
        vm.expectRevert(CallZRoom.EthTransferFailed.selector);
        burner.withdraw{gas: 1_000_000}(room);
        assertEq(room.owed(address(rejecter)), PRICE);
        assertEq(room.owed(address(burner)), PRICE);
        assertEq(address(room).balance, 3 * PRICE);

        // Nobody else can collect it.
        vm.prank(attacker);
        vm.expectRevert(CallZRoom.NothingOwed.selector);
        room.withdraw();
        vm.prank(creator);
        vm.expectRevert(CallZRoom.NothingOwed.selector);
        room.withdraw();

        // Once they can, each collects exactly its price, once.
        rejecter.setMode(rejecter.ACCEPT());
        burner.setMode(burner.ACCEPT());
        vm.expectEmit(true, false, false, true, address(room));
        emit CallZRoom.Withdrawn(address(rejecter), PRICE);
        rejecter.withdraw(room);
        burner.withdraw(room);
        assertEq(address(rejecter).balance, PRICE);
        assertEq(address(burner).balance, PRICE);
        assertEq(room.owed(address(rejecter)), 0);
        assertEq(room.owed(address(burner)), 0);
        vm.expectRevert(CallZRoom.NothingOwed.selector);
        rejecter.withdraw(room);
        assertEq(address(room).balance, PRICE, "only the remaining member's price is left");
        assertEq(room.raised(), PRICE);

        // A wallet removed twice while it refuses BNB is owed both prices.
        vm.deal(address(rejecter), 0);
        vm.prank(creator);
        room.setBanned(address(rejecter), false);
        _admit(room, address(rejecter));
        rejecter.mint{value: PRICE}(room);
        rejecter.setMode(rejecter.REJECT());
        vm.prank(creator);
        room.kick(address(rejecter));
        vm.prank(creator);
        room.setBanned(address(rejecter), false);
        _admit(room, address(rejecter));
        rejecter.mint{value: PRICE}(room);
        vm.prank(creator);
        room.kick(address(rejecter));
        assertEq(room.owed(address(rejecter)), 2 * PRICE);
        assertEq(address(room).balance, 3 * PRICE);
        assertEq(room.raised(), PRICE);
        rejecter.setMode(rejecter.ACCEPT());
        rejecter.withdraw(room);
        assertEq(address(rejecter).balance, 2 * PRICE);
        assertEq(address(room).balance, PRICE);

        // What is owed survives a launch untouched.
        CallZRoom other = _createWithSeats(2);
        RoomWallet stuck = new RoomWallet();
        _admit(other, address(stuck));
        stuck.mint{value: PRICE}(other);
        stuck.setMode(stuck.REJECT());
        vm.prank(creator);
        other.kick(address(stuck));
        _fill(other);
        _launch(other);
        _assertLaunchState(other, 0, 0, PRICE);
        assertEq(other.owed(address(stuck)), PRICE);
        stuck.setMode(stuck.ACCEPT());
        stuck.withdraw(other);
        assertEq(address(stuck).balance, PRICE);
        assertEq(address(other).balance, 0);
    }

    function test_11_banRules() public {
        CallZRoom room = _createWithSeats(2);
        _seat(room, alice);

        vm.prank(attacker);
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.setBanned(bob, true);

        // A member is removed with `kick`, not barred in place.
        vm.prank(creator);
        vm.expectRevert(CallZRoom.AlreadyMember.selector);
        room.setBanned(alice, true);
        assertFalse(room.banned(alice));
        assertEq(room.seatOf(alice), 1);

        // Barring an admitted wallet takes its admission away.
        _admit(room, bob);
        vm.expectEmit(true, false, false, true, address(room));
        emit CallZRoom.AdmissionRevoked(bob);
        vm.expectEmit(true, false, false, true, address(room));
        emit CallZRoom.BanSet(bob, true);
        vm.prank(creator);
        room.setBanned(bob, true);
        assertTrue(room.banned(bob));
        assertFalse(room.admitted(bob));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.Banned.selector, bob));
        room.mint{value: PRICE}();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.Banned.selector, bob));
        room.admit(_one(bob));

        // Lifting the bar does not bring the admission back.
        vm.expectEmit(true, false, false, true, address(room));
        emit CallZRoom.BanSet(bob, false);
        vm.prank(creator);
        room.setBanned(bob, false);
        assertFalse(room.banned(bob));
        vm.prank(bob);
        vm.expectRevert(CallZRoom.NotAdmitted.selector);
        room.mint{value: PRICE}();
        _seat(room, bob);

        // After the launch nobody can be barred or removed.
        _launch(room);
        vm.prank(creator);
        vm.expectRevert(CallZRoom.AlreadyLaunched.selector);
        room.setBanned(carol, true);
        vm.prank(creator);
        vm.expectRevert(CallZRoom.AlreadyLaunched.selector);
        room.setBanned(carol, false);
        vm.prank(creator);
        vm.expectRevert(CallZRoom.AlreadyLaunched.selector);
        room.kick(alice);
        assertEq(room.seatOf(alice), 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. The pass stays with its holder
    // ─────────────────────────────────────────────────────────────────────────

    function test_12_aPassCannotChangeHands() public {
        CallZRoom room = _createWithSeats(2);
        _seat(room, alice);
        _seat(room, bob);

        _assertSoulbound(room);
        // Still so once the room has launched, and once the pass has claimed.
        _launch(room);
        _assertSoulbound(room);
        vm.prank(alice);
        room.claim();
        _assertSoulbound(room);
        assertEq(room.ownerOf(1), alice);
        assertEq(room.balanceOf(alice), 1);
        assertEq(room.balanceOf(carol), 0);
        assertEq(room.seatOf(alice), 1);
    }

    function _assertSoulbound(CallZRoom room) internal {
        vm.startPrank(alice);
        vm.expectRevert(CallZRoom.Soulbound.selector);
        room.transferFrom(alice, carol, 1);
        vm.expectRevert(CallZRoom.Soulbound.selector);
        room.safeTransferFrom(alice, carol, 1);
        vm.expectRevert(CallZRoom.Soulbound.selector);
        room.safeTransferFrom(alice, carol, 1, "");
        vm.expectRevert(CallZRoom.Soulbound.selector);
        room.transferFrom(alice, alice, 1);
        // To another member: no wallet ever holds two passes.
        vm.expectRevert(CallZRoom.Soulbound.selector);
        room.transferFrom(alice, bob, 1);
        // Nobody can be approved to move it, as a wallet or as an operator.
        vm.expectRevert(CallZRoom.Soulbound.selector);
        room.approve(carol, 1);
        vm.expectRevert(CallZRoom.Soulbound.selector);
        room.setApprovalForAll(dave, true);
        vm.stopPrank();
        assertEq(room.getApproved(1), address(0));
        assertFalse(room.isApprovedForAll(alice, dave));
        vm.prank(carol);
        vm.expectRevert(CallZRoom.Soulbound.selector);
        room.transferFrom(alice, carol, 1);
        vm.prank(carol);
        vm.expectRevert(CallZRoom.Soulbound.selector);
        room.safeTransferFrom(alice, carol, 1);
        vm.prank(dave);
        vm.expectRevert(CallZRoom.Soulbound.selector);
        room.transferFrom(alice, dave, 1);
        vm.prank(dave);
        vm.expectRevert(CallZRoom.Soulbound.selector);
        room.safeTransferFrom(alice, dave, 1, "");
        assertEq(room.ownerOf(1), alice);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Launch
    // ─────────────────────────────────────────────────────────────────────────

    function test_13_launchPaysTheFeeSeedsThePoolAndBurnsTheLp() public {
        CallZRoom room = _create(_config());
        _seat(room, alice);
        _seat(room, bob);
        _seat(room, carol);
        _seat(room, dave);

        // Not anyone's call but the creator's, and not with a seat free.
        vm.prank(attacker);
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.launch();
        vm.prank(alice);
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.launch();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.RoomNotFull.selector, 4, 5));
        room.launch();
        assertFalse(room.launched());
        assertEq(room.token(), address(0), "no token before the launch");

        _seat(room, erin);
        assertEq(room.raised(), 5 * PRICE);
        // Filling the room launches nothing by itself.
        assertFalse(room.launched());
        assertEq(_predictToken(room).code.length, 0);

        uint256 vaultBefore = address(vault).balance;
        uint256 teamBefore = team.balance;
        uint256 creatorBefore = creator.balance;

        vm.recordLogs();
        vm.prank(creator);
        room.launch();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        _assertLaunchState(room, 0, 0, 0);
        assertEq(creator.balance, creatorBefore, "the creator got nothing out of the launch");
        _assertFeePaid(room, logs, address(vault).balance - vaultBefore, team.balance - teamBefore);

        (, uint256 wbnbReserve) = _reserves(room.pair(), room.token());
        assertEq(wbnbReserve, 0.045 ether, "the rest of the raise is in the pool");
        assertEq(IERC20Metadata(room.token()).name(), "Call Room");
        assertEq(IERC20Metadata(room.token()).symbol(), "ROOM");
        assertEq(IERC20Metadata(room.token()).decimals(), 18);
        CallZRoomInfo memory i = room.info();
        assertTrue(i.launched);
        assertEq(i.token, room.token());
        assertEq(i.pair, room.pair());
        assertEq(i.seated, SEATS);
        assertEq(i.raised, 0);

        // Once only.
        vm.prank(creator);
        vm.expectRevert(CallZRoom.AlreadyLaunched.selector);
        room.launch();

        _tradeThroughTheRouter(room, room.tokensPerSeat());
    }

    /// @dev The fee of a launch that has just run: exactly `launchFeeBps` of the raise, paid to the vault, which
    ///      keeps the callers' part and passes the platform's part on to the team wallet.
    function _assertFeePaid(CallZRoom room, Vm.Log[] memory logs, uint256 toVault, uint256 toTeam) internal view {
        address token = room.token();
        uint256 raise = room.cap();
        uint256 fee = raise * room.launchFeeBps() / 10_000;
        uint256 toCallers = fee * 4500 / 10_000 + fee * 3000 / 10_000;
        assertEq(fee, 0.005 ether, "a tenth of the 0.05 BNB raise");
        assertEq(toVault, toCallers, "the vault keeps the callers' part of the fee");
        assertEq(toTeam, fee - toCallers, "the platform's part went on to the team wallet");
        assertEq(toVault + toTeam, fee, "the whole fee, and no more");
        (uint256 received,) = vault.ledgerOf(token);
        assertEq(received, toCallers, "booked under the launched token");

        (Vm.Log memory log, uint256 count) = _findLog(logs, address(room), CallZRoom.LaunchFeePaid.selector);
        assertEq(count, 1, "one LaunchFeePaid");
        assertEq(_topicAddress(log.topics[1]), token, "LaunchFeePaid: token");
        assertEq(_topicAddress(log.topics[2]), address(vault), "LaunchFeePaid: vault");
        assertEq(log.data, abi.encode(fee), "LaunchFeePaid: amount");
        (log, count) = _findLog(logs, address(vault), CallZVault.Deposited.selector);
        assertEq(count, 1, "one deposit into the vault");
        assertEq(_topicAddress(log.topics[1]), token, "Deposited: token");
        assertEq(_topicAddress(log.topics[2]), address(room), "Deposited: from the room");
        assertEq(log.data, abi.encode(fee), "Deposited: amount");
        (log, count) = _findLog(logs, address(room), CallZRoom.Launched.selector);
        assertEq(count, 1, "one Launched");
        assertEq(_topicAddress(log.topics[1]), token, "Launched: token");
        assertEq(_topicAddress(log.topics[2]), room.pair(), "Launched: pair");
        assertEq(
            log.data,
            abi.encode(raise - fee, room.poolTokens(), room.tokensPerSeat()),
            "Launched: raised, poolTokens, tokensPerSeat"
        );
        assertEq(room.tokensPerSeat(), TOTAL_SUPPLY / 2 / SEATS);
        assertEq(room.poolTokens(), TOTAL_SUPPLY / 2);
    }

    /// @dev A real buy and a real sell through the PancakeSwap router: both at the router's quote, no tax.
    function _tradeThroughTheRouter(CallZRoom room, uint256 share) internal {
        address token = room.token();
        address pair = room.pair();
        address[] memory buyPath = new address[](2);
        buyPath[0] = WBNB;
        buyPath[1] = token;
        uint256 buyQuote = ROUTER.getAmountsOut(0.01 ether, buyPath)[1];
        assertGt(buyQuote, 0);
        vm.prank(attacker);
        ROUTER.swapExactETHForTokens{value: 0.01 ether}(buyQuote, buyPath, attacker, block.timestamp);
        assertEq(IERC20(token).balanceOf(attacker), buyQuote, "the buy delivered the quoted amount");

        vm.prank(alice);
        room.claim();
        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = WBNB;
        uint256 sellQuote = ROUTER.getAmountsOut(share, sellPath)[1];
        assertGt(sellQuote, 0);
        uint256 pairTokensBefore = IERC20(token).balanceOf(pair);
        uint256 aliceBefore = alice.balance;
        vm.startPrank(alice);
        IERC20(token).approve(address(ROUTER), share);
        ROUTER.swapExactTokensForETH(share, sellQuote, sellPath, alice, block.timestamp);
        vm.stopPrank();
        assertEq(IERC20(token).balanceOf(pair), pairTokensBefore + share, "the sell reached the pair in full");
        assertEq(alice.balance, aliceBefore + sellQuote, "the sell paid the quoted BNB");

        // Trading does not create or free any LP.
        IRoomPairLike lp = IRoomPairLike(pair);
        assertEq(lp.balanceOf(DEAD), lp.totalSupply() - MINIMUM_LIQUIDITY);
        assertEq(IERC20(token).totalSupply(), TOTAL_SUPPLY, "the supply never changes");
    }

    function test_14_afterTheLaunchTheRoomIsClosedToEverythingButClaims() public {
        CallZRoom room = _createWithSeats(2);
        _seat(room, alice);
        _seat(room, bob);
        _admit(room, carol);
        _launch(room);

        vm.startPrank(creator);
        vm.expectRevert(CallZRoom.AlreadyLaunched.selector);
        room.launch();
        vm.expectRevert(CallZRoom.AlreadyLaunched.selector);
        room.kick(alice);
        vm.expectRevert(CallZRoom.AlreadyLaunched.selector);
        room.setBanned(carol, true);
        vm.expectRevert(CallZRoom.SaleClosed.selector);
        room.admit(_one(dave));
        vm.stopPrank();
        vm.prank(carol);
        vm.expectRevert(CallZRoom.AlreadyLaunched.selector);
        room.mint{value: PRICE}();

        // No pass can be handed back, before or after the deadline.
        assertFalse(room.refundAvailable());
        assertEq(room.refundableOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(CallZRoom.RefundUnavailable.selector);
        room.refund();
        vm.warp(room.saleDeadline() + 1);
        assertFalse(room.refundAvailable(), "no refund after a launch, even past the deadline");
        assertEq(room.refundableOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(CallZRoom.RefundUnavailable.selector);
        room.refund();

        // Both passes still claim.
        vm.prank(alice);
        room.claim();
        vm.prank(bob);
        room.claim();
        assertEq(IERC20(room.token()).balanceOf(address(room)), 0);
        assertEq(room.seatOf(alice), 1);
        assertEq(room.seatOf(bob), 2);
    }

    function test_15_aPairCreatedInAdvanceStillLaunches() public {
        CallZRoom room = _create(_config());
        _fill(room);

        address predicted = _predictToken(room);
        vm.prank(attacker);
        address pair = IRoomPancakeFactory(PANCAKE_FACTORY).createPair(predicted, WBNB);
        assertEq(IRoomPancakeFactory(PANCAKE_FACTORY).getPair(predicted, WBNB), pair);

        _launch(room);

        assertEq(room.pair(), pair, "the launch used the existing pair");
        _assertLaunchState(room, 0, 0, 0);
        assertEq(IRoomPairLike(pair).balanceOf(attacker), 0, "the stranger holds no LP");
    }

    /// @dev What a stranger can really do before the token exists: create the pair and send WBNB to it.
    function test_16_aPairCreatedInAdvanceHoldingDonatedWbnbStillLaunches() public {
        CallZRoom room = _create(_config());
        _fill(room);

        address predicted = _predictToken(room);
        uint256 donation = 0.05 ether;
        vm.startPrank(attacker);
        address pair = IRoomPancakeFactory(PANCAKE_FACTORY).createPair(predicted, WBNB);
        IRoomWBNBLike(WBNB).deposit{value: donation}();
        IERC20(WBNB).transfer(pair, donation);
        vm.stopPrank();
        (uint256 tokenReserve, uint256 wbnbReserve) = _reserves(pair, predicted);
        assertEq(tokenReserve + wbnbReserve, 0, "the donation is not in the reserves");

        _launch(room);

        assertEq(room.pair(), pair);
        // The donation joined the pool with the raise; all the LP it earned is burned with the rest.
        _assertLaunchState(room, 0, donation, 0);
        assertEq(IRoomPairLike(pair).balanceOf(attacker), 0);
    }

    /// @dev The state the router cannot handle: the pair exists and holds WBNB in its reserves, with no tokens.
    ///      On BNB Chain `sync()` cannot run on a pair before both of its tokens exist, so the test first shows
    ///      that the stranger's own `sync()` reverts, and then forces the same reserves a successful `sync()`
    ///      would have written. In that state `addLiquidityETH` reverts and the launch still succeeds.
    function test_17_aPairCreatedInAdvanceWithSyncedWbnbStillLaunches() public {
        CallZRoom room = _create(_config());
        _fill(room);

        address predicted = _predictToken(room);
        uint256 donation = 0.05 ether;
        vm.startPrank(attacker);
        address pair = IRoomPancakeFactory(PANCAKE_FACTORY).createPair(predicted, WBNB);
        IRoomWBNBLike(WBNB).deposit{value: donation}();
        IERC20(WBNB).transfer(pair, donation);
        vm.stopPrank();

        // On the live pair, sync() reads the balance of a token that has no code yet, and reverts.
        vm.prank(attacker);
        vm.expectRevert();
        IRoomPairLike(pair).sync();

        // Force the poisoned state all the same: give the token address code that answers zero to any call, let
        // the stranger's sync() go through, then remove that code again.
        vm.etch(predicted, hex"60206000f3");
        vm.prank(attacker);
        IRoomPairLike(pair).sync();
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
        _launch(room);

        assertEq(room.pair(), pair, "the launch used the pair the stranger created");
        // The stranger's WBNB is now pool liquidity that nobody can take out.
        _assertLaunchState(room, donation, 0, 0);
        assertEq(IERC20(WBNB).balanceOf(attacker), 0);
        assertEq(IRoomPairLike(pair).balanceOf(attacker), 0, "the stranger holds no LP");

        // Claims and trading work as usual.
        address member = room.ownerOf(1);
        vm.prank(member);
        room.claim();
        assertEq(IERC20(room.token()).balanceOf(member), room.tokensPerSeat());
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = room.token();
        uint256 quote = ROUTER.getAmountsOut(0.01 ether, path)[1];
        vm.prank(dave);
        ROUTER.swapExactETHForTokens{value: 0.01 ether}(quote, path, dave, block.timestamp);
        assertEq(IERC20(room.token()).balanceOf(dave), quote);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Claims
    // ─────────────────────────────────────────────────────────────────────────

    function test_18_everyPassClaimsItsShareOnce() public {
        CallZRoom room = _create(_config());
        uint256 share = TOTAL_SUPPLY / 2 / SEATS;
        _seat(room, alice);
        _seat(room, bob);
        // Bob is removed before the launch: he has no pass and nothing to claim.
        vm.prank(creator);
        room.kick(bob);
        _seat(room, carol);
        address[] memory rest = _fill(room);
        assertEq(rest.length, 3);

        // Nothing to claim before the launch.
        assertEq(room.claimableOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(CallZRoom.NotLaunched.selector);
        room.claim();
        vm.prank(attacker);
        vm.expectRevert(CallZRoom.NotLaunched.selector);
        room.claim();

        _launch(room);
        IERC20 token = IERC20(room.token());
        assertEq(room.tokensPerSeat(), share);
        assertEq(token.balanceOf(address(room)), SEATS * share);

        // Not a member: a stranger, the creator, and the wallet that was kicked.
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.NotMember.selector, attacker));
        room.claim();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.NotMember.selector, creator));
        room.claim();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.NotMember.selector, bob));
        room.claim();
        assertEq(room.claimableOf(bob), 0);
        assertEq(room.claimableOf(attacker), 0);

        assertEq(room.claimableOf(alice), share);
        assertFalse(room.standingOf(alice).claimed);
        vm.expectEmit(true, true, false, true, address(room));
        emit CallZRoom.Claimed(1, alice, share);
        vm.prank(alice);
        room.claim();
        assertEq(token.balanceOf(alice), share);
        assertTrue(room.claimed(1));
        assertTrue(room.standingOf(alice).claimed);
        assertEq(room.claimableOf(alice), 0);
        assertEq(room.ownerOf(1), alice, "the pass stays with its holder");

        // A pass claims once.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.AlreadyClaimed.selector, 1));
        room.claim();
        assertEq(token.balanceOf(alice), share);

        uint256 carolPass = room.seatOf(carol);
        assertEq(carolPass, 3);
        vm.prank(carol);
        room.claim();
        assertEq(token.balanceOf(carol), share);
        for (uint256 i; i < rest.length; ++i) {
            uint256 pass = room.seatOf(rest[i]);
            assertEq(pass, 4 + i);
            assertEq(room.claimableOf(rest[i]), share);
            vm.prank(rest[i]);
            room.claim();
            assertEq(token.balanceOf(rest[i]), share);
            vm.prank(rest[i]);
            vm.expectRevert(abi.encodeWithSelector(CallZRoom.AlreadyClaimed.selector, pass));
            room.claim();
        }

        assertEq(token.balanceOf(address(room)), 0, "every share has been claimed");
        assertEq(token.balanceOf(bob), 0, "the kicked wallet got no tokens");
        assertEq(token.balanceOf(creator), 0);
        assertEq(token.balanceOf(room.pair()) + SEATS * share, TOTAL_SUPPLY, "pool + every claim is the supply");
    }

    function test_19_unevenSeatCountsLeaveNoTokenWithoutAnOwner() public {
        _launchAndClaimAll(3, 3333);
        _launchAndClaimAll(7, 1000);
        _launchAndClaimAll(13, 9000);
        _launchAndClaimAll(7, 5000);
    }

    /// @dev A room whose supply does not split evenly: launch it, let every pass claim, and count every token.
    function _launchAndClaimAll(uint256 seats, uint16 poolShareBps) internal {
        CallZRoomConfig memory c = _config();
        c.seats = seats;
        c.poolShareBps = poolShareBps;
        CallZRoom room = _create(c);
        // The same wallets sit in each of the rooms.
        walletCounter = 0;
        address[] memory wallets = _fill(room);
        _launch(room);
        _assertLaunchState(room, 0, 0, 0);

        IERC20 token = IERC20(room.token());
        uint256 basePool = TOTAL_SUPPLY * poolShareBps / 10_000;
        uint256 share = (TOTAL_SUPPLY - basePool) / seats;
        uint256 dust = (TOTAL_SUPPLY - basePool) - share * seats;
        assertEq(room.tokensPerSeat(), share);
        assertGt(dust, 0, "this split does not divide evenly");
        assertLt(dust, seats, "the dust is smaller than one base unit per seat");
        uint256 pool = token.balanceOf(room.pair());
        assertEq(pool, basePool + dust, "the pool share of the supply, plus the dust, is in the pool");

        for (uint256 i; i < wallets.length; ++i) {
            vm.prank(wallets[i]);
            room.claim();
            assertEq(token.balanceOf(wallets[i]), share, "every pass claims the same");
        }
        assertEq(token.balanceOf(address(room)), 0, "nothing is stranded in the room");
        assertEq(pool + wallets.length * share, TOTAL_SUPPLY, "pool + every claim is the whole supply");
        assertEq(wallets.length, seats);
    }

    /// @dev For every allowed pool share and seat count, the pool and the passes together own the whole supply.
    function testFuzz_20_theSplitLeavesNoTokenWithoutAnOwner(uint16 poolShareBps, uint256 seats) public {
        poolShareBps = uint16(bound(poolShareBps, 1000, 9000));
        seats = bound(seats, 1, 1000);
        CallZRoomConfig memory c = _config();
        c.seatPrice = 0.001 ether;
        c.seats = seats;
        c.poolShareBps = poolShareBps;
        CallZRoom room = _create(c);

        uint256 basePool = TOTAL_SUPPLY * poolShareBps / 10_000;
        uint256 share = room.tokensPerSeat();
        uint256 pool = room.poolTokens();
        assertEq(share, (TOTAL_SUPPLY - basePool) / seats);
        assertGt(share, 0);
        assertEq(pool + share * seats, TOTAL_SUPPLY, "pool + every pass's share is the whole supply");
        assertGe(pool, basePool);
        assertLt(pool - basePool, seats, "the dust is smaller than one base unit per seat");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. The deadline
    // ─────────────────────────────────────────────────────────────────────────

    function test_21_afterTheDeadlineEveryMemberTakesTheirPriceBack() public {
        CallZRoom room = _create(_config());
        _seat(room, alice);
        _seat(room, bob);
        _seat(room, carol);
        _admit(room, dave);
        uint256 creatorBefore = creator.balance;

        // Not before the deadline.
        assertFalse(room.refundAvailable());
        assertEq(room.refundableOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(CallZRoom.RefundUnavailable.selector);
        room.refund();
        vm.warp(room.saleDeadline() - 1);
        vm.prank(alice);
        vm.expectRevert(CallZRoom.RefundUnavailable.selector);
        room.refund();

        vm.warp(room.saleDeadline());
        assertTrue(room.refundAvailable());
        assertEq(room.refundableOf(alice), PRICE);
        assertEq(room.refundableOf(dave), 0, "admitted, never bought");
        assertEq(room.refundableOf(attacker), 0);

        // The sale is closed for good, and a room with a free seat cannot launch.
        vm.prank(dave);
        vm.expectRevert(CallZRoom.SaleClosed.selector);
        room.mint{value: PRICE}();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.RoomNotFull.selector, 3, 5));
        room.launch();

        // Only a member has something to hand back.
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.NotMember.selector, attacker));
        room.refund();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.NotMember.selector, creator));
        room.refund();

        vm.expectEmit(true, true, true, true, address(room));
        emit Transfer(alice, address(0), 1);
        vm.expectEmit(true, true, false, true, address(room));
        emit CallZRoom.Refunded(1, alice, PRICE);
        vm.prank(alice);
        room.refund();
        assertEq(alice.balance, START, "alice got exactly her price back");
        assertEq(room.raised(), 2 * PRICE);
        assertEq(room.seated(), 2);
        assertEq(address(room).balance, 2 * PRICE);
        assertFalse(room.banned(alice), "handing a pass back bars nobody");
        _assertNoPass(room, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.NotMember.selector, alice));
        room.refund();

        vm.prank(carol);
        room.refund();
        vm.prank(bob);
        room.refund();
        assertEq(bob.balance, START);
        assertEq(carol.balance, START);
        assertEq(room.raised(), 0);
        assertEq(room.seated(), 0);
        assertEq(room.memberCount(), 0);
        assertEq(room.minted(), 3);
        assertEq(address(room).balance, 0, "the room is empty");
        assertEq(creator.balance, creatorBefore, "the creator got nothing");

        // Nothing was launched and nothing can be: no token, no pair, no claim, no mint.
        assertFalse(room.launched());
        assertEq(room.token(), address(0));
        address neverDeployed = _predictToken(room);
        assertEq(neverDeployed.code.length, 0, "no token was deployed");
        assertEq(IRoomPancakeFactory(PANCAKE_FACTORY).getPair(neverDeployed, WBNB), address(0), "no pair was created");
        vm.prank(alice);
        vm.expectRevert(CallZRoom.NotLaunched.selector);
        room.claim();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.RoomNotFull.selector, 0, 5));
        room.launch();

        // A member that cannot take BNB keeps its pass until it can.
        CallZRoom other = _create(_config());
        RoomWallet wallet = new RoomWallet();
        _admit(other, address(wallet));
        wallet.mint{value: PRICE}(other);
        wallet.setMode(wallet.REJECT());
        vm.warp(other.saleDeadline());
        vm.expectRevert(CallZRoom.EthTransferFailed.selector);
        wallet.refund(other);
        assertEq(other.seatOf(address(wallet)), 1);
        assertEq(other.raised(), PRICE);
        wallet.setMode(wallet.ACCEPT());
        wallet.refund(other);
        assertEq(address(wallet).balance, PRICE);
        assertEq(address(other).balance, 0);
    }

    function test_22_aFullRoomCanLaunchAfterTheDeadlineUntilAMemberLeaves() public {
        // Full at the deadline: the creator can still launch.
        CallZRoom full = _createWithSeats(3);
        _seat(full, alice);
        _seat(full, bob);
        _seat(full, carol);
        vm.warp(full.saleDeadline() + 1 hours);
        assertTrue(full.refundAvailable());
        assertEq(full.refundableOf(alice), PRICE);
        _launch(full);
        _assertLaunchState(full, 0, 0, 0);
        vm.prank(alice);
        vm.expectRevert(CallZRoom.RefundUnavailable.selector);
        full.refund();
        assertEq(full.refundableOf(alice), 0);
        vm.prank(alice);
        full.claim();
        assertEq(IERC20(full.token()).balanceOf(alice), full.tokensPerSeat());

        // Full at the deadline, then one member hands the pass back: the room can never fill up again.
        CallZRoom lost = _createWithSeats(3);
        _seat(lost, alice);
        _seat(lost, bob);
        _seat(lost, carol);
        _admit(lost, dave);
        vm.warp(lost.saleDeadline());
        vm.prank(alice);
        lost.refund();
        assertEq(lost.seated(), 2);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.RoomNotFull.selector, 2, 3));
        lost.launch();
        vm.prank(dave);
        vm.expectRevert(CallZRoom.SaleClosed.selector);
        lost.mint{value: PRICE}();
        vm.prank(creator);
        vm.expectRevert(CallZRoom.SaleClosed.selector);
        lost.admit(_one(erin));
        // The member who left cannot buy back in either.
        vm.prank(alice);
        vm.expectRevert(CallZRoom.SaleClosed.selector);
        lost.mint{value: PRICE}();

        vm.prank(bob);
        lost.refund();
        vm.prank(carol);
        lost.refund();
        assertEq(address(lost).balance, 0);
        assertEq(lost.raised(), 0);
        assertFalse(lost.launched());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 9. The raise is not the creator's
    // ─────────────────────────────────────────────────────────────────────────

    function test_23_theCreatorCannotTakeTheRaise() public {
        CallZRoom room = _createWithSeats(3);
        uint256 creatorBefore = creator.balance;
        _seat(room, alice);
        _seat(room, bob);
        assertEq(address(room).balance, 2 * PRICE);

        // Every way out of the room is closed to a creator who holds no pass.
        vm.startPrank(creator);
        vm.expectRevert(CallZRoom.NothingOwed.selector);
        room.withdraw();
        vm.expectRevert(CallZRoom.RefundUnavailable.selector);
        room.refund();
        vm.expectRevert(CallZRoom.NotLaunched.selector);
        room.claim();
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.RoomNotFull.selector, 2, 3));
        room.launch();
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.NotMember.selector, creator));
        room.kick(creator);
        vm.stopPrank();
        // There is no other function to call: anything else has no code behind it.
        bytes[5] memory guesses = [
            abi.encodeWithSignature("withdraw(uint256)", 2 * PRICE),
            abi.encodeWithSignature("withdraw(address)", creator),
            abi.encodeWithSignature("sweep()"),
            abi.encodeWithSignature("rescue(address,uint256)", creator, 2 * PRICE),
            abi.encodeWithSignature("collect(uint256)", 1)
        ];
        for (uint256 i; i < guesses.length; ++i) {
            vm.prank(creator);
            (bool ok,) = address(room).call(guesses[i]);
            assertFalse(ok, "no such function");
        }
        assertEq(address(room).balance, 2 * PRICE);

        // A kick pays the kicked wallet, not the creator.
        vm.prank(creator);
        room.kick(alice);
        assertEq(alice.balance, START);
        assertEq(creator.balance, creatorBefore);
        assertEq(address(room).balance, PRICE);

        // The launch pays the vault and the pool, not the creator.
        _seat(room, carol);
        _seat(room, dave);
        uint256 feeBefore = _feeHolders();
        _launch(room);
        _assertLaunchState(room, 0, 0, 0);
        assertEq(creator.balance, creatorBefore, "the creator's balance never moved");
        uint256 inPool = IERC20(WBNB).balanceOf(room.pair());
        assertEq(_feeHolders() - feeBefore + inPool, 3 * PRICE, "the whole raise is accounted for");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.NotMember.selector, creator));
        room.claim();
        assertEq(IERC20(room.token()).balanceOf(creator), 0);

        // A room that misses its deadline pays its members, not the creator.
        CallZRoom missed = _createWithSeats(3);
        _seat(missed, bob);
        _seat(missed, carol);
        vm.warp(missed.saleDeadline());
        vm.startPrank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.NotMember.selector, creator));
        missed.refund();
        vm.expectRevert(CallZRoom.NothingOwed.selector);
        missed.withdraw();
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.RoomNotFull.selector, 2, 3));
        missed.launch();
        // Kicking after the deadline still pays the member.
        missed.kick(bob);
        vm.stopPrank();
        assertEq(bob.balance, START - PRICE, "bob has his price for this room back; the other room launched");
        vm.prank(carol);
        missed.refund();
        assertEq(address(missed).balance, 0);
        assertEq(creator.balance, creatorBefore);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 9. Random sequences
    // ─────────────────────────────────────────────────────────────────────────

    function _canReceive(address wallet) internal view returns (bool) {
        return !isContractWallet[wallet] || RoomWallet(payable(wallet)).mode() == 0;
    }

    function _sumOwed(CallZRoom room) internal view returns (uint256 total) {
        for (uint256 i; i < actors.length; ++i) {
            total += room.owed(actors[i]);
        }
    }

    /// @dev One room, eight wallets (two of them contracts that sometimes refuse BNB), and `steps` random actions
    ///      by random callers. After every action the room's books are checked in full.
    function _runSequence(uint256 seed, uint256 steps) internal returns (Outcome memory o) {
        CallZRoomConfig memory c = _config();
        c.seats = 2 + seed % 4;
        c.poolShareBps = uint16(1000 + (seed >> 8) % 8001);
        CallZRoom room = _create(c);

        delete actors;
        for (uint256 i; i < 6; ++i) {
            actors.push(_wallet(100 + i));
        }
        // Two contract wallets. The second one starts out refusing BNB.
        for (uint256 i; i < 2; ++i) {
            RoomWallet wallet = new RoomWallet();
            vm.deal(address(wallet), START);
            wallet.setMode(uint8(i));
            isContractWallet[address(wallet)] = true;
            actors.push(address(wallet));
        }
        for (uint256 i; i < actors.length; ++i) {
            startBalance[actors[i]] = actors[i].balance;
        }
        creatorStart = creator.balance;
        mintedSeen = 0;

        _checkBooks(room);
        for (uint256 step; step < steps; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            o = this.stepAndCheck(room, seed, o);
        }
        o.launched = room.launched();
    }

    /// @dev One random action and the full check of the books after it. Its own call, so that the memory the
    ///      checks use is given back after every step.
    function stepAndCheck(CallZRoom room, uint256 r, Outcome memory o) external returns (Outcome memory) {
        require(msg.sender == address(this), "only the test itself");
        _step(room, r, o);
        _checkBooks(room);
        return o;
    }

    /// @dev One random action. Whether it goes through is predicted from the room's state first, so an action
    ///      that should work and does not, or the other way round, fails the test.
    function _step(CallZRoom room, uint256 r, Outcome memory o) internal {
        uint256 action = r % 100;
        uint256 dice = r >> 16;
        address other = actors[(dice >> 64) % actors.length];

        if (action < 22) {
            _tryAdmit(room, _pick(room, dice, ANY));
        } else if (action < 25) {
            bytes memory data = abi.encodeCall(CallZRoom.admit, (_one(other)));
            assertFalse(_send(room, _pick(room, dice, ANY), 0, data), "admit by somebody else");
        } else if (action < 50) {
            _tryMint(room, _pick(room, dice, ADMITTED), (dice >> 40) % 10 == 0 ? PRICE + 1 : PRICE, o);
        } else if (action < 56) {
            _tryKick(room, _pick(room, dice, MEMBER), o);
        } else if (action < 58) {
            bytes memory data = abi.encodeCall(CallZRoom.kick, (other));
            assertFalse(_send(room, _pick(room, dice, ANY), 0, data), "kick by somebody else");
        } else if (action < 63) {
            _trySetBanned(room, _pick(room, dice, ANY), (dice >> 40) % 2 == 0);
        } else if (action < 66) {
            bytes memory data = abi.encodeCall(CallZRoom.revoke, (_one(other)));
            assertTrue(_send(room, creator, 0, data), "revoke by the creator");
            assertFalse(room.admitted(other));
        } else if (action < 74) {
            // Mostly a few hours; now and then straight to the deadline or just past it.
            if ((dice >> 40) % 10 == 0 && block.timestamp < room.saleDeadline()) {
                vm.warp(room.saleDeadline() + (dice >> 48) % 2);
            } else {
                vm.warp(block.timestamp + (dice >> 40) % 3 hours);
            }
        } else if (action < 81) {
            _tryRefund(room, _pick(room, dice, MEMBER), o);
        } else if (action < 86) {
            address wallet = _pick(room, dice, OWED);
            // A contract wallet that refused BNB when it was removed has, half the time, started taking it since.
            if (isContractWallet[wallet] && (dice >> 40) % 2 == 0) RoomWallet(payable(wallet)).setMode(0);
            _tryWithdraw(room, wallet, o);
        } else if (action < 93) {
            _tryLaunch(room);
        } else if (action < 94) {
            bytes memory data = abi.encodeCall(CallZRoom.launch, ());
            assertFalse(_send(room, _pick(room, dice, ANY), 0, data), "launch by somebody else");
        } else if (action < 97) {
            _tryClaim(room, _pick(room, dice, MEMBER), o);
        } else {
            RoomWallet(payable(actors[6 + (dice >> 40) % 2])).setMode(uint8((dice >> 48) % 2));
        }
    }

    uint8 internal constant ANY = 0;
    uint8 internal constant ADMITTED = 1;
    uint8 internal constant MEMBER = 2;
    uint8 internal constant OWED = 3;

    /// @dev A random wallet. Half the time, when `want` names a kind of wallet the action can work for and there
    ///      is one, a random wallet of that kind: otherwise the sequences would rarely get past the first steps.
    function _pick(CallZRoom room, uint256 dice, uint8 want) internal view returns (address) {
        uint256 count = actors.length;
        uint256 start = (dice >> 8) % count;
        if (want != ANY && dice % 2 == 0) {
            for (uint256 i; i < count; ++i) {
                address wallet = actors[(start + i) % count];
                if (want == ADMITTED && room.admitted(wallet)) return wallet;
                if (want == MEMBER && room.seatOf(wallet) != 0) return wallet;
                if (want == OWED && room.owed(wallet) != 0) return wallet;
            }
        }
        return actors[start];
    }

    /// @dev `sender` calls the room. Returns whether the call went through.
    function _send(CallZRoom room, address sender, uint256 value, bytes memory data) internal returns (bool ok) {
        vm.prank(sender);
        (ok,) = address(room).call{value: value}(data);
    }

    function _isOpen(CallZRoom room) internal view returns (bool) {
        return !room.launched() && block.timestamp < room.saleDeadline();
    }

    function _tryAdmit(CallZRoom room, address wallet) internal {
        bool expected = _isOpen(room) && !room.banned(wallet);
        bool ok = _send(room, creator, 0, abi.encodeCall(CallZRoom.admit, (_one(wallet))));
        assertEq(ok, expected, "admit by the creator");
        if (ok) assertTrue(room.admitted(wallet) || room.seatOf(wallet) != 0, "let in, unless already a member");
    }

    function _tryMint(CallZRoom room, address wallet, uint256 value, Outcome memory o) internal {
        bool expected = _isOpen(room) && !room.banned(wallet) && room.seatOf(wallet) == 0 && room.admitted(wallet)
            && room.seated() < room.seats() && value == PRICE;
        uint256 mintedBefore = room.minted();
        bool ok = _send(room, wallet, value, abi.encodeCall(CallZRoom.mint, ()));
        assertEq(ok, expected, "mint");
        if (ok) {
            ++o.mints;
            assertEq(room.seatOf(wallet), mintedBefore + 1, "a new pass always gets the next number");
        }
    }

    function _tryKick(CallZRoom room, address wallet, Outcome memory o) internal {
        bool expected = !room.launched() && room.seatOf(wallet) != 0;
        uint256 owedBefore = room.owed(wallet);
        bool ok = _send(room, creator, 0, abi.encodeCall(CallZRoom.kick, (wallet)));
        assertEq(ok, expected, "kick by the creator");
        if (!ok) return;
        ++o.kicks;
        assertTrue(room.banned(wallet), "a kicked wallet is barred");
        if (_canReceive(wallet)) {
            assertEq(room.owed(wallet), owedBefore, "a wallet that takes BNB is paid at once");
        } else {
            assertEq(room.owed(wallet), owedBefore + PRICE, "a wallet that refuses BNB is owed its price");
            ++o.owedKicks;
        }
    }

    function _trySetBanned(CallZRoom room, address wallet, bool flag) internal {
        bool expected = !room.launched() && !(flag && room.seatOf(wallet) != 0);
        bool ok = _send(room, creator, 0, abi.encodeCall(CallZRoom.setBanned, (wallet, flag)));
        assertEq(ok, expected, "setBanned by the creator");
        if (ok) assertEq(room.banned(wallet), flag);
    }

    function _tryRefund(CallZRoom room, address wallet, Outcome memory o) internal {
        bool expected = !room.launched() && block.timestamp >= room.saleDeadline() && room.seatOf(wallet) != 0
            && _canReceive(wallet);
        bool ok = _send(room, wallet, 0, abi.encodeCall(CallZRoom.refund, ()));
        assertEq(ok, expected, "refund");
        if (ok) ++o.refunds;
    }

    function _tryWithdraw(CallZRoom room, address wallet, Outcome memory o) internal {
        bool expected = room.owed(wallet) != 0 && _canReceive(wallet);
        bool ok = _send(room, wallet, 0, abi.encodeCall(CallZRoom.withdraw, ()));
        assertEq(ok, expected, "withdraw");
        if (ok) {
            ++o.withdrawals;
            assertEq(room.owed(wallet), 0);
        }
    }

    function _tryLaunch(CallZRoom room) internal {
        bool expected = !room.launched() && room.seated() == room.seats();
        bool ok = _send(room, creator, 0, abi.encodeCall(CallZRoom.launch, ()));
        assertEq(ok, expected, "launch by the creator");
        if (ok) _assertLaunchState(room, 0, 0, _sumOwed(room));
    }

    function _tryClaim(CallZRoom room, address wallet, Outcome memory o) internal {
        uint256 seat = room.seatOf(wallet);
        bool expected = room.launched() && seat != 0 && !room.claimed(seat);
        bool ok = _send(room, wallet, 0, abi.encodeCall(CallZRoom.claim, ()));
        assertEq(ok, expected, "claim");
        if (ok) ++o.claims;
    }

    /// @dev The room's books, checked in full.
    function _checkBooks(CallZRoom room) internal {
        uint256 owedSum = _checkActors(room);
        bool launched = room.launched();
        uint256 seated = room.seated();

        if (launched) {
            assertEq(address(room).balance, owedSum, "after the launch the room holds only what it owes");
            assertEq(room.raised(), 0, "nothing is held for a launch any more");
            assertEq(seated, room.seats(), "a launched room is full and stays full");
        } else {
            assertEq(room.raised(), seated * PRICE, "the raise is the price of every seat taken");
            assertEq(address(room).balance, room.raised() + owedSum, "the room holds the raise and what it owes");
        }
        assertLe(seated, room.seats(), "never more members than seats");
        assertEq(room.memberCount(), seated, "the member list has one entry per seat taken");
        assertEq(_livePasses(room), seated, "one live pass per seat taken");
        assertGe(room.minted(), mintedSeen, "issued passes only count up");
        mintedSeen = room.minted();
        _checkMembers(room, seated);

        assertEq(creator.balance, creatorStart, "the creator's balance never moves");
        assertEq(room.owed(creator), 0, "the creator is owed nothing");
        if (launched) _checkTokens(room);
    }

    /// @dev Every wallet's BNB is where it should be: in the wallet, owed to it, or paid for the pass it holds.
    function _checkActors(CallZRoom room) internal view returns (uint256 owedSum) {
        for (uint256 i; i < actors.length; ++i) {
            address wallet = actors[i];
            uint256 owed = room.owed(wallet);
            uint256 seat = room.seatOf(wallet);
            owedSum += owed;
            uint256 paid = seat != 0 ? PRICE : 0;
            assertEq(wallet.balance + owed + paid, startBalance[wallet], "no wallet gained or lost BNB");
            assertEq(room.balanceOf(wallet), seat != 0 ? 1 : 0, "a pass for a member, none for anyone else");
            if (seat != 0) {
                assertEq(room.ownerOf(seat), wallet, "a wallet's pass is its own");
                assertLe(seat, room.minted());
            }
            if (room.banned(wallet)) {
                assertEq(seat, 0, "a barred wallet is not a member");
                assertFalse(room.admitted(wallet), "a barred wallet is not admitted");
            }
            if (seat != 0) assertFalse(room.admitted(wallet), "a member holds no unused admission");
        }
    }

    function _livePasses(CallZRoom room) internal returns (uint256 live) {
        uint256 minted = room.minted();
        for (uint256 id = 1; id <= minted; ++id) {
            try room.ownerOf(id) returns (address holder) {
                ++live;
                assertEq(room.seatOf(holder), id, "a live pass is its holder's seat");
            } catch {}
        }
        // No pass exists outside the issued range.
        vm.expectRevert(ERC721.TokenDoesNotExist.selector);
        room.ownerOf(0);
        vm.expectRevert(ERC721.TokenDoesNotExist.selector);
        room.ownerOf(minted + 1);
    }

    function _checkMembers(CallZRoom room, uint256 seated) internal view {
        (address[] memory wallets, uint256[] memory ids) = room.members(0, type(uint256).max);
        assertEq(wallets.length, seated);
        for (uint256 i; i < wallets.length; ++i) {
            uint256 seat = room.seatOf(wallets[i]);
            assertGt(seat, 0, "everyone in the list has a pass");
            assertEq(ids[i], seat, "the list gives the member's pass");
            assertEq(room.ownerOf(seat), wallets[i], "the member holds that pass");
            assertFalse(room.banned(wallets[i]), "no barred wallet is a member");
        }
    }

    /// @dev After the launch: the room holds exactly the shares not claimed yet, and each member holds its own.
    function _checkTokens(CallZRoom room) internal view {
        IERC20 token = IERC20(room.token());
        uint256 share = room.tokensPerSeat();
        uint256 unclaimed;
        for (uint256 i; i < actors.length; ++i) {
            uint256 seat = room.seatOf(actors[i]);
            bool claimed = seat != 0 && room.claimed(seat);
            if (seat != 0 && !claimed) ++unclaimed;
            assertEq(token.balanceOf(actors[i]), claimed ? share : 0, "a share for a pass that claimed, else none");
        }
        assertEq(token.balanceOf(address(room)), unclaimed * share, "the room holds the shares not claimed yet");
        assertEq(token.balanceOf(creator), 0);
    }

    /// forge-config: default.fuzz.runs = 96
    function testFuzz_24_randomActionsNeverBreakTheBooks(uint256 seed) public {
        _runSequence(seed, 70);
    }

    /// @dev The same sequences from fixed seeds, to show that they do reach every outcome: rooms that launch and
    ///      claim, rooms that miss the deadline and refund, kicks that are paid at once and kicks that leave the
    ///      price owed.
    function test_25_randomSequencesReachEveryOutcome() public {
        Outcome memory total;
        uint256 launches;
        for (uint256 i; i < 20; ++i) {
            Outcome memory o = _runSequence(uint256(keccak256(abi.encode("CallZRoom sequence", i))), 90);
            if (o.launched) ++launches;
            total.mints += o.mints;
            total.kicks += o.kicks;
            total.owedKicks += o.owedKicks;
            total.refunds += o.refunds;
            total.withdrawals += o.withdrawals;
            total.claims += o.claims;
        }
        emit log_named_uint("sequences", 20);
        emit log_named_uint("rooms launched", launches);
        emit log_named_uint("passes bought", total.mints);
        emit log_named_uint("kicks", total.kicks);
        emit log_named_uint("kicks that left the price owed", total.owedKicks);
        emit log_named_uint("passes handed back", total.refunds);
        emit log_named_uint("withdrawals", total.withdrawals);
        emit log_named_uint("claims", total.claims);
        assertGt(launches, 0, "some rooms launched");
        assertLt(launches, 20, "some rooms did not");
        assertGt(total.kicks, 0);
        assertGt(total.owedKicks, 0);
        assertGt(total.refunds, 0);
        assertGt(total.withdrawals, 0);
        assertGt(total.claims, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 10. Reentrancy
    // ─────────────────────────────────────────────────────────────────────────

    function _allAttempts(RoomReenterer r) internal view returns (uint8) {
        return r.TRY_MINT() | r.TRY_REFUND() | r.TRY_WITHDRAW() | r.TRY_CLAIM() | r.TRY_LAUNCH() | r.TRY_KICK();
    }

    function test_26_reentryDuringAKickRepaymentGainsNothing() public {
        // A member that calls back when the creator removes it.
        CallZRoom room = _createWithSeats(3);
        RoomReenterer member = new RoomReenterer();
        member.join(room);
        _admit(room, address(member));
        member.mint{value: PRICE}();
        _seat(room, alice);
        member.arm(_allAttempts(member), alice);

        vm.prank(creator);
        room.kick(address(member));

        assertEq(member.payments(), 1, "paid once");
        assertEq(address(member).balance, PRICE, "exactly its price");
        assertEq(member.succeeded(), 0, "nothing it tried went through");
        assertEq(member.mintError(), CallZRoom.Banned.selector);
        assertEq(member.refundError(), CallZRoom.RefundUnavailable.selector);
        assertEq(member.withdrawError(), CallZRoom.NothingOwed.selector);
        assertEq(member.claimError(), CallZRoom.NotLaunched.selector);
        assertEq(member.launchError(), CallZRoom.NotCreator.selector);
        assertEq(member.kickError(), CallZRoom.NotCreator.selector);
        assertEq(room.owed(address(member)), 0);
        assertEq(room.seatOf(address(member)), 0);
        assertEq(room.seated(), 1);
        assertEq(room.raised(), PRICE);
        assertEq(address(room).balance, PRICE, "alice's BNB is untouched");
        _assertMembers(room, _one(alice));

        // The same, when the wallet being removed is also the room's creator: it removes itself from a full room
        // and, while it is being repaid, tries to launch with the money it is getting back.
        RoomReenterer both = new RoomReenterer();
        CallZRoomConfig memory c = _config();
        c.seats = 3;
        CallZRoom own = both.create(factory, c, bytes32(uint256(1)));
        address[] memory three = new address[](3);
        three[0] = address(both);
        three[1] = alice;
        three[2] = bob;
        both.admit(three);
        both.mint{value: PRICE}();
        vm.prank(alice);
        own.mint{value: PRICE}();
        vm.prank(bob);
        own.mint{value: PRICE}();
        assertEq(own.seated(), 3);
        both.arm(_allAttempts(both) ^ both.TRY_KICK(), alice);

        both.kick(address(both));

        assertEq(both.payments(), 1, "paid once");
        assertEq(address(both).balance, PRICE, "exactly its price");
        assertEq(both.succeeded(), 0, "nothing it tried went through");
        assertEq(both.mintError(), CallZRoom.Banned.selector);
        assertEq(both.refundError(), CallZRoom.RefundUnavailable.selector);
        assertEq(both.withdrawError(), CallZRoom.NothingOwed.selector);
        assertEq(both.claimError(), CallZRoom.NotLaunched.selector);
        assertEq(both.launchError(), CallZRoom.RoomNotFull.selector, "its seat was free before it was paid");
        assertFalse(own.launched());
        assertEq(own.seated(), 2);
        assertEq(own.raised(), 2 * PRICE);
        assertEq(address(own).balance, 2 * PRICE);
    }

    /// @dev The creator, while it is repaid for its own removal, removes somebody else. That is a kick like any
    ///      other, if the repayment's gas allowance stretches to it: either way the books stay whole.
    function test_27_aKickFromInsideAKickRepaymentKeepsTheBooksWhole() public {
        RoomReenterer both = new RoomReenterer();
        CallZRoomConfig memory c = _config();
        c.seats = 3;
        CallZRoom own = both.create(factory, c, bytes32(uint256(1)));
        address[] memory three = new address[](3);
        three[0] = address(both);
        three[1] = alice;
        three[2] = bob;
        both.admit(three);
        both.mint{value: PRICE}();
        vm.prank(alice);
        own.mint{value: PRICE}();
        vm.prank(bob);
        own.mint{value: PRICE}();
        both.arm(both.TRY_KICK(), alice);

        both.kick(address(both));

        assertEq(own.seatOf(address(both)), 0);
        assertEq(address(both).balance + own.owed(address(both)), PRICE, "its price once, paid or owed");
        bool nested = (both.succeeded() & both.TRY_KICK()) != 0;
        if (nested) {
            assertEq(alice.balance, START, "alice got her price back");
            assertEq(own.seatOf(alice), 0);
            assertTrue(own.banned(alice));
            assertEq(own.seated(), 1);
        } else {
            assertEq(alice.balance, START - PRICE);
            assertEq(own.seatOf(alice), 1);
            assertEq(own.seated(), 2);
        }
        assertEq(own.raised(), own.seated() * PRICE);
        assertEq(address(own).balance, own.raised() + own.owed(address(both)));
        assertEq(bob.balance, START - PRICE);
        emit log_named_string("the kick from inside the repayment", nested ? "went through" : "ran out of gas");
    }

    function test_28_reentryDuringARefundGainsNothing() public {
        // A member that calls back when it hands its pass back.
        CallZRoom room = _createWithSeats(3);
        RoomReenterer member = new RoomReenterer();
        member.join(room);
        _admit(room, address(member));
        member.mint{value: PRICE}();
        _seat(room, alice);
        member.arm(_allAttempts(member), alice);
        vm.warp(room.saleDeadline());

        member.refund();

        assertEq(member.payments(), 1, "paid once");
        assertEq(address(member).balance, PRICE, "exactly its price");
        assertEq(member.succeeded(), 0, "nothing it tried went through");
        assertEq(member.mintError(), CallZRoom.SaleClosed.selector);
        assertEq(member.refundError(), CallZRoom.NotMember.selector);
        assertEq(member.withdrawError(), CallZRoom.NothingOwed.selector);
        assertEq(member.claimError(), CallZRoom.NotLaunched.selector);
        assertEq(member.launchError(), CallZRoom.NotCreator.selector);
        assertEq(member.kickError(), CallZRoom.NotCreator.selector);
        assertEq(room.raised(), PRICE);
        assertEq(room.seated(), 1);
        assertEq(address(room).balance, PRICE, "alice's BNB is untouched");
        vm.prank(alice);
        room.refund();
        assertEq(address(room).balance, 0);

        // A creator that is also a member, in a room that is full at the deadline: it hands its pass back and,
        // while it is paid, tries to launch with the money it is getting back, then removes alice.
        RoomReenterer both = new RoomReenterer();
        CallZRoomConfig memory c = _config();
        c.seats = 3;
        CallZRoom own = both.create(factory, c, bytes32(uint256(1)));
        address[] memory three = new address[](3);
        three[0] = address(both);
        three[1] = alice;
        three[2] = bob;
        both.admit(three);
        both.mint{value: PRICE}();
        vm.prank(alice);
        own.mint{value: PRICE}();
        vm.prank(bob);
        own.mint{value: PRICE}();
        both.arm(_allAttempts(both), alice);
        vm.warp(own.saleDeadline());
        uint256 aliceBefore = alice.balance;

        both.refund();

        assertEq(both.payments(), 1, "paid once");
        assertEq(address(both).balance, PRICE, "exactly its price");
        assertEq(both.mintError(), CallZRoom.SaleClosed.selector);
        assertEq(both.refundError(), CallZRoom.NotMember.selector);
        assertEq(both.withdrawError(), CallZRoom.NothingOwed.selector);
        assertEq(both.claimError(), CallZRoom.NotLaunched.selector);
        assertEq(both.launchError(), CallZRoom.RoomNotFull.selector, "its seat was free before it was paid");
        // The kick is the creator's right at any time before a launch, and it pays alice, not the creator.
        assertEq(both.succeeded(), both.TRY_KICK());
        assertEq(alice.balance, aliceBefore + PRICE);
        assertFalse(own.launched());
        assertEq(own.seated(), 1);
        assertEq(own.raised(), PRICE);
        assertEq(address(own).balance, PRICE, "bob's BNB is untouched");
        vm.prank(bob);
        own.refund();
        assertEq(address(own).balance, 0);
    }

    function test_29_reentryDuringAWithdrawGainsNothing() public {
        // A wallet that was removed while it refused BNB, and calls back when it collects.
        CallZRoom room = _createWithSeats(3);
        RoomReenterer member = new RoomReenterer();
        member.join(room);
        _admit(room, address(member));
        member.mint{value: PRICE}();
        _seat(room, alice);
        member.setReject(true);
        vm.prank(creator);
        room.kick(address(member));
        assertEq(room.owed(address(member)), PRICE);
        assertEq(member.payments(), 0);
        member.setReject(false);
        member.arm(_allAttempts(member), alice);

        member.withdraw();

        assertEq(member.payments(), 1, "paid once");
        assertEq(address(member).balance, PRICE, "exactly its price");
        assertEq(member.succeeded(), 0, "nothing it tried went through");
        assertEq(member.mintError(), CallZRoom.Banned.selector);
        assertEq(member.refundError(), CallZRoom.RefundUnavailable.selector);
        assertEq(member.withdrawError(), CallZRoom.NothingOwed.selector, "what was owed is cleared before it is paid");
        assertEq(member.claimError(), CallZRoom.NotLaunched.selector);
        assertEq(member.launchError(), CallZRoom.NotCreator.selector);
        assertEq(member.kickError(), CallZRoom.NotCreator.selector);
        assertEq(room.owed(address(member)), 0);
        assertEq(room.raised(), PRICE);
        assertEq(address(room).balance, PRICE, "alice's BNB is untouched");

        // A creator that is owed its own price launches the room from inside the payment. The launch is its
        // right, since the room is full, and it takes exactly the raise: the payment is not part of it.
        RoomReenterer both = new RoomReenterer();
        CallZRoomConfig memory c = _config();
        c.seats = 3;
        CallZRoom own = both.create(factory, c, bytes32(uint256(1)));
        address[] memory four = new address[](4);
        four[0] = address(both);
        four[1] = alice;
        four[2] = bob;
        four[3] = carol;
        both.admit(four);
        both.mint{value: PRICE}();
        vm.prank(alice);
        own.mint{value: PRICE}();
        vm.prank(bob);
        own.mint{value: PRICE}();
        both.setReject(true);
        both.kick(address(both));
        both.setReject(false);
        assertEq(own.owed(address(both)), PRICE);
        vm.prank(carol);
        own.mint{value: PRICE}();
        assertEq(own.seated(), 3);
        assertEq(address(own).balance, 4 * PRICE, "the raise and what the room owes");
        both.arm(_allAttempts(both), alice);
        uint256 feeBefore = _feeHolders();

        both.withdraw();

        assertEq(both.payments(), 1, "paid once");
        assertEq(address(both).balance, PRICE, "exactly its price");
        assertEq(both.succeeded(), both.TRY_LAUNCH(), "only the launch went through");
        assertEq(both.mintError(), CallZRoom.Banned.selector);
        assertEq(both.refundError(), CallZRoom.RefundUnavailable.selector);
        assertEq(both.withdrawError(), CallZRoom.NothingOwed.selector);
        assertEq(both.claimError(), CallZRoom.NotLaunched.selector);
        assertEq(both.kickError(), CallZRoom.AlreadyLaunched.selector);
        _assertLaunchState(own, 0, 0, 0);
        assertEq(_feeHolders() - feeBefore, 3 * PRICE / 10, "the fee of the raise alone");
        assertEq(IERC20(own.token()).balanceOf(address(both)), 0);
    }

    /// @dev The lock that covers the launch itself. A stand-in for the PancakeSwap factory, which is also the
    ///      room's creator, one of its members and owed BNB by it, calls back into the room from inside the
    ///      launch, after the deadline. Every action is refused except collecting what it was already owed, and
    ///      the launch completes untouched.
    function test_30_nothingCanReenterDuringTheLaunch() public {
        RoomHostilePancakeFactory hostile = new RoomHostilePancakeFactory(PANCAKE_FACTORY);
        CallZRoomFactory hostileFactory =
            new CallZRoomFactory(address(hostile), WBNB, address(vault), guardian, FEE_BPS);
        CallZRoomConfig memory c = _config();
        c.seats = 3;
        CallZRoom room = hostile.open(hostileFactory, c);
        vm.deal(address(hostile), 1 ether);
        assertEq(room.creator(), address(hostile));

        address[] memory three = new address[](3);
        three[0] = address(hostile);
        three[1] = alice;
        three[2] = bob;
        hostile.admit(three);
        // It buys a pass, removes itself while it refuses BNB, and comes back: a member that is also owed a price.
        hostile.mint{value: PRICE}();
        hostile.setReject(true);
        hostile.kick(address(hostile));
        hostile.setReject(false);
        hostile.setBanned(address(hostile), false);
        hostile.admit(_one(address(hostile)));
        hostile.mint{value: PRICE}();
        vm.prank(alice);
        room.mint{value: PRICE}();
        vm.prank(bob);
        room.mint{value: PRICE}();
        assertEq(room.seated(), 3);
        assertEq(room.owed(address(hostile)), PRICE);
        assertEq(address(room).balance, 4 * PRICE);
        assertEq(address(hostile).balance, 1 ether, "its two passes were paid for by this test");
        hostile.aim(alice, carol);
        // Past the deadline, so that only the launch lock stands between a member and a refund.
        vm.warp(room.saleDeadline() + 1);
        assertTrue(room.refundAvailable());

        hostile.launch();

        assertTrue(hostile.entered(), "the stand-in factory was called during the launch");
        assertEq(hostile.mintError(), CallZRoom.LaunchInProgress.selector);
        assertEq(hostile.refundError(), CallZRoom.RefundUnavailable.selector);
        assertEq(hostile.claimError(), CallZRoom.NotLaunched.selector);
        assertEq(hostile.admitError(), CallZRoom.SaleClosed.selector);
        assertEq(hostile.banError(), CallZRoom.AlreadyLaunched.selector);
        assertEq(hostile.kickError(), CallZRoom.LaunchInProgress.selector);
        assertEq(hostile.launchError(), CallZRoom.LaunchInProgress.selector);
        // What it was owed before the launch is its own, and was not part of the raise.
        assertTrue(hostile.withdrawSucceeded());
        assertEq(hostile.payments(), 1);
        assertEq(address(hostile).balance, 1 ether + PRICE, "it collected the one price it was owed, nothing else");
        assertEq(room.owed(address(hostile)), 0);
        assertEq(room.seatOf(alice), 3);
        assertFalse(room.banned(carol));
        _assertLaunchState(room, 0, 0, 0);

        hostile.claim();
        assertEq(IERC20(room.token()).balanceOf(address(hostile)), room.tokensPerSeat());
    }

    /// @dev If the launch cannot complete, the call reverts as a whole: the room is as it was, it can be launched
    ///      later, and its members can still take their price back after the deadline.
    function test_31_aLaunchThatCannotCompleteLeavesTheRoomAsItWas() public {
        CallZRoom room = _createWithSeats(3);
        _seat(room, alice);
        _seat(room, bob);
        _seat(room, carol);
        uint256 feeBefore = _feeHolders();

        vm.mockCallRevert(
            PANCAKE_FACTORY,
            abi.encodeWithSelector(IRoomPancakeFactory.createPair.selector),
            bytes("pair creation is down")
        );
        vm.prank(creator);
        vm.expectRevert(bytes("pair creation is down"));
        room.launch();

        assertFalse(room.launched());
        assertEq(room.token(), address(0));
        assertEq(room.raised(), 3 * PRICE);
        assertEq(room.seated(), 3);
        assertEq(address(room).balance, 3 * PRICE);
        assertEq(_feeHolders(), feeBefore, "no fee was paid");
        assertEq(_predictToken(room).code.length, 0, "the token deployment was rolled back with the rest");

        // The room is not stuck half-launched: its members can still be removed and replaced.
        vm.prank(creator);
        room.kick(carol);
        assertEq(carol.balance, START);
        _seat(room, dave);

        // After the deadline everybody can still take their price back, also while pair creation stays down.
        vm.warp(room.saleDeadline());
        vm.prank(alice);
        room.refund();
        assertEq(alice.balance, START);

        // A room that failed to launch launches once pair creation works again.
        CallZRoom second = _createWithSeats(2);
        _seat(second, bob);
        _seat(second, carol);
        vm.prank(creator);
        vm.expectRevert(bytes("pair creation is down"));
        second.launch();
        vm.clearMockedCalls();
        _launch(second);
        _assertLaunchState(second, 0, 0, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 11. Metadata
    // ─────────────────────────────────────────────────────────────────────────

    function test_32_passMetadataShowsTheRoomsPictureThePriceAndTheStatus() public {
        CallZRoomConfig memory c = _config();
        c.seatPrice = 0.25 ether;
        c.seats = 3;
        CallZRoom room = _create(c);
        _seat(room, alice);
        _seat(room, bob);

        string memory json = _json(room, 1);
        assertEq(vm.parseJsonString(json, ".name"), "Call Room CallZ Pass #1");
        assertEq(vm.parseJsonString(json, ".image"), c.image, "the room's picture, exactly as given");
        assertEq(vm.parseJsonString(json, ".image"), room.image());
        assertEq(vm.parseJsonString(json, ".attributes[0].trait_type"), "Status");
        assertEq(vm.parseJsonString(json, ".attributes[0].value"), "Seated");
        assertEq(vm.parseJsonString(json, ".attributes[1].trait_type"), "Price");
        assertEq(vm.parseJsonString(json, ".attributes[1].value"), "0.25 BNB");
        assertEq(vm.parseJsonString(json, ".attributes[1].value"), room.priceText());
        assertEq(vm.parseJsonString(json, ".attributes[2].trait_type"), "Seats");
        assertEq(vm.parseJsonUint(json, ".attributes[2].value"), 3);
        string memory description = vm.parseJsonString(json, ".description");
        assertTrue(LibString.contains(description, "Call Room"), "the description names the room");
        assertTrue(LibString.contains(description, "bought for 0.25 BNB"), "the description says what it cost");
        assertEq(vm.parseJsonString(_json(room, 2), ".name"), "Call Room CallZ Pass #2");

        // A pass that was never issued, and one that was burned, have no metadata.
        vm.expectRevert(ERC721.TokenDoesNotExist.selector);
        room.tokenURI(0);
        vm.expectRevert(ERC721.TokenDoesNotExist.selector);
        room.tokenURI(3);
        vm.prank(creator);
        room.kick(bob);
        vm.expectRevert(ERC721.TokenDoesNotExist.selector);
        room.tokenURI(2);

        // Seated, then Unclaimed once the room has launched, then Claimed.
        _seat(room, carol);
        _seat(room, dave);
        assertEq(_status(room, 1), "Seated");
        _launch(room);
        assertEq(_status(room, 1), "Unclaimed");
        assertEq(_status(room, 3), "Unclaimed");
        vm.prank(alice);
        room.claim();
        assertEq(_status(room, 1), "Claimed");
        assertEq(_status(room, 3), "Unclaimed", "each pass shows its own status");
        assertEq(_status(room, 4), "Unclaimed");
        // The picture and the price do not change.
        json = _json(room, 1);
        assertEq(vm.parseJsonString(json, ".image"), c.image);
        assertEq(vm.parseJsonString(json, ".attributes[1].value"), "0.25 BNB");
        vm.expectRevert(ERC721.TokenDoesNotExist.selector);
        room.tokenURI(2);
    }

    function test_33_aRoomWithoutAPictureDrawsThePassWithItsNumberAndPrice() public {
        CallZRoomConfig memory c = _config();
        c.image = "";
        c.seatPrice = 0.107 ether;
        c.seats = 3;
        CallZRoom room = _create(c);
        _seat(room, alice);
        _seat(room, bob);
        assertEq(room.priceText(), "0.107 BNB");

        string memory json = _json(room, 2);
        assertEq(vm.parseJsonString(json, ".name"), "Call Room CallZ Pass #2");
        assertEq(vm.parseJsonString(json, ".attributes[1].value"), "0.107 BNB");
        string memory svg = _svg(json);
        assertTrue(LibString.startsWith(svg, "<svg xmlns=\"http://www.w3.org/2000/svg\""), "an SVG document");
        assertTrue(LibString.endsWith(svg, "</svg>"));
        assertTrue(LibString.contains(svg, "0.107 BNB"), "the drawing shows the price");
        assertTrue(LibString.contains(svg, "ROOM CallZ Pass #2"), "the drawing shows the pass number");
        assertFalse(LibString.contains(svg, "Pass #1"));

        string memory first = _svg(_json(room, 1));
        assertTrue(LibString.contains(first, "ROOM CallZ Pass #1"));
        assertTrue(LibString.contains(first, "0.107 BNB"));
    }

    function test_34_hostileNamesComeOutAsValidJsonAndEscapedInTheDrawing() public {
        CallZRoomConfig memory c = _config();
        c.name = "Say \"hi\" \\ <script>alert('x')</script>\n\ttab\x01 & more";
        c.symbol = "<script>\"S\"&'\\</script>";
        c.image = "https://example.org/a\"b\\c<script>alert(1)</script>\n.png";
        c.seats = 2;
        CallZRoom room = _create(c);
        _seat(room, alice);

        // The metadata parses, and gives every string back exactly as it was given.
        string memory json = _json(room, 1);
        vm.parseJson(json);
        assertEq(vm.parseJsonString(json, ".name"), string.concat(c.name, " CallZ Pass #1"));
        assertEq(vm.parseJsonString(json, ".image"), c.image, "the picture address, exactly as given");
        assertTrue(LibString.contains(vm.parseJsonString(json, ".description"), c.name));
        assertEq(vm.parseJsonString(json, ".attributes[0].value"), "Seated");
        assertEq(vm.parseJsonString(json, ".attributes[1].value"), "0.01 BNB");
        assertEq(vm.parseJsonUint(json, ".attributes[2].value"), 2);
        assertEq(room.name(), string.concat(c.name, " CallZ Pass"));
        assertEq(room.symbol(), string.concat(c.symbol, "-PASS"));

        // Without a picture the symbol is drawn into the SVG, with every character that means something to a
        // browser escaped.
        c.image = "";
        CallZRoom drawn = _create(c);
        _seat(drawn, alice);
        json = _json(drawn, 1);
        vm.parseJson(json);
        assertEq(vm.parseJsonString(json, ".name"), string.concat(c.name, " CallZ Pass #1"));
        string memory svg = _svg(json);
        assertFalse(LibString.contains(svg, "<script"), "no script element in the drawing");
        assertFalse(LibString.contains(svg, "</script"));
        assertTrue(
            LibString.contains(svg, "&lt;script&gt;&quot;S&quot;&amp;&#39;\\&lt;/script&gt; CallZ Pass #1"),
            "the symbol, escaped"
        );
        assertTrue(LibString.endsWith(svg, "0.01 BNB</text></svg>"));

        // The launched token carries the name and symbol as given.
        _seat(drawn, bob);
        _launch(drawn);
        assertEq(IERC20Metadata(drawn.token()).name(), c.name);
        assertEq(IERC20Metadata(drawn.token()).symbol(), c.symbol);
        vm.parseJson(_json(drawn, 1));
    }

    function test_35_priceTextReadsLikeAPrice() public {
        CallZRoomArt art = CallZRoomArt(factory.art());
        assertEq(art.priceText(1), "0.000000000000000001 BNB");
        assertEq(art.priceText(0.107 ether), "0.107 BNB");
        assertEq(art.priceText(0.25 ether), "0.25 BNB");
        assertEq(art.priceText(1 ether), "1 BNB");
        assertEq(art.priceText(10 ether), "10 BNB");
        assertEq(art.priceText(0), "0 BNB");
        assertEq(art.priceText(0.1 ether), "0.1 BNB");
        assertEq(art.priceText(1.5 ether), "1.5 BNB");
        assertEq(art.priceText(0.01 ether), "0.01 BNB");
        assertEq(art.priceText(10 ether + 1), "10.000000000000000001 BNB");
        assertEq(art.priceText(9.999999999999999999 ether), "9.999999999999999999 BNB");
        assertEq(art.priceText(0.000001 ether), "0.000001 BNB");
        assertEq(art.priceText(123 ether + 0.45 ether), "123.45 BNB");
        assertEq(
            art.priceText(type(uint256).max),
            "115792089237316195423570985008687907853269984665640564039457.584007913129639935 BNB"
        );

        // A room reads its own price through the same function.
        CallZRoomConfig memory c = _config();
        c.seatPrice = 1;
        c.seats = 1;
        assertEq(_create(c).priceText(), "0.000000000000000001 BNB");
        c.seatPrice = 10 ether;
        assertEq(_create(c).priceText(), "10 BNB");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 12. The factory's fee and guardian
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Fill and launch `room`, and return what reached the vault and the team wallet together.
    function _launchFee(CallZRoom room) internal returns (uint256 paid, uint256 feeLogs) {
        walletCounter = 0;
        _fill(room);
        uint256 before = _feeHolders();
        vm.recordLogs();
        _launch(room);
        (, feeLogs) = _findLog(vm.getRecordedLogs(), address(room), CallZRoom.LaunchFeePaid.selector);
        paid = _feeHolders() - before;
        _assertLaunchState(room, 0, 0, 0);
    }

    function test_36_theGuardianSetsTheFeeOfRoomsCreatedAfterwards() public {
        CallZRoom first = _createWithSeats(2);
        assertEq(first.launchFeeBps(), 1000);

        // Only the guardian, and never above 10%.
        vm.prank(attacker);
        vm.expectRevert(CallZRoomFactory.NotGuardian.selector);
        factory.setLaunchFee(0);
        vm.prank(creator);
        vm.expectRevert(CallZRoomFactory.NotGuardian.selector);
        factory.setLaunchFee(0);
        vm.prank(guardian);
        vm.expectRevert(CallZRoomFactory.FeeTooHigh.selector);
        factory.setLaunchFee(1001);
        vm.prank(guardian);
        vm.expectRevert(CallZRoomFactory.FeeTooHigh.selector);
        factory.setLaunchFee(type(uint16).max);
        assertEq(factory.launchFeeBps(), 1000);

        vm.expectEmit(false, false, false, true, address(factory));
        emit CallZRoomFactory.LaunchFeeSet(250);
        vm.prank(guardian);
        factory.setLaunchFee(250);
        assertEq(factory.launchFeeBps(), 250);
        CallZRoom second = _createWithSeats(2);
        assertEq(second.launchFeeBps(), 250, "a room created after the change has the new fee");
        assertEq(first.launchFeeBps(), 1000, "an existing room keeps the fee it was created with");

        vm.prank(guardian);
        factory.setLaunchFee(0);
        CallZRoom third = _createWithSeats(2);
        assertEq(third.launchFeeBps(), 0);
        vm.prank(guardian);
        factory.setLaunchFee(1000);
        assertEq(first.launchFeeBps(), 1000);
        assertEq(second.launchFeeBps(), 250);
        assertEq(third.launchFeeBps(), 0);
        assertEq(_createWithSeats(2).launchFeeBps(), 1000, "the highest fee the guardian can set");

        // Each room pays the fee it was created with.
        uint256 raise = 2 * PRICE;
        (uint256 paid, uint256 feeLogs) = _launchFee(first);
        assertEq(paid, raise / 10);
        assertEq(feeLogs, 1);
        (paid, feeLogs) = _launchFee(second);
        assertEq(paid, raise * 250 / 10_000);
        assertEq(feeLogs, 1);
        (paid, feeLogs) = _launchFee(third);
        assertEq(paid, 0, "no fee: the whole raise is in the pool");
        assertEq(feeLogs, 0, "and no LaunchFeePaid");
        (, uint256 wbnbReserve) = _reserves(third.pair(), third.token());
        assertEq(wbnbReserve, raise);
    }

    function test_37_theGuardianRoleIsHandedOverInTwoSteps() public {
        vm.prank(attacker);
        vm.expectRevert(CallZRoomFactory.NotGuardian.selector);
        factory.transferGuardian(attacker);

        vm.expectEmit(true, false, false, true, address(factory));
        emit CallZRoomFactory.GuardianTransferStarted(alice);
        vm.prank(guardian);
        factory.transferGuardian(alice);
        assertEq(factory.pendingGuardian(), alice);
        assertEq(factory.guardian(), guardian, "nothing changes until the new guardian accepts");
        vm.prank(alice);
        vm.expectRevert(CallZRoomFactory.NotGuardian.selector);
        factory.setLaunchFee(0);
        vm.prank(bob);
        vm.expectRevert(CallZRoomFactory.NotGuardian.selector);
        factory.acceptGuardian();
        vm.prank(guardian);
        vm.expectRevert(CallZRoomFactory.NotGuardian.selector);
        factory.acceptGuardian();

        // The guardian can change its mind before the hand-over is accepted.
        vm.prank(guardian);
        factory.transferGuardian(bob);
        vm.prank(alice);
        vm.expectRevert(CallZRoomFactory.NotGuardian.selector);
        factory.acceptGuardian();

        vm.expectEmit(true, false, false, true, address(factory));
        emit CallZRoomFactory.GuardianChanged(bob);
        vm.prank(bob);
        factory.acceptGuardian();
        assertEq(factory.guardian(), bob);
        assertEq(factory.pendingGuardian(), address(0));

        vm.prank(guardian);
        vm.expectRevert(CallZRoomFactory.NotGuardian.selector);
        factory.setLaunchFee(0);
        vm.prank(guardian);
        vm.expectRevert(CallZRoomFactory.NotGuardian.selector);
        factory.transferGuardian(guardian);
        vm.prank(bob);
        factory.setLaunchFee(500);
        assertEq(factory.launchFeeBps(), 500);

        // The guardian has no say in a room.
        CallZRoom room = _createWithSeats(2);
        vm.startPrank(bob);
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.admit(_one(bob));
        vm.expectRevert(CallZRoom.NotCreator.selector);
        room.launch();
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // More
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev One seat for one wei, bought by the creator. A creator holds a pass like anyone else.
    function test_38_theSmallestRoomLaunchesAndItsCreatorCanBeAMember() public {
        CallZRoomConfig memory c = _config();
        c.seatPrice = 1;
        c.seats = 1;
        CallZRoom room = _create(c);
        assertEq(room.tokensPerSeat(), TOTAL_SUPPLY / 2);

        uint256 feeBefore = _feeHolders();
        vm.startPrank(creator);
        room.admit(_one(creator));
        room.mint{value: 1}();
        vm.recordLogs();
        room.launch();
        vm.stopPrank();
        (, uint256 feeLogs) = _findLog(vm.getRecordedLogs(), address(room), CallZRoom.LaunchFeePaid.selector);
        assertEq(feeLogs, 0, "a tenth of one wei rounds to nothing");
        assertEq(_feeHolders(), feeBefore);
        assertEq(creator.balance, START - 1);
        assertEq(room.ownerOf(1), creator);

        // `_assertLaunchState` expects a creator without tokens, so the checks are made here.
        address token = room.token();
        address pair = room.pair();
        (uint256 tokenReserve, uint256 wbnbReserve) = _reserves(pair, token);
        assertEq(tokenReserve, TOTAL_SUPPLY / 2);
        assertEq(wbnbReserve, 1, "one wei of WBNB in the pool");
        IRoomPairLike lp = IRoomPairLike(pair);
        assertEq(lp.totalSupply(), FixedPointMathLib.sqrt(TOTAL_SUPPLY / 2));
        assertEq(lp.balanceOf(DEAD), lp.totalSupply() - MINIMUM_LIQUIDITY);
        assertEq(lp.balanceOf(creator), 0);
        assertEq(address(room).balance, 0);

        vm.prank(creator);
        room.claim();
        assertEq(IERC20(token).balanceOf(creator), TOTAL_SUPPLY / 2, "one pass, one share");
        assertEq(IERC20(token).balanceOf(address(room)), 0);

        // The largest raise: one seat for 10 BNB.
        c.seatPrice = 10 ether;
        CallZRoom large = _create(c);
        _seat(large, alice);
        feeBefore = _feeHolders();
        _launch(large);
        _assertLaunchState(large, 0, 0, 0);
        assertEq(_feeHolders() - feeBefore, 1 ether);
    }

    /// @dev BNB can be pushed into any contract (a self-destruct, a block reward). The launch takes exactly the
    ///      raise all the same, and nobody is paid the surplus.
    function test_39_bnbForcedIntoTheRoomDoesNotDisturbTheLaunch() public {
        CallZRoom room = _createWithSeats(3);
        _seat(room, alice);
        _seat(room, bob);
        _seat(room, carol);
        vm.deal(address(room), 3 * PRICE + 1 ether);
        assertEq(room.raised(), 3 * PRICE);

        uint256 creatorBefore = creator.balance;
        uint256 feeBefore = _feeHolders();
        _launch(room);
        _assertLaunchState(room, 0, 0, 1 ether);
        assertEq(_feeHolders() - feeBefore, 3 * PRICE / 10, "the fee is on the raise, not on the surplus");
        assertEq(creator.balance, creatorBefore);
        vm.prank(creator);
        vm.expectRevert(CallZRoom.NothingOwed.selector);
        room.withdraw();

        // Before a deadline refund it changes nothing either: each member gets one price.
        CallZRoom missed = _createWithSeats(3);
        _seat(missed, alice);
        vm.deal(address(missed), PRICE + 1 ether);
        vm.warp(missed.saleDeadline());
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        missed.refund();
        assertEq(alice.balance, aliceBefore + PRICE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.NotMember.selector, alice));
        missed.refund();
    }

    function test_40_directPaymentsAndPaidTransfersAreRefused() public {
        CallZRoom room = _createWithSeats(3);
        _seat(room, alice);

        // BNB cannot be sent to the room directly, with or without data.
        vm.prank(alice);
        (bool ok,) = address(room).call{value: 1 ether}("");
        assertFalse(ok, "direct payments are rejected");
        vm.prank(alice);
        (ok,) = address(room).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok, "payments to unknown functions are rejected");
        // Nor with the calls the creator and the members make.
        vm.prank(creator);
        (ok,) = address(room).call{value: 1 ether}(abi.encodeCall(CallZRoom.admit, (_one(bob))));
        assertFalse(ok, "admit takes no BNB");
        vm.prank(creator);
        (ok,) = address(room).call{value: 1 ether}(abi.encodeCall(CallZRoom.kick, (alice)));
        assertFalse(ok, "kick takes no BNB");
        vm.prank(creator);
        (ok,) = address(room).call{value: 1 ether}(abi.encodeCall(CallZRoom.launch, ()));
        assertFalse(ok, "launch takes no BNB");
        // A transfer of the pass is refused, so BNB sent with it comes back.
        vm.prank(alice);
        (ok,) = address(room).call{value: 1 ether}(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, bob, 1)
        );
        assertFalse(ok);
        vm.prank(alice);
        (ok,) = address(room).call{value: 1 ether}(
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", alice, bob, 1)
        );
        assertFalse(ok);
        assertEq(address(room).balance, PRICE);
        assertEq(alice.balance, START - PRICE);
    }

    /// @dev The ERC-721 interface lets BNB be sent along with `approve`. Nothing in the room could ever pay such
    ///      BNB out again, so the room refuses every approval: a pass cannot change hands anyway.
    function test_41_approveDoesNotSwallowBnb() public {
        CallZRoom room = _createWithSeats(3);
        _seat(room, alice);
        assertEq(address(room).balance, room.raised());

        vm.prank(alice);
        (bool ok,) = address(room).call{value: 1 ether}(abi.encodeWithSignature("approve(address,uint256)", bob, 1));

        assertEq(address(room).balance, room.raised(), "the room holds nothing but the raise");
        assertEq(alice.balance, START - PRICE, "alice has lost nothing but the price of her pass");
        assertFalse(ok, "an approval that carries BNB is refused");
    }

    /// @dev A wallet that is owed an earlier price, and collects it from inside the repayment of a later kick,
    ///      ends up with each of its two prices once, paid or still owed, whatever the repayment's gas allows.
    function test_42_anEarlierPriceCollectedFromInsideALaterRepaymentIsPaidOnce() public {
        CallZRoom room = _createWithSeats(3);
        RoomReenterer member = new RoomReenterer();
        member.join(room);
        _admit(room, address(member));
        member.mint{value: PRICE}();
        _seat(room, alice);
        member.setReject(true);
        vm.prank(creator);
        room.kick(address(member));
        member.setReject(false);
        vm.prank(creator);
        room.setBanned(address(member), false);
        _admit(room, address(member));
        member.mint{value: PRICE}();
        assertEq(room.owed(address(member)), PRICE);
        assertEq(address(member).balance, 0);
        assertEq(address(room).balance, 3 * PRICE, "alice's price, the member's price, and the price it is owed");
        member.arm(member.TRY_WITHDRAW(), address(0));

        vm.prank(creator);
        room.kick(address(member));

        uint256 stillOwed = room.owed(address(member));
        assertEq(address(member).balance + stillOwed, 2 * PRICE, "both prices, each once, paid or owed");
        assertEq(room.seatOf(address(member)), 0);
        assertEq(room.raised(), PRICE);
        assertEq(address(room).balance, PRICE + stillOwed, "alice's BNB is untouched");
        emit log_named_uint("BNB the member was paid inside the kick (wei)", address(member).balance);
        emit log_named_uint("payments it received", member.payments());

        // Whatever is still owed can be collected, and then nothing more.
        member.arm(0, address(0));
        if (stillOwed != 0) member.withdraw();
        assertEq(address(member).balance, 2 * PRICE);
        assertEq(address(room).balance, PRICE);
        vm.expectRevert(CallZRoom.NothingOwed.selector);
        member.withdraw();
    }

    /// @dev The 10 BNB cap spread over 100 seats, every one of them a contract wallet, all let in by one call.
    ///      The launch costs what it costs for three seats: nothing a room does grows with its number of seats.
    function test_43_aRoomOfAHundredSeatsAtTheCapLaunchesAndEveryPassClaims() public {
        CallZRoomConfig memory c = _config();
        c.seatPrice = 0.1 ether;
        c.seats = 100;
        CallZRoom room = _create(c);
        assertEq(room.cap(), 10 ether);

        address implementation = address(new RoomWallet());
        address[] memory wallets = new address[](100);
        for (uint256 i; i < wallets.length; ++i) {
            wallets[i] = LibClone.clone(implementation);
        }
        vm.prank(creator);
        room.admit(wallets);
        for (uint256 i; i < wallets.length; ++i) {
            RoomWallet(payable(wallets[i])).mint{value: 0.1 ether}(room);
        }
        assertEq(room.seated(), 100);
        assertEq(room.raised(), 10 ether);
        assertEq(address(room).balance, 10 ether);

        // One wallet in the middle of the list is removed and replaced.
        vm.prank(creator);
        room.kick(wallets[41]);
        assertEq(wallets[41].balance, 0.1 ether);
        assertEq(room.seated(), 99);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CallZRoom.RoomNotFull.selector, 99, 100));
        room.launch();
        assertEq(_seat(room, alice), 101);
        _assertMembers(room, _replace(wallets, 41, alice));

        uint256 feeBefore = _feeHolders();
        vm.prank(creator);
        room.launch();
        uint256 used = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("launch of a room of 100 seats, gas", used);
        assertLt(used, TX_GAS_CAP / 2, "the launch leaves half of the gas cap spare");
        _assertLaunchState(room, 0, 0, 0);
        assertEq(_feeHolders() - feeBefore, 1 ether, "a tenth of the 10 BNB raise");

        IERC20 token = IERC20(room.token());
        uint256 share = room.tokensPerSeat();
        wallets = _replace(wallets, 41, alice);
        for (uint256 i; i < wallets.length; ++i) {
            if (wallets[i] == alice) {
                vm.prank(alice);
                room.claim();
            } else {
                RoomWallet(payable(wallets[i])).claim(room);
            }
            assertEq(token.balanceOf(wallets[i]), share);
        }
        assertEq(token.balanceOf(address(room)), 0, "every share has been claimed");
        assertEq(token.balanceOf(room.pair()) + 100 * share, TOTAL_SUPPLY, "pool + every claim is the supply");
    }

    function _replace(address[] memory wallets, uint256 index, address wallet)
        internal
        pure
        returns (address[] memory out)
    {
        out = new address[](wallets.length);
        for (uint256 i; i < wallets.length; ++i) {
            out[i] = i == index ? wallet : wallets[i];
        }
    }

    /// @dev BNB Chain rejects any transaction above 16,777,216 gas. Run with `forge test --isolate` so that each
    ///      figure is a whole transaction. Nothing a room does grows with its number of seats.
    function test_44_gasOfEveryAction() public {
        CallZRoomConfig memory c = _config();
        c.name = _repeat("N", 64);
        c.symbol = _repeat("S", 32);
        c.image = _repeat("i", 200);
        c.seats = 3;
        vm.prank(creator);
        CallZRoom room = CallZRoom(factory.create(c, bytes32(++saltCounter)));
        emit log_named_uint("create a room (longest name, symbol and picture), gas", vm.lastCallGas().gasTotalUsed);

        vm.prank(creator);
        room.admit(_one(alice));
        emit log_named_uint("admit 1 wallet, gas", vm.lastCallGas().gasTotalUsed);
        address[] memory hundred = new address[](100);
        for (uint256 i; i < hundred.length; ++i) {
            hundred[i] = address(uint160(0xC0DE5000 + i));
        }
        vm.prank(creator);
        room.admit(hundred);
        uint256 used = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("admit 100 wallets, gas", used);
        assertLt(used, TX_GAS_CAP / 4, "letting 100 wallets in fits the gas cap four times over");
        address[] memory three = new address[](3);
        three[0] = bob;
        three[1] = carol;
        three[2] = dave;
        vm.prank(creator);
        room.admit(three);
        emit log_named_uint("admit 3 wallets, gas", vm.lastCallGas().gasTotalUsed);

        vm.prank(alice);
        room.mint{value: PRICE}();
        emit log_named_uint("mint, the room's first pass, gas", vm.lastCallGas().gasTotalUsed);
        vm.prank(bob);
        room.mint{value: PRICE}();
        emit log_named_uint("mint, a later pass, gas", vm.lastCallGas().gasTotalUsed);
        vm.prank(carol);
        room.mint{value: PRICE}();

        vm.prank(creator);
        room.kick(carol);
        emit log_named_uint("kick, the wallet is repaid, gas", vm.lastCallGas().gasTotalUsed);
        vm.prank(creator);
        room.setBanned(erin, true);
        emit log_named_uint("setBanned, gas", vm.lastCallGas().gasTotalUsed);
        vm.prank(dave);
        room.mint{value: PRICE}();

        vm.prank(creator);
        room.launch();
        used = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("launch: token + pair + fee + liquidity, gas", used);
        emit log_named_uint("launch, share of the gas cap used, bps", used * 10_000 / TX_GAS_CAP);
        assertLt(used, TX_GAS_CAP / 2, "the launch leaves half of the gas cap spare");
        _assertLaunchState(room, 0, 0, 0);

        vm.prank(alice);
        room.claim();
        emit log_named_uint("claim, gas", vm.lastCallGas().gasTotalUsed);
        assertGt(bytes(room.tokenURI(1)).length, 0);

        CallZRoom missed = _create(c);
        RoomWallet wallet = new RoomWallet();
        vm.prank(creator);
        missed.admit(_one(address(wallet)));
        wallet.mint{value: PRICE}(missed);
        _seat(missed, alice);
        wallet.setMode(1);
        vm.prank(creator);
        missed.kick(address(wallet));
        emit log_named_uint("kick, the wallet refuses BNB, gas", vm.lastCallGas().gasTotalUsed);
        wallet.setMode(0);
        vm.prank(address(wallet));
        missed.withdraw();
        emit log_named_uint("withdraw, gas", vm.lastCallGas().gasTotalUsed);
        vm.warp(missed.saleDeadline());
        vm.prank(alice);
        missed.refund();
        emit log_named_uint("refund, gas", vm.lastCallGas().gasTotalUsed);
    }
}
