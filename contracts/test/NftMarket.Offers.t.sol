// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NftMarket} from "../NftMarket.sol";
import {NftMarketBase} from "./NftMarket.Base.t.sol";

contract NftMarketOffersTest is NftMarketBase {
    // ---------------------------------------------------------------- makeOffer

    function test_MakeOffer_TokenOfferEscrowsAndEmits() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.OfferMade(1, address(col), bob, 1, false, uint128(P), exp);
        vm.prank(bob);
        uint256 id = market.makeOffer(address(col), 1, false, P, exp);

        assertEq(id, 1);
        assertEq(market.nextOfferId(), 2);
        assertEq(usdc.balanceOf(address(market)), P);
        assertEq(usdc.balanceOf(bob), bobBefore - P);
        NftMarket.Offer memory o = market.getOffer(id);
        assertEq(o.bidder, bob);
        assertEq(o.collection, address(col));
        assertEq(o.tokenId, 1);
        assertFalse(o.collectionWide);
        assertEq(o.price, P);
        assertEq(o.expiry, exp);
    }

    function test_MakeOffer_CollectionWideEscrowsAndIdsIncrement() public {
        uint256 a = offerAs(bob, 999, true, P, 1 days); // tokenId informational only
        uint256 b = offerAs(carol, 0, true, P * 2, 2 days);
        assertEq(a, 1);
        assertEq(b, 2);
        assertTrue(market.getOffer(a).collectionWide);
        assertEq(usdc.balanceOf(address(market)), P * 3);
    }

    function test_MakeOffer_CollectionWideAllowedForTokenHolder() public {
        uint256 id = offerAs(alice, 0, true, P, 1 days); // alice owns tokens; only token offers forbid self
        assertEq(market.getOffer(id).bidder, alice);
    }

    function test_MakeOffer_Reverts() public {
        uint64 ok = uint64(block.timestamp + 1 days);
        vm.startPrank(bob);
        vm.expectRevert(NftMarket.InvalidPrice.selector);
        market.makeOffer(address(col), 1, false, 0, ok);
        vm.expectRevert(NftMarket.InvalidPrice.selector);
        market.makeOffer(address(col), 1, false, 1_234, ok);
        vm.expectRevert(NftMarket.InvalidExpiry.selector);
        market.makeOffer(address(col), 1, false, P, uint64(block.timestamp));
        vm.expectRevert(NftMarket.InvalidExpiry.selector);
        market.makeOffer(address(col), 1, false, P, uint64(block.timestamp + 30 days + 1));
        vm.expectRevert(); // nonexistent token: ownerOf reverts
        market.makeOffer(address(col), 77, false, P, ok);
        vm.stopPrank();

        vm.expectRevert(NftMarket.SelfTrade.selector);
        vm.prank(alice);
        market.makeOffer(address(col), 1, false, P, ok);
        assertEq(market.nextOfferId(), 1);
    }

    function test_MakeOffer_MaxDurationExactlyAllowed() public {
        uint256 id = offerAs(bob, 1, false, P, 30 days);
        assertEq(market.getOffer(id).expiry, block.timestamp + 30 days);
    }

    function test_MakeOffer_RevertsWithoutAllowance() public {
        address dave = makeAddr("dave");
        usdc.mint(dave, P);
        vm.expectRevert();
        vm.prank(dave);
        market.makeOffer(address(col), 1, false, P, uint64(block.timestamp + 1 days));
    }

    // ---------------------------------------------------------------- updateOffer

    function test_UpdateOffer_IncreaseEscrowsOnlyDelta() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        uint256 bobBefore = usdc.balanceOf(bob);
        uint64 exp = uint64(block.timestamp + 2 days);
        vm.expectEmit(true, false, false, true, address(market));
        emit NftMarket.OfferUpdated(id, uint128(P), uint128(P * 3), exp);
        vm.prank(bob);
        market.updateOffer(id, P * 3, exp);
        assertEq(bobBefore - usdc.balanceOf(bob), P * 2);
        assertEq(usdc.balanceOf(address(market)), P * 3);
        assertEq(market.getOffer(id).price, P * 3);
        assertEq(market.getOffer(id).expiry, exp);
    }

    function test_UpdateOffer_DecreaseRefundsOnlyDelta() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        market.updateOffer(id, P / 4, uint64(block.timestamp + 1 days));
        assertEq(usdc.balanceOf(bob) - bobBefore, P - P / 4);
        assertEq(usdc.balanceOf(address(market)), P / 4);
        assertEq(market.getOffer(id).price, P / 4);
    }

    function test_UpdateOffer_SamePriceMovesNoFunds() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        market.updateOffer(id, P, uint64(block.timestamp + 5 days));
        assertEq(usdc.balanceOf(bob), bobBefore);
        assertEq(usdc.balanceOf(address(market)), P);
        assertEq(market.getOffer(id).expiry, block.timestamp + 5 days);
    }

    function test_UpdateOffer_Reverts() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        uint64 ok = uint64(block.timestamp + 1 days);

        vm.expectRevert(NftMarket.OfferNotFound.selector);
        vm.prank(bob);
        market.updateOffer(99, P, ok);

        vm.expectRevert(NftMarket.NotBidder.selector);
        vm.prank(carol);
        market.updateOffer(id, P, ok);

        vm.startPrank(bob);
        vm.expectRevert(NftMarket.InvalidPrice.selector);
        market.updateOffer(id, 0, ok);
        vm.expectRevert(NftMarket.InvalidPrice.selector);
        market.updateOffer(id, 1_500, ok);
        vm.expectRevert(NftMarket.InvalidExpiry.selector);
        market.updateOffer(id, P, uint64(block.timestamp));
        vm.expectRevert(NftMarket.InvalidExpiry.selector);
        market.updateOffer(id, P, uint64(block.timestamp + 30 days + 1));
        vm.stopPrank();
    }

    function test_UpdateOffer_RevertsWhenExpired() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        skip(1 days);
        vm.expectRevert(NftMarket.OfferExpired.selector);
        vm.prank(bob);
        market.updateOffer(id, P * 2, uint64(block.timestamp + 1 days));
    }

    // ---------------------------------------------------------------- cancel / reclaim

    function test_CancelOffer_RefundsFullEscrowAndEmits() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.expectEmit(true, false, false, true, address(market));
        emit NftMarket.OfferCancelled(id, bob, P, false);
        vm.prank(bob);
        market.cancelOffer(id);
        assertEq(usdc.balanceOf(bob) - bobBefore, P);
        assertEq(usdc.balanceOf(address(market)), 0);
        assertEq(market.getOffer(id).price, 0);
    }

    function test_CancelOffer_WorksEvenAfterExpiry() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        skip(10 days);
        vm.prank(bob);
        market.cancelOffer(id);
        assertEq(usdc.balanceOf(address(market)), 0);
    }

    function test_CancelOffer_Reverts() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        vm.expectRevert(NftMarket.NotBidder.selector);
        vm.prank(carol);
        market.cancelOffer(id);
        vm.prank(bob);
        market.cancelOffer(id);
        vm.expectRevert(NftMarket.OfferNotFound.selector);
        vm.prank(bob);
        market.cancelOffer(id);
    }

    function test_ReclaimExpired_AnyoneAfterExpiryRefundsBidder() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        uint256 bobBefore = usdc.balanceOf(bob);
        skip(1 days); // exclusive expiry: expired at exactly expiry
        vm.expectEmit(true, false, false, true, address(market));
        emit NftMarket.OfferCancelled(id, bob, P, true);
        vm.prank(carol);
        market.reclaimExpiredOffer(id);
        assertEq(usdc.balanceOf(bob) - bobBefore, P);
        assertEq(usdc.balanceOf(carol), 1_000_000e6, "caller gets nothing");
        assertEq(market.getOffer(id).price, 0);
    }

    function test_ReclaimExpired_Reverts() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        skip(1 days - 1);
        vm.expectRevert(NftMarket.OfferNotExpired.selector);
        vm.prank(carol);
        market.reclaimExpiredOffer(id);
        vm.expectRevert(NftMarket.OfferNotFound.selector);
        market.reclaimExpiredOffer(42);
    }

    // ---------------------------------------------------------------- acceptOffer (token)

    function test_AcceptOffer_TokenOfferSettlesAndEmits() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.OfferAccepted(id, address(col), 1, alice, bob, P);
        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.Sale(address(col), 1, alice, bob, P, feeOf(P), royaltyOf(P), 1);
        vm.prank(alice);
        market.acceptOffer(id, 1, P);

        assertEq(col.ownerOf(1), bob);
        assertEq(usdc.balanceOf(alice) - aliceBefore, proceedsOf(P));
        assertEq(usdc.balanceOf(feeTo), feeOf(P));
        assertEq(market.royaltyBalance(royaltyRecv), royaltyOf(P));
        assertEq(usdc.balanceOf(address(market)), royaltyOf(P));
        assertEq(market.getOffer(id).price, 0, "escrow consumed");
    }

    function test_AcceptOffer_RoyaltyWithdrawableAfter() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        vm.prank(alice);
        market.acceptOffer(id, 1, P);
        market.withdrawRoyalty(royaltyRecv);
        assertEq(usdc.balanceOf(royaltyRecv), royaltyOf(P));
        assertEq(usdc.balanceOf(address(market)), 0);
    }

    function test_AcceptOffer_MinPriceProtectsAgainstOfferDowngrade() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        // bidder front-runs the seller by lowering the offer
        vm.prank(bob);
        market.updateOffer(id, P / 10, uint64(block.timestamp + 1 days));
        vm.expectRevert(NftMarket.PriceBelowMin.selector);
        vm.prank(alice);
        market.acceptOffer(id, 1, P);
        assertEq(col.ownerOf(1), alice);
        // accepting at the lowered price with a matching min succeeds
        vm.prank(alice);
        market.acceptOffer(id, 1, P / 10);
        assertEq(col.ownerOf(1), bob);
    }

    function test_AcceptOffer_RevertsTokenMismatch() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        vm.expectRevert(NftMarket.TokenMismatch.selector);
        vm.prank(alice);
        market.acceptOffer(id, 2, P);
    }

    function test_AcceptOffer_RevertsNotFoundExpiredNotOwnerNotApproved() public {
        vm.expectRevert(NftMarket.OfferNotFound.selector);
        vm.prank(alice);
        market.acceptOffer(5, 1, P);

        uint256 id = offerAs(bob, 1, false, P, 1 days);
        vm.expectRevert(NftMarket.NotTokenOwner.selector);
        vm.prank(carol);
        market.acceptOffer(id, 1, P);

        vm.prank(alice);
        col.setApprovalForAll(address(market), false);
        vm.expectRevert(NftMarket.NotApproved.selector);
        vm.prank(alice);
        market.acceptOffer(id, 1, P);

        vm.prank(alice);
        col.setApprovalForAll(address(market), true);
        skip(1 days);
        vm.expectRevert(NftMarket.OfferExpired.selector);
        vm.prank(alice);
        market.acceptOffer(id, 1, P);
    }

    function test_AcceptOffer_CannotAcceptTwice() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        vm.prank(alice);
        market.acceptOffer(id, 1, P);
        vm.expectRevert(NftMarket.OfferNotFound.selector);
        vm.prank(alice);
        market.acceptOffer(id, 1, P);
    }

    function test_AcceptOffer_ClearsSellersActiveListing() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        listAs(alice, 1, P * 5);
        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.ListingCancelled(address(col), 1, alice, false);
        vm.prank(alice);
        market.acceptOffer(id, 1, P);
        assertEq(market.getListing(address(col), 1).price, 0);
    }

    function test_AcceptOffer_ClearsStaleListingOfPriorOwner() public {
        uint256 id = offerAs(bob, 0, true, P, 1 days);
        listAs(alice, 1, P * 5);
        vm.prank(alice);
        col.transferFrom(alice, carol, 1);
        vm.prank(carol);
        col.setApprovalForAll(address(market), true);
        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.ListingCancelled(address(col), 1, alice, true);
        vm.prank(carol);
        market.acceptOffer(id, 1, P);
        assertEq(market.getListing(address(col), 1).price, 0);
    }

    // ---------------------------------------------------------------- collection offers

    function test_AcceptCollectionOffer_AnyTokenSettlesKind2() public {
        uint256 id = offerAs(bob, 0, true, P, 1 days);
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.Sale(address(col), 4, alice, bob, P, feeOf(P), royaltyOf(P), 2);
        vm.prank(alice);
        market.acceptCollectionOffer(id, 4, P);
        assertEq(col.ownerOf(4), bob);
        assertEq(usdc.balanceOf(alice) - aliceBefore, proceedsOf(P));
        assertEq(market.getOffer(id).price, 0);
    }

    function test_AcceptOffer_WorksOnCollectionOfferToo() public {
        uint256 id = offerAs(bob, 0, true, P, 1 days);
        vm.prank(alice);
        market.acceptOffer(id, 5, P);
        assertEq(col.ownerOf(5), bob);
    }

    function test_AcceptCollectionOffer_RevertsOnTokenOffer() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        vm.expectRevert(NftMarket.NotCollectionOffer.selector);
        vm.prank(alice);
        market.acceptCollectionOffer(id, 1, P);
    }

    function test_AcceptCollectionOffer_MinPriceAndSelfTrade() public {
        uint256 id = offerAs(bob, 0, true, P, 1 days);
        vm.expectRevert(NftMarket.PriceBelowMin.selector);
        vm.prank(alice);
        market.acceptCollectionOffer(id, 1, P + 1000);

        // bidder holding a token cannot fill their own collection offer
        vm.prank(alice);
        col.transferFrom(alice, bob, 2);
        vm.prank(bob);
        col.setApprovalForAll(address(market), true);
        vm.expectRevert(NftMarket.SelfTrade.selector);
        vm.prank(bob);
        market.acceptCollectionOffer(id, 2, P);
    }

    function test_AcceptCollectionOffer_RevertsNotOwner() public {
        uint256 id = offerAs(bob, 0, true, P, 1 days);
        vm.expectRevert(NftMarket.NotTokenOwner.selector);
        vm.prank(carol);
        market.acceptCollectionOffer(id, 1, P);
    }

    function test_OfferEscrow_SurvivesOwnerFeeChange() public {
        uint256 id = offerAs(bob, 1, false, P, 1 days);
        vm.prank(owner);
        market.setFee(1000);
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        market.acceptOffer(id, 1, P);
        assertEq(usdc.balanceOf(feeTo), P * 1000 / 10_000);
        assertEq(usdc.balanceOf(alice) - aliceBefore, P - P * 1000 / 10_000 - royaltyOf(P));
    }
}
