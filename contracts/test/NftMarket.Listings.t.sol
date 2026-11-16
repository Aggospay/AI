// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NftMarket} from "../NftMarket.sol";
import {NftMarketBase} from "./NftMarket.Base.t.sol";

contract NftMarketListingsTest is NftMarketBase {
    // ---------------------------------------------------------------- list

    function test_List_StoresListingAndEmits() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.Listed(address(col), 1, alice, uint128(P), exp);
        vm.prank(alice);
        market.list(address(col), 1, P, exp);
        NftMarket.Listing memory l = market.getListing(address(col), 1);
        assertEq(l.seller, alice);
        assertEq(l.price, P);
        assertEq(l.expiry, exp);
        assertEq(col.ownerOf(1), alice, "noncustodial");
    }

    function test_List_NoExpiryAllowed() public {
        listAs(alice, 1, P);
        assertEq(market.getListing(address(col), 1).expiry, 0);
    }

    function test_List_WorksWithPerTokenApproval() public {
        vm.startPrank(alice);
        col.setApprovalForAll(address(market), false);
        col.approve(address(market), 2);
        market.list(address(col), 2, P, 0);
        vm.stopPrank();
        assertEq(market.getListing(address(col), 2).seller, alice);
    }

    function test_List_RevertsInvalidPrice() public {
        vm.startPrank(alice);
        vm.expectRevert(NftMarket.InvalidPrice.selector);
        market.list(address(col), 1, 0, 0);
        vm.expectRevert(NftMarket.InvalidPrice.selector);
        market.list(address(col), 1, 1_001, 0);
        vm.expectRevert(NftMarket.InvalidPrice.selector);
        market.list(address(col), 1, 1000 * (uint256(1) << 120), 0); // multiple of tick, > uint128 max
        vm.stopPrank();
    }

    function test_List_RevertsInvalidExpiry() public {
        vm.startPrank(alice);
        vm.expectRevert(NftMarket.InvalidExpiry.selector);
        market.list(address(col), 1, P, uint64(block.timestamp));
        vm.expectRevert(NftMarket.InvalidExpiry.selector);
        market.list(address(col), 1, P, uint64(block.timestamp - 1));
        vm.stopPrank();
    }

    function test_List_RevertsNotOwnerAndNotApproved() public {
        vm.expectRevert(NftMarket.NotTokenOwner.selector);
        vm.prank(bob);
        market.list(address(col), 1, P, 0);
        vm.startPrank(alice);
        col.setApprovalForAll(address(market), false);
        vm.expectRevert(NftMarket.NotApproved.selector);
        market.list(address(col), 1, P, 0);
        vm.stopPrank();
    }

    function test_List_NewOwnerReplacesObsoleteListingAndEmitsCancel() public {
        listAs(alice, 1, P);
        vm.prank(alice);
        col.transferFrom(alice, bob, 1);
        vm.prank(bob);
        col.setApprovalForAll(address(market), true);

        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.ListingCancelled(address(col), 1, alice, true);
        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.Listed(address(col), 1, bob, uint128(P * 2), 0);
        vm.prank(bob);
        market.list(address(col), 1, P * 2, 0);
        assertEq(market.getListing(address(col), 1).seller, bob);
    }

    function test_List_SameSellerRelistOverwritesWithoutCancelEvent() public {
        listAs(alice, 1, P);
        vm.recordLogs();
        listAs(alice, 1, P * 3);
        assertEq(vm.getRecordedLogs().length, 1, "only Listed");
        assertEq(market.getListing(address(col), 1).price, P * 3);
    }

    // ---------------------------------------------------------------- updateListing

    function test_UpdateListing_ChangesPriceAndExpiryAndEmits() public {
        listAs(alice, 1, P);
        uint64 exp = uint64(block.timestamp + 2 days);
        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.ListingUpdated(address(col), 1, alice, uint128(P), uint128(P * 2), exp);
        vm.prank(alice);
        market.updateListing(address(col), 1, P * 2, exp);
        NftMarket.Listing memory l = market.getListing(address(col), 1);
        assertEq(l.price, P * 2);
        assertEq(l.expiry, exp);
    }

    function test_UpdateListing_Reverts() public {
        vm.expectRevert(NftMarket.ListingNotFound.selector);
        vm.prank(alice);
        market.updateListing(address(col), 1, P, 0);

        listAs(alice, 1, P);

        vm.expectRevert(NftMarket.NotSeller.selector);
        vm.prank(bob);
        market.updateListing(address(col), 1, P, 0);

        vm.startPrank(alice);
        vm.expectRevert(NftMarket.InvalidPrice.selector);
        market.updateListing(address(col), 1, 999, 0);
        vm.expectRevert(NftMarket.InvalidExpiry.selector);
        market.updateListing(address(col), 1, P, uint64(block.timestamp));
        vm.stopPrank();
    }

    function test_UpdateListing_RevertsWhenExpiredOrNoLongerOwnedOrApproved() public {
        vm.prank(alice);
        market.list(address(col), 1, P, uint64(block.timestamp + 1 hours));
        listAs(alice, 2, P);
        listAs(alice, 3, P);

        vm.prank(alice);
        col.transferFrom(alice, bob, 2);
        vm.expectRevert(NftMarket.NotTokenOwner.selector);
        vm.prank(alice);
        market.updateListing(address(col), 2, P, 0);

        vm.prank(alice);
        col.setApprovalForAll(address(market), false);
        vm.expectRevert(NftMarket.NotApproved.selector);
        vm.prank(alice);
        market.updateListing(address(col), 3, P, 0);

        skip(1 hours);
        vm.expectRevert(NftMarket.ListingExpired.selector);
        vm.prank(alice);
        market.updateListing(address(col), 1, P, 0);
    }

    // ---------------------------------------------------------------- cancelListing

    function test_CancelListing_SellerCancelsAnytime() public {
        listAs(alice, 1, P);
        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.ListingCancelled(address(col), 1, alice, false);
        vm.prank(alice);
        market.cancelListing(address(col), 1);
        assertEq(market.getListing(address(col), 1).price, 0);
    }

    function test_CancelListing_RevertsNotFound() public {
        vm.expectRevert(NftMarket.ListingNotFound.selector);
        vm.prank(alice);
        market.cancelListing(address(col), 1);
    }

    function test_CancelListing_StrangerCannotCancelHealthyListing() public {
        listAs(alice, 1, P);
        vm.expectRevert(NftMarket.ListingNotStale.selector);
        vm.prank(bob);
        market.cancelListing(address(col), 1);
        assertEq(market.getListing(address(col), 1).price, P);
    }

    function test_CancelListing_StrangerCannotCancelWhenApprovedPerToken() public {
        vm.startPrank(alice);
        col.setApprovalForAll(address(market), false);
        col.approve(address(market), 1);
        market.list(address(col), 1, P, 0);
        vm.stopPrank();
        vm.expectRevert(NftMarket.ListingNotStale.selector);
        vm.prank(bob);
        market.cancelListing(address(col), 1);
    }

    function test_CancelListing_AnyoneCanCancelExpired() public {
        vm.prank(alice);
        market.list(address(col), 1, P, uint64(block.timestamp + 1 hours));
        skip(1 hours); // exclusive expiry: stale at exactly expiry
        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.ListingCancelled(address(col), 1, alice, true);
        vm.prank(bob);
        market.cancelListing(address(col), 1);
        assertEq(market.getListing(address(col), 1).price, 0);
    }

    function test_CancelListing_AnyoneCanCancelAfterOwnerChange() public {
        listAs(alice, 1, P);
        vm.prank(alice);
        col.transferFrom(alice, carol, 1);
        vm.prank(bob);
        market.cancelListing(address(col), 1);
        assertEq(market.getListing(address(col), 1).price, 0);
    }

    function test_CancelListing_AnyoneCanCancelAfterApprovalRevoked() public {
        listAs(alice, 1, P);
        vm.prank(alice);
        col.setApprovalForAll(address(market), false);
        vm.prank(carol);
        market.cancelListing(address(col), 1);
        assertEq(market.getListing(address(col), 1).price, 0);
    }

    // ---------------------------------------------------------------- buy

    function test_Buy_SettlesFeeRoyaltyAndSeller() public {
        listAs(alice, 1, P);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.expectEmit(true, true, true, true, address(market));
        emit NftMarket.Sale(address(col), 1, alice, bob, P, feeOf(P), royaltyOf(P), 0);
        vm.prank(bob);
        market.buy(address(col), 1, P);

        assertEq(col.ownerOf(1), bob);
        assertEq(usdc.balanceOf(bob), bobBefore - P);
        assertEq(usdc.balanceOf(alice), aliceBefore + proceedsOf(P));
        assertEq(usdc.balanceOf(feeTo), feeOf(P));
        assertEq(market.royaltyBalance(royaltyRecv), royaltyOf(P));
        assertEq(usdc.balanceOf(address(market)), royaltyOf(P), "market holds only royalty credit");
        assertEq(market.getListing(address(col), 1).price, 0, "listing consumed");
    }

    function test_Buy_MaxPriceAboveListingPaysListingPrice() public {
        listAs(alice, 1, P);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        market.buy(address(col), 1, P * 10);
        assertEq(bobBefore - usdc.balanceOf(bob), P);
    }

    function test_Buy_RevertsWhenPriceAboveMax_FrontRunRaise() public {
        listAs(alice, 1, P);
        vm.prank(alice);
        market.updateListing(address(col), 1, P * 2, 0);
        vm.expectRevert(NftMarket.PriceAboveMax.selector);
        vm.prank(bob);
        market.buy(address(col), 1, P);
        assertEq(col.ownerOf(1), alice);
    }

    function test_Buy_RevertsNotFoundExpiredSelfTrade() public {
        vm.expectRevert(NftMarket.ListingNotFound.selector);
        vm.prank(bob);
        market.buy(address(col), 1, P);

        vm.prank(alice);
        market.list(address(col), 1, P, uint64(block.timestamp + 1 hours));
        vm.expectRevert(NftMarket.SelfTrade.selector);
        vm.prank(alice);
        market.buy(address(col), 1, P);

        skip(1 hours);
        vm.expectRevert(NftMarket.ListingExpired.selector);
        vm.prank(bob);
        market.buy(address(col), 1, P);
    }

    function test_Buy_RevertsIfSellerNoLongerOwnsOrApproves() public {
        listAs(alice, 1, P);
        listAs(alice, 2, P);
        vm.startPrank(alice);
        col.transferFrom(alice, carol, 1);
        vm.stopPrank();
        vm.expectRevert(NftMarket.NotTokenOwner.selector);
        vm.prank(bob);
        market.buy(address(col), 1, P);

        vm.prank(alice);
        col.setApprovalForAll(address(market), false);
        vm.expectRevert(NftMarket.NotApproved.selector);
        vm.prank(bob);
        market.buy(address(col), 2, P);
    }

    function test_Buy_RevertsWithoutUsdcAllowance() public {
        listAs(alice, 1, P);
        address dave = makeAddr("dave");
        usdc.mint(dave, P);
        vm.expectRevert();
        vm.prank(dave);
        market.buy(address(col), 1, P);
        assertEq(col.ownerOf(1), alice);
    }

    function test_Buy_CannotBuyTwice() public {
        listAs(alice, 1, P);
        vm.prank(bob);
        market.buy(address(col), 1, P);
        vm.expectRevert(NftMarket.ListingNotFound.selector);
        vm.prank(carol);
        market.buy(address(col), 1, P);
    }

    function test_Buy_ZeroFeeStillSettlesExactly() public {
        vm.prank(owner);
        market.setFee(0);
        listAs(alice, 1, P);
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(bob);
        market.buy(address(col), 1, P);
        assertEq(usdc.balanceOf(feeTo), 0);
        assertEq(usdc.balanceOf(alice) - aliceBefore, P - royaltyOf(P));
    }

    // ---------------------------------------------------------------- royalty withdraw

    function test_WithdrawRoyalty_AnyoneTriggersPayoutToReceiverAndEmits() public {
        listAs(alice, 1, P);
        vm.prank(bob);
        market.buy(address(col), 1, P);

        vm.expectEmit(true, false, false, true, address(market));
        emit NftMarket.RoyaltyWithdrawn(royaltyRecv, royaltyOf(P));
        vm.prank(carol);
        market.withdrawRoyalty(royaltyRecv);

        assertEq(usdc.balanceOf(royaltyRecv), royaltyOf(P));
        assertEq(market.royaltyBalance(royaltyRecv), 0);
        assertEq(usdc.balanceOf(address(market)), 0);
    }

    function test_WithdrawRoyalty_ZeroBalanceIsHarmless() public {
        vm.expectEmit(true, false, false, true, address(market));
        emit NftMarket.RoyaltyWithdrawn(alice, 0);
        market.withdrawRoyalty(alice);
        assertEq(usdc.balanceOf(alice), 1_000_000e6);
    }

    function test_WithdrawRoyalty_WorksWhilePaused() public {
        listAs(alice, 1, P);
        vm.prank(bob);
        market.buy(address(col), 1, P);
        vm.prank(owner);
        market.pause();
        market.withdrawRoyalty(royaltyRecv);
        assertEq(usdc.balanceOf(royaltyRecv), royaltyOf(P));
    }

    function test_Royalty_AccumulatesAcrossSales() public {
        listAs(alice, 1, P);
        listAs(alice, 2, P * 2);
        vm.prank(bob);
        market.buy(address(col), 1, P);
        vm.prank(bob);
        market.buy(address(col), 2, P * 2);
        assertEq(market.royaltyBalance(royaltyRecv), royaltyOf(P) + royaltyOf(P * 2));
    }
}
