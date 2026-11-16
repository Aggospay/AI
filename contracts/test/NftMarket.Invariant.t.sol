// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {ArcCollection} from "../ArcCollection.sol";
import {NftMarket} from "../NftMarket.sol";
import {MockUSDC} from "./ArcCommon.t.sol";
import {NftMarketBase} from "./NftMarket.Base.t.sol";

/// @dev Random-walk driver over every market entry point. Reverts are swallowed so state keeps exploring.
contract MarketHandler is Test {
    NftMarket public market;
    ArcCollection public col;
    address public marketOwner;
    address[3] public actors;
    address public royaltyReceiver;
    uint256 public buys;
    uint256 public accepts;
    uint256 public offersMade;
    uint256 public reclaims;

    constructor(NftMarket m, ArcCollection c, address[3] memory a, address owner_, address royaltyRcv) {
        market = m;
        col = c;
        actors = a;
        marketOwner = owner_;
        royaltyReceiver = royaltyRcv;
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % 3];
    }

    function _tok(uint256 t) internal pure returns (uint256) {
        return bound(t, 1, 5);
    }

    function _price(uint256 p) internal pure returns (uint256) {
        return bound(p, 1, 1e6) * 1000; // up to 1000 USDC
    }

    function list(uint256 a, uint256 t, uint256 p, uint256 exp) external {
        uint256 id = _tok(t);
        address who = col.ownerOf(id);
        exp = bound(exp, 0, 3 days);
        vm.prank(who);
        try market.list(address(col), id, _price(p), exp == 0 ? 0 : uint64(block.timestamp + exp)) {} catch {}
        a;
    }

    function updateListing(uint256 t, uint256 p) external {
        uint256 id = _tok(t);
        vm.prank(col.ownerOf(id));
        try market.updateListing(address(col), id, _price(p), 0) {} catch {}
    }

    function cancelListing(uint256 a, uint256 t) external {
        vm.prank(_actor(a));
        try market.cancelListing(address(col), _tok(t)) {} catch {}
    }

    function buy(uint256 a, uint256 t) external {
        vm.prank(_actor(a));
        try market.buy(address(col), _tok(t), type(uint256).max) { ++buys; } catch {}
    }

    function makeOffer(uint256 a, uint256 t, bool wide, uint256 p, uint256 dur) external {
        dur = bound(dur, 1, 30 days);
        vm.prank(_actor(a));
        try market.makeOffer(address(col), _tok(t), wide, _price(p), uint64(block.timestamp + dur)) { ++offersMade; } catch {}
    }

    function _offerId(uint256 s) internal view returns (uint256) {
        uint256 n = market.nextOfferId();
        return n <= 1 ? 0 : bound(s, 1, n - 1);
    }

    function updateOffer(uint256 s, uint256 p, uint256 dur) external {
        uint256 id = _offerId(s);
        if (id == 0) return;
        dur = bound(dur, 1, 30 days);
        vm.prank(market.getOffer(id).bidder);
        try market.updateOffer(id, _price(p), uint64(block.timestamp + dur)) {} catch {}
    }

    function cancelOffer(uint256 s) external {
        uint256 id = _offerId(s);
        if (id == 0) return;
        vm.prank(market.getOffer(id).bidder);
        try market.cancelOffer(id) {} catch {}
    }

    function reclaimExpired(uint256 a, uint256 s) external {
        uint256 id = _offerId(s);
        if (id == 0) return;
        vm.prank(_actor(a));
        try market.reclaimExpiredOffer(id) { ++reclaims; } catch {}
    }

    function acceptOffer(uint256 s, uint256 t, bool collectionOnly) external {
        uint256 id = _offerId(s);
        if (id == 0) return;
        uint256 tok = _tok(t);
        vm.prank(col.ownerOf(tok));
        if (collectionOnly) {
            try market.acceptCollectionOffer(id, tok, 0) { ++accepts; } catch {}
        } else {
            try market.acceptOffer(id, tok, 0) { ++accepts; } catch {}
        }
    }

    function withdrawRoyalty() external {
        try market.withdrawRoyalty(royaltyReceiver) {} catch {}
    }

    function setFee(uint256 bps) external {
        vm.prank(marketOwner);
        market.setFee(uint16(bound(bps, 0, 1000)));
    }

    function togglePause() external {
        vm.prank(marketOwner);
        if (market.paused()) market.unpause();
        else market.pause();
    }

    function warp(uint256 dt) external {
        skip(bound(dt, 0, 5 days));
    }
}

contract NftMarketInvariantTest is NftMarketBase {
    MarketHandler internal handler;

    function setUp() public override {
        super.setUp();
        vm.prank(bob);
        col.setApprovalForAll(address(market), true);
        vm.prank(carol);
        col.setApprovalForAll(address(market), true);
        handler = new MarketHandler(market, col, [alice, bob, carol], owner, royaltyRecv);
        targetContract(address(handler));
    }

    /// Sanity: the random walk must actually reach settlement paths (otherwise invariants are vacuous).
    function afterInvariant() public view {
        console2.log("buys", handler.buys());
        console2.log("accepts", handler.accepts());
        console2.log("offersMade", handler.offersMade());
        console2.log("reclaims", handler.reclaims());
    }

    /// Market USDC == Σ active offer escrow + royalty credits owed (fees are paid out immediately).
    function invariant_MarketBalanceEqualsEscrowPlusRoyalty() public view {
        uint256 escrow;
        uint256 n = market.nextOfferId();
        for (uint256 id = 1; id < n; ++id) {
            escrow += market.getOffer(id).price;
        }
        assertEq(usdc.balanceOf(address(market)), escrow + market.royaltyBalance(royaltyRecv));
    }

    /// No USDC is created or destroyed or stranded outside known holders.
    function invariant_UsdcSupplyAccountedFor() public view {
        uint256 sum = usdc.balanceOf(alice) + usdc.balanceOf(bob) + usdc.balanceOf(carol) + usdc.balanceOf(feeTo)
            + usdc.balanceOf(royaltyRecv) + usdc.balanceOf(address(market)) + usdc.balanceOf(creator);
        assertEq(sum, usdc.totalSupply());
    }

    /// Market is noncustodial for NFTs, and fee stays within the hard cap.
    function invariant_NoNftCustodyAndFeeCapped() public view {
        assertEq(col.balanceOf(address(market)), 0);
        assertLe(market.feeBps(), market.MAX_FEE_BPS());
        assertEq(market.owner(), owner);
    }

    /// A consumed/cancelled offer always has zeroed price; live offers always have valid tick price.
    function invariant_OfferPricesAreTickAligned() public view {
        uint256 n = market.nextOfferId();
        for (uint256 id = 1; id < n; ++id) {
            uint256 p = market.getOffer(id).price;
            assertEq(p % market.PRICE_TICK(), 0);
        }
    }
}
