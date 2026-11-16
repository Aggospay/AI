// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ArcCollection, Params} from "../ArcCollection.sol";
import {ArcCommon, MockUSDC} from "./ArcCommon.t.sol";

contract ArcCollectionFuzzTest is ArcCommon {
    uint64 internal constant START = T0 + 100;
    uint64 internal constant END = T0 + 10 days;

    function testFuzz_MintPaymentGoesToPayee(uint256 priceTicks, uint32 maxSupply, uint32 perWallet, uint32 qty)
        public
    {
        uint256 price = bound(priceTicks, 0, 1e12) * 1000;
        maxSupply = uint32(bound(maxSupply, 1, 200));
        perWallet = uint32(bound(perWallet, 1, maxSupply));
        qty = uint32(bound(qty, 1, perWallet));
        ArcCollection c = createVia(makeParams(price, maxSupply, perWallet, START, END));
        fund(alice, price * qty, address(c));
        vm.warp(START);

        uint256 payeeBefore = usdc.balanceOf(creator);
        vm.prank(alice);
        c.mint(qty);

        assertEq(usdc.balanceOf(creator) - payeeBefore, price * qty);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(c.balanceOf(alice), qty);
        assertEq(c.totalMinted(), qty);
        assertEq(c.mintedBy(alice), qty);
    }

    function testFuzz_WalletLimitEnforced(uint32 perWallet, uint32 first, uint32 second) public {
        perWallet = uint32(bound(perWallet, 1, 50));
        first = uint32(bound(first, 1, perWallet));
        second = uint32(bound(second, 1, 100));
        ArcCollection c = createVia(makeParams(0, 1000, perWallet, START, END));
        vm.warp(START);
        vm.startPrank(alice);
        c.mint(first);
        if (uint256(first) + second > perWallet) {
            vm.expectRevert(ArcCollection.WalletLimitExceeded.selector);
            c.mint(second);
            assertEq(c.mintedBy(alice), first);
        } else {
            c.mint(second);
            assertEq(c.mintedBy(alice), uint256(first) + second);
        }
        vm.stopPrank();
    }

    function testFuzz_MintWindowBoundaries(uint64 start, uint64 span, uint64 when) public {
        start = uint64(bound(start, T0, T0 + 365 days));
        span = uint64(bound(span, 1, 90 days));
        uint64 end = start + span;
        when = uint64(bound(when, 0, uint256(end) + 30 days));
        ArcCollection c = createVia(makeParams(0, 5, 5, start, end));
        vm.warp(when);
        vm.prank(alice);
        if (when >= end) vm.expectRevert(ArcCollection.MintClosed.selector);
        else if (when < start) vm.expectRevert(ArcCollection.MintNotStarted.selector);
        c.mint(1);
    }

    function testFuzz_RevealGating(bytes32 secret, uint64 when, uint8 minted) public {
        minted = uint8(bound(minted, 0, 5));
        bytes32 commit = keccak256(abi.encode(secret));
        ArcCollection c = new ArcCollection(_withCommit(commit), address(usdc), creator);
        vm.warp(START);
        if (minted > 0) {
            vm.prank(alice);
            c.mint(minted);
        }
        when = uint64(bound(when, START, uint256(END) + 30 days));
        vm.warp(when);
        bool ready = minted == 5 || when >= END;
        if (!ready) vm.expectRevert(ArcCollection.RevealNotReady.selector);
        c.reveal(secret);
        assertEq(c.revealed(), ready);
    }

    function _withCommit(bytes32 commit) internal view returns (Params memory p) {
        p = makeParams(0, 5, 5, START, END);
        p.seedCommitment = commit;
    }
}

/// @dev Bounded actor surface for stateful testing of mint / reveal accounting.
contract CollectionHandler is Test {
    ArcCollection public c;
    MockUSDC public usdc;
    address[] public actors;
    address public payee;
    uint256 public ghostPaid;

    constructor(ArcCollection c_, MockUSDC usdc_, address payee_) {
        c = c_;
        usdc = usdc_;
        payee = payee_;
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            usdc_.mint(a, type(uint96).max);
            vm.prank(a);
            usdc_.approve(address(c_), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function mint(uint256 who, uint32 qty) external {
        address a = actors[who % actors.length];
        qty = uint32(bound(qty, 1, 4));
        uint256 before = c.totalMinted();
        vm.prank(a);
        try c.mint(qty) {
            ghostPaid += (c.totalMinted() - before) * c.mintPrice();
        } catch {}
    }

    function warp(uint256 dt) external {
        skip(bound(dt, 0, 3 days));
    }

    function reveal(bool useFallback) external {
        if (useFallback) {
            try c.revealFallback() {} catch {}
        } else {
            try c.reveal(keccak256("hidden-seed")) {} catch {}
        }
    }
}

contract ArcCollectionInvariantTest is ArcCommon {
    ArcCollection internal c;
    CollectionHandler internal handler;

    function setUp() public override {
        super.setUp();
        c = createVia(makeParams(2_000, 12, 5, T0 + 1, T0 + 12 days));
        handler = new CollectionHandler(c, usdc, creator);
        targetContract(address(handler));
    }

    function invariant_TotalMintedWithinSupplyAndEqualsWalletSum() public view {
        assertLe(c.totalMinted(), c.maxSupply());
        uint256 sum;
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            address a = handler.actors(i);
            assertLe(c.mintedBy(a), c.maxPerWallet());
            assertEq(c.balanceOf(a), c.mintedBy(a));
            sum += c.mintedBy(a);
        }
        assertEq(sum, c.totalMinted());
    }

    function invariant_PayeeReceivedExactlyMintRevenueAndCollectionHoldsNone() public view {
        assertEq(usdc.balanceOf(creator), c.totalMinted() * c.mintPrice());
        assertEq(usdc.balanceOf(creator), handler.ghostPaid());
        assertEq(usdc.balanceOf(address(c)), 0);
    }

    function invariant_NoMintsAfterReveal() public view {
        // once revealed, totalMinted can never grow; the handler can't observe growth, so
        // assert the structural consequence: revealed implies sellout or time past mintEnd
        if (c.revealed()) {
            assertTrue(c.totalMinted() == c.maxSupply() || block.timestamp >= c.mintEnd());
        }
    }
}
