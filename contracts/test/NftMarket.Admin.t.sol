// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ArcCollection, Params} from "../ArcCollection.sol";
import {NftMarket} from "../NftMarket.sol";
import {NftMarketBase} from "./NftMarket.Base.t.sol";

contract NftMarketAdminTest is NftMarketBase {
    // ---------------------------------------------------------------- constructor

    function test_Constructor_StoresConfig() public view {
        assertEq(address(market.usdc()), address(usdc));
        assertEq(address(market.registry()), address(factory));
        assertEq(market.feeRecipient(), feeTo);
        assertEq(market.feeBps(), FEE_BPS);
        assertEq(market.owner(), owner);
        assertEq(market.nextOfferId(), 1);
        assertFalse(market.paused());
    }

    function test_Constructor_EmitsMarketConfigured() public {
        vm.expectEmit(true, true, true, true);
        emit NftMarket.MarketConfigured(address(usdc), address(factory), owner, feeTo, 1000);
        new NftMarket(address(usdc), address(factory), feeTo, 1000, owner);
    }

    function test_Constructor_RevertsInvalidAddress() public {
        vm.expectRevert(NftMarket.InvalidAddress.selector);
        new NftMarket(address(0), address(factory), feeTo, 0, owner);
        vm.expectRevert(NftMarket.InvalidAddress.selector);
        new NftMarket(alice, address(factory), feeTo, 0, owner); // EOA token
        vm.expectRevert(NftMarket.InvalidAddress.selector);
        new NftMarket(address(usdc), address(0), feeTo, 0, owner);
        vm.expectRevert(NftMarket.InvalidAddress.selector);
        new NftMarket(address(usdc), alice, feeTo, 0, owner); // EOA registry
        vm.expectRevert(NftMarket.InvalidAddress.selector);
        new NftMarket(address(usdc), address(factory), address(0), 0, owner);
        address self = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(NftMarket.InvalidAddress.selector);
        new NftMarket(address(usdc), address(factory), self, 0, owner);
    }

    function test_Constructor_RevertsInvalidFee() public {
        vm.expectRevert(NftMarket.InvalidFee.selector);
        new NftMarket(address(usdc), address(factory), feeTo, 1001, owner);
    }

    function test_Constructor_RevertsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new NftMarket(address(usdc), address(factory), feeTo, 0, address(0));
    }

    // ---------------------------------------------------------------- setFee / setFeeRecipient

    function test_SetFee_OwnerUpdatesAndEmits() public {
        vm.expectEmit(false, false, false, true, address(market));
        emit NftMarket.FeeUpdated(FEE_BPS, 1000);
        vm.prank(owner);
        market.setFee(1000);
        assertEq(market.feeBps(), 1000);
        vm.prank(owner);
        market.setFee(0);
        assertEq(market.feeBps(), 0);
    }

    function test_SetFee_RevertsAboveMaxAndNonOwner() public {
        vm.expectRevert(NftMarket.InvalidFee.selector);
        vm.prank(owner);
        market.setFee(1001);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        market.setFee(10);
    }

    function test_SetFeeRecipient_OwnerUpdatesAndEmits() public {
        vm.expectEmit(true, true, false, false, address(market));
        emit NftMarket.FeeRecipientUpdated(feeTo, carol);
        vm.prank(owner);
        market.setFeeRecipient(carol);
        assertEq(market.feeRecipient(), carol);
    }

    function test_SetFeeRecipient_Reverts() public {
        vm.startPrank(owner);
        vm.expectRevert(NftMarket.InvalidAddress.selector);
        market.setFeeRecipient(address(0));
        vm.expectRevert(NftMarket.InvalidAddress.selector);
        market.setFeeRecipient(address(market));
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        market.setFeeRecipient(alice);
    }

    function test_FeeChangeAppliesToExistingListing() public {
        listAs(alice, 1, P);
        vm.prank(owner);
        market.setFee(1000);
        uint256 feeBefore = usdc.balanceOf(feeTo);
        vm.prank(bob);
        market.buy(address(col), 1, P);
        assertEq(usdc.balanceOf(feeTo) - feeBefore, P * 1000 / 10_000);
    }

    // ---------------------------------------------------------------- pause / ownership

    function test_Pause_OwnerOnlyAndEmits() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        market.pause();

        vm.expectEmit(false, false, false, true, address(market));
        emit Pausable.Paused(owner);
        vm.prank(owner);
        market.pause();
        assertTrue(market.paused());

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        market.unpause();

        vm.expectEmit(false, false, false, true, address(market));
        emit Pausable.Unpaused(owner);
        vm.prank(owner);
        market.unpause();
        assertFalse(market.paused());
    }

    function test_RenounceOwnership_AlwaysReverts() public {
        vm.expectRevert(NftMarket.RenounceDisabled.selector);
        vm.prank(owner);
        market.renounceOwnership();
        vm.expectRevert(NftMarket.RenounceDisabled.selector);
        vm.prank(alice);
        market.renounceOwnership();
        assertEq(market.owner(), owner);
    }

    function test_TwoStepOwnershipTransfer() public {
        vm.prank(owner);
        market.transferOwnership(alice);
        assertEq(market.owner(), owner);
        assertEq(market.pendingOwner(), alice);
        vm.prank(alice);
        market.acceptOwnership();
        assertEq(market.owner(), alice);
        vm.prank(alice);
        market.pause();
        assertTrue(market.paused());
    }

    function test_Pause_BlocksListUpdateBuyAndOfferCreation() public {
        listAs(alice, 1, P);
        uint256 id = offerAs(bob, 2, false, P, 1 days);
        uint256 wideId = offerAs(bob, 0, true, P, 1 days);
        vm.prank(owner);
        market.pause();

        bytes4 paused = Pausable.EnforcedPause.selector;
        vm.startPrank(alice);
        vm.expectRevert(paused);
        market.list(address(col), 2, P, 0);
        vm.expectRevert(paused);
        market.updateListing(address(col), 1, P, 0);
        vm.expectRevert(paused);
        market.acceptOffer(id, 2, P);
        vm.expectRevert(paused);
        market.acceptCollectionOffer(wideId, 2, P);
        vm.stopPrank();

        vm.startPrank(bob);
        vm.expectRevert(paused);
        market.buy(address(col), 1, P);
        vm.expectRevert(paused);
        market.makeOffer(address(col), 3, false, P, uint64(block.timestamp + 1 days));
        vm.expectRevert(paused);
        market.updateOffer(id, P * 2, uint64(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function test_Pause_DoesNotBlockCancelReclaimOrWithdrawRoyalty() public {
        // accrue some royalty first
        listAs(alice, 1, P);
        vm.prank(bob);
        market.buy(address(col), 1, P);
        uint256 id = offerAs(bob, 2, false, P, 1 days);
        uint256 id2 = offerAs(carol, 0, true, P, 1 days);
        listAs(alice, 3, P);
        uint256 id3 = offerAs(bob, 4, false, P, 2 days);
        skip(1 days);

        vm.prank(owner);
        market.pause();

        vm.prank(bob);
        market.cancelOffer(id);
        market.reclaimExpiredOffer(id2); // anyone, expired
        vm.prank(alice);
        market.cancelListing(address(col), 3);
        market.withdrawRoyalty(royaltyRecv);

        assertEq(usdc.balanceOf(royaltyRecv), royaltyOf(P));
        assertEq(market.royaltyBalance(royaltyRecv), 0);
        assertEq(market.getOffer(id3).price, P, "unrelated offer untouched");
    }

    // ---------------------------------------------------------------- quote

    function test_Quote_SplitsFeeRoyaltyProceeds() public view {
        (uint256 fee, uint256 royalty, address rcv, uint256 proceeds) = market.quote(address(col), 1, P);
        assertEq(fee, 2_500_000);
        assertEq(royalty, 5_000_000);
        assertEq(rcv, royaltyRecv);
        assertEq(proceeds, 92_500_000);
    }

    function test_Quote_RevertsInvalidPrice() public {
        vm.expectRevert(NftMarket.InvalidPrice.selector);
        market.quote(address(col), 1, 0);
        vm.expectRevert(NftMarket.InvalidPrice.selector);
        market.quote(address(col), 1, 1_500);
    }

    // ---------------------------------------------------------------- unregistered collection

    function test_UnregisteredCollection_RevertsEverywhere() public {
        Params memory p = makeParams(0, 5, 5, T0, T0 + 1 days);
        ArcCollection rogue = new ArcCollection(p, address(usdc), creator);
        vm.startPrank(alice);
        rogue.mint(2);
        rogue.setApprovalForAll(address(market), true);
        vm.expectRevert(NftMarket.NotRegistered.selector);
        market.list(address(rogue), 1, P, 0);
        vm.expectRevert(NftMarket.NotRegistered.selector);
        market.updateListing(address(rogue), 1, P, 0);
        vm.stopPrank();
        vm.startPrank(bob);
        vm.expectRevert(NftMarket.NotRegistered.selector);
        market.buy(address(rogue), 1, P);
        vm.expectRevert(NftMarket.NotRegistered.selector);
        market.makeOffer(address(rogue), 1, false, P, uint64(block.timestamp + 1 days));
        vm.expectRevert(NftMarket.NotRegistered.selector);
        market.makeOffer(address(rogue), 0, true, P, uint64(block.timestamp + 1 days));
        vm.stopPrank();
    }
}
