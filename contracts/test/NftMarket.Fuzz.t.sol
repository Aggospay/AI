// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ArcCollection, Params} from "../ArcCollection.sol";
import {NftMarket} from "../NftMarket.sol";
import {NftMarketBase} from "./NftMarket.Base.t.sol";

contract NftMarketFuzzTest is NftMarketBase {
    uint256 internal constant MAX_PRICE_TICKS = 1e9; // up to 1e12 USDC-units (1,000,000 USDC)

    function _fuzzCollection(uint96 royaltyBps) internal returns (ArcCollection c) {
        Params memory p = makeParams(0, 10, 10, T0, T0 + 30 days);
        p.royaltyBps = royaltyBps;
        c = createVia(p);
        vm.prank(alice);
        c.mint(3);
        vm.prank(alice);
        c.setApprovalForAll(address(market), true);
    }

    function testFuzz_Quote_FeeRoyaltyProceedsSumToPrice(uint256 ticks, uint16 feeBps, uint96 royaltyBps) public {
        feeBps = uint16(bound(feeBps, 0, 1000));
        royaltyBps = uint96(bound(royaltyBps, 0, 1000));
        ticks = bound(ticks, 1, type(uint128).max / 1000);
        uint256 price = ticks * 1000;
        vm.prank(owner);
        market.setFee(feeBps);
        ArcCollection c = _fuzzCollection(royaltyBps);

        (uint256 fee, uint256 royalty, address rcv, uint256 proceeds) = market.quote(address(c), 1, price);

        assertEq(fee + royalty + proceeds, price, "split must be exact");
        assertEq(fee, Math.mulDiv(price, feeBps, 10_000));
        assertEq(royalty, price * royaltyBps / 10_000);
        assertLe(royalty, price / 10);
        assertEq(rcv, royaltyRecv);
    }

    function testFuzz_Buy_ConservesValue(uint256 ticks, uint16 feeBps, uint96 royaltyBps) public {
        feeBps = uint16(bound(feeBps, 0, 1000));
        royaltyBps = uint96(bound(royaltyBps, 0, 1000));
        uint256 price = bound(ticks, 1, MAX_PRICE_TICKS) * 1000;
        vm.prank(owner);
        market.setFee(feeBps);
        ArcCollection c = _fuzzCollection(royaltyBps);
        usdc.mint(bob, price);

        vm.prank(alice);
        market.list(address(c), 1, price, 0);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 feeBefore = usdc.balanceOf(feeTo);
        vm.prank(bob);
        market.buy(address(c), 1, price);

        uint256 fee = usdc.balanceOf(feeTo) - feeBefore;
        uint256 royalty = market.royaltyBalance(royaltyRecv);
        uint256 proceeds = usdc.balanceOf(alice) - aliceBefore;
        assertEq(fee + royalty + proceeds, price, "fee+royalty+sellerProceeds == price");
        assertEq(bobBefore - usdc.balanceOf(bob), price);
        assertEq(usdc.balanceOf(address(market)), royalty, "market holds only royalty credit");
        assertEq(c.ownerOf(1), bob);
    }

    function testFuzz_AcceptOffer_ConservesValue(uint256 ticks, uint16 feeBps, uint96 royaltyBps, bool wide) public {
        feeBps = uint16(bound(feeBps, 0, 1000));
        royaltyBps = uint96(bound(royaltyBps, 0, 1000));
        uint256 price = bound(ticks, 1, MAX_PRICE_TICKS) * 1000;
        vm.prank(owner);
        market.setFee(feeBps);
        ArcCollection c = _fuzzCollection(royaltyBps);
        usdc.mint(bob, price);

        vm.prank(bob);
        uint256 id = market.makeOffer(address(c), 2, wide, price, uint64(block.timestamp + 1 days));
        assertEq(usdc.balanceOf(address(market)), price, "escrow == offer price");

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 feeBefore = usdc.balanceOf(feeTo);
        vm.prank(alice);
        market.acceptOffer(id, 2, price);

        uint256 fee = usdc.balanceOf(feeTo) - feeBefore;
        uint256 royalty = market.royaltyBalance(royaltyRecv);
        uint256 proceeds = usdc.balanceOf(alice) - aliceBefore;
        assertEq(fee + royalty + proceeds, price);
        assertEq(usdc.balanceOf(address(market)), royalty);
        assertEq(c.ownerOf(2), bob);

        market.withdrawRoyalty(royaltyRecv);
        assertEq(usdc.balanceOf(royaltyRecv), royalty);
        assertEq(usdc.balanceOf(address(market)), 0);
    }

    function testFuzz_UpdateOffer_EscrowTracksPriceBothDirections(uint256 t1, uint256 t2) public {
        uint256 p1 = bound(t1, 1, MAX_PRICE_TICKS) * 1000;
        uint256 p2 = bound(t2, 1, MAX_PRICE_TICKS) * 1000;
        usdc.mint(bob, p1 + p2);
        uint256 bobStart = usdc.balanceOf(bob);

        uint256 id = offerAs(bob, 1, false, p1, 1 days);
        assertEq(usdc.balanceOf(address(market)), p1);

        vm.prank(bob);
        market.updateOffer(id, p2, uint64(block.timestamp + 2 days));

        assertEq(usdc.balanceOf(address(market)), p2, "escrow equals new price");
        assertEq(bobStart - usdc.balanceOf(bob), p2, "bidder out exactly new price");
        assertEq(market.getOffer(id).price, p2);

        vm.prank(bob);
        market.cancelOffer(id);
        assertEq(usdc.balanceOf(bob), bobStart, "full refund");
        assertEq(usdc.balanceOf(address(market)), 0);
    }

    function testFuzz_PriceValidity(uint256 price) public {
        bool valid = price != 0 && price % 1000 == 0 && price <= type(uint128).max;
        vm.prank(alice);
        if (!valid) vm.expectRevert(NftMarket.InvalidPrice.selector);
        market.list(address(col), 1, price, 0);
        if (valid) assertEq(market.getListing(address(col), 1).price, price);
    }

    function testFuzz_OfferExpiryWindow(uint256 dur) public {
        dur = bound(dur, 0, 60 days);
        vm.prank(bob);
        if (dur == 0 || dur > 30 days) vm.expectRevert(NftMarket.InvalidExpiry.selector);
        market.makeOffer(address(col), 1, false, P, uint64(block.timestamp + dur));
    }

    function testFuzz_ReclaimTiming(uint256 dur, uint256 elapsed) public {
        dur = bound(dur, 1, 30 days);
        elapsed = bound(elapsed, 0, 40 days);
        uint256 id = offerAs(bob, 1, false, P, dur);
        skip(elapsed);
        if (elapsed < dur) vm.expectRevert(NftMarket.OfferNotExpired.selector);
        market.reclaimExpiredOffer(id);
    }
}
