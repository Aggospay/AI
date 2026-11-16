// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ArcCollection, Params} from "../ArcCollection.sol";
import {ArcCommon} from "./ArcCommon.t.sol";

contract ArcCollectionRevealTest is ArcCommon {
    ArcCollection internal c;

    uint64 internal constant START = T0 + 100;
    uint64 internal constant END = T0 + 10 days;

    function setUp() public override {
        super.setUp();
        c = createVia(makeParams(1_000, 4, 4, START, END));
        fund(alice, 1_000_000, address(c));
        fund(bob, 1_000_000, address(c));
    }

    function _sellout() internal {
        vm.warp(START);
        vm.prank(alice);
        c.mint(4);
    }

    function _mintSome() internal {
        vm.warp(START);
        vm.prank(alice);
        c.mint(2);
    }

    // ---------------------------------------------------------------- reveal

    function test_Reveal_AfterSelloutBeforeMintEnd() public {
        _sellout();
        assertLt(block.timestamp, END);
        vm.expectEmit(false, false, false, true, address(c));
        emit ArcCollection.Revealed(SECRET, false);
        c.reveal(SECRET);
        assertTrue(c.revealed());
        assertEq(c.seed(), SECRET);
    }

    function test_Reveal_AfterMintEndWithoutSellout() public {
        _mintSome();
        vm.warp(END);
        vm.prank(bob); // permissionless
        c.reveal(SECRET);
        assertTrue(c.revealed());
        assertEq(c.seed(), SECRET);
    }

    function test_Reveal_RevertsBeforeSelloutAndMintEnd() public {
        _mintSome();
        vm.expectRevert(ArcCollection.RevealNotReady.selector);
        c.reveal(SECRET);
        vm.warp(END - 1);
        vm.expectRevert(ArcCollection.RevealNotReady.selector);
        c.reveal(SECRET);
    }

    function test_Reveal_RevertsWrongPreimage() public {
        _sellout();
        vm.expectRevert(ArcCollection.InvalidSeed.selector);
        c.reveal(keccak256("wrong"));
        // revealing the commitment itself is not the preimage
        vm.expectRevert(ArcCollection.InvalidSeed.selector);
        c.reveal(commitmentOf(SECRET));
        assertFalse(c.revealed());
    }

    function test_Reveal_WrongPreimageRevertsEvenWhenNotReady() public {
        vm.expectRevert(ArcCollection.InvalidSeed.selector);
        c.reveal(bytes32(0));
    }

    function test_Reveal_RevertsAlreadyRevealed() public {
        _sellout();
        c.reveal(SECRET);
        vm.expectRevert(ArcCollection.AlreadyRevealed.selector);
        c.reveal(SECRET);
        vm.expectRevert(ArcCollection.AlreadyRevealed.selector);
        c.revealFallback();
    }

    function test_Mint_ClosedAfterReveal() public {
        _mintSome();
        vm.warp(END);
        c.reveal(SECRET);
        vm.expectRevert(ArcCollection.MintClosed.selector);
        vm.prank(bob);
        c.mint(1);
    }

    function test_Mint_ClosedAfterRevealOnSellout() public {
        _sellout();
        c.reveal(SECRET);
        vm.expectRevert(ArcCollection.MintClosed.selector);
        vm.prank(bob);
        c.mint(1);
    }

    // ---------------------------------------------------------------- fallback

    function test_Fallback_RevertsBeforeMintEndPlus7d() public {
        _mintSome();
        vm.warp(END + 7 days - 1);
        vm.expectRevert(ArcCollection.RevealNotReady.selector);
        c.revealFallback();
    }

    function test_Fallback_RevertsEvenAfterSelloutBeforeDelay() public {
        _sellout();
        vm.expectRevert(ArcCollection.RevealNotReady.selector);
        c.revealFallback();
    }

    function test_Fallback_UsesCommitmentAsSeedAtExactDelay() public {
        _mintSome();
        vm.warp(END + 7 days);
        vm.expectEmit(false, false, false, true, address(c));
        emit ArcCollection.Revealed(commitmentOf(SECRET), true);
        vm.prank(bob);
        c.revealFallback();
        assertTrue(c.revealed());
        assertEq(c.seed(), commitmentOf(SECRET));
    }

    function test_Fallback_RevertsAlreadyRevealed() public {
        _mintSome();
        vm.warp(END + 7 days);
        c.revealFallback();
        vm.expectRevert(ArcCollection.AlreadyRevealed.selector);
        c.revealFallback();
        vm.expectRevert(ArcCollection.AlreadyRevealed.selector);
        c.reveal(SECRET);
    }

    function test_Reveal_StillPossibleAfterFallbackWindow() public {
        _mintSome();
        vm.warp(END + 30 days);
        c.reveal(SECRET);
        assertEq(c.seed(), SECRET);
    }

    function test_Fallback_MintClosedAfterwards() public {
        _mintSome();
        vm.warp(END + 7 days);
        c.revealFallback();
        vm.expectRevert(ArcCollection.MintClosed.selector);
        vm.prank(bob);
        c.mint(1);
    }

    // ---------------------------------------------------------------- traitsOf

    function test_TraitsOf_RevertsBeforeReveal() public {
        _sellout();
        vm.expectRevert(ArcCollection.NotRevealed.selector);
        c.traitsOf(1);
    }

    function test_TraitsOf_RevertsForNonexistentTokenAfterReveal() public {
        _mintSome();
        vm.warp(END);
        c.reveal(SECRET);
        vm.expectRevert(ArcCollection.NotRevealed.selector);
        c.traitsOf(3);
        vm.expectRevert(ArcCollection.NotRevealed.selector);
        c.traitsOf(0);
    }

    function test_TraitsOf_IndexesInRangeAndDeterministic() public {
        _sellout();
        c.reveal(SECRET);
        for (uint256 id = 1; id <= 4; ++id) {
            uint32 t = c.traitsOf(id);
            assertEq(t, c.traitsOf(id));
            for (uint256 s; s < 4; ++s) {
                assertLe((t >> (s * 8)) & 0xff, 4);
            }
            assertEq(t >> 24 & 0xff, t >> 24, "no bits above slot 3");
        }
    }

    function test_TraitsOf_DependsOnSeed() public {
        // fallback seed (public commitment) gives different traits than the secret for at least one token
        ArcCollection other = createVia(makeParams(1_000, 4, 4, START, END));
        _sellout();
        c.reveal(SECRET);
        vm.warp(START);
        fund(bob, 1_000_000, address(other));
        vm.prank(bob);
        other.mint(4);
        vm.warp(END + 7 days);
        other.revealFallback();
        bool differs;
        for (uint256 id = 1; id <= 4; ++id) {
            if (c.traitsOf(id) != other.traitsOf(id)) differs = true;
        }
        assertTrue(differs);
    }

    function test_TraitsOf_DistributionRoughlyMatchesWeights() public {
        ArcCollection big = createVia(makeParams(0, 1000, 1000, START, END));
        vm.warp(START);
        vm.prank(alice);
        big.mint(1000);
        big.reveal(SECRET);
        uint256[5] memory counts;
        for (uint256 id = 1; id <= 1000; ++id) {
            uint32 t = big.traitsOf(id);
            for (uint256 s; s < 4; ++s) {
                uint256 idx = (t >> (s * 8)) & 0xff;
                assertLe(idx, 4);
                counts[idx]++;
            }
        }
        // 4000 rolls: expected 2000 / 1000 / 600 / 280 / 120 (loose +-25%)
        assertGt(counts[0], 1500);
        assertLt(counts[0], 2500);
        assertGt(counts[1], 750);
        assertLt(counts[1], 1250);
        assertGt(counts[2], 400);
        assertLt(counts[2], 800);
        assertGt(counts[3], 150);
        assertLt(counts[3], 400);
        assertGt(counts[4], 50);
        assertLt(counts[4], 200);
    }

    function testFuzz_TraitsOf_AlwaysInRange(bytes32 secret, uint8 supplySeed) public {
        uint32 supply = uint32(bound(supplySeed, 1, 30));
        bytes32 commit = keccak256(abi.encode(secret));
        ArcCollection fz = createVia(_withCommit(supply, commit));
        vm.warp(START);
        vm.prank(alice);
        fz.mint(supply);
        fz.reveal(secret);
        for (uint256 id = 1; id <= supply; ++id) {
            uint32 t = fz.traitsOf(id);
            for (uint256 s; s < 4; ++s) {
                assertLe((t >> (s * 8)) & 0xff, 4);
            }
            assertEq(uint256(t) >> 32, 0);
        }
    }

    function _withCommit(uint32 supply, bytes32 commit) internal view returns (Params memory p) {
        p = makeParams(0, supply, supply, START, END);
        p.seedCommitment = commit;
    }
}
