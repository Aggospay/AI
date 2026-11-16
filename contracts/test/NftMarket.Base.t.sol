// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ArcCollection} from "../ArcCollection.sol";
import {NftMarket} from "../NftMarket.sol";
import {ArcCommon} from "./ArcCommon.t.sol";

/// @dev Shared market fixture. No test functions.
///      alice owns tokens 1..5 and approved the market for all; bob/carol are funded bidders.
abstract contract NftMarketBase is ArcCommon {
    NftMarket internal market;
    ArcCollection internal col;

    address internal owner = makeAddr("marketOwner");
    address internal feeTo = makeAddr("feeTo");

    uint16 internal constant FEE_BPS = 250; // 2.5%
    uint256 internal constant ROYALTY_BPS = 500; // 5% (from makeParams)
    uint256 internal constant P = 100e6; // 100 USDC

    function setUp() public virtual override {
        super.setUp();
        market = new NftMarket(address(usdc), address(factory), feeTo, FEE_BPS, owner);
        col = createVia(makeParams(0, 50, 50, T0, T0 + 30 days));
        vm.prank(alice);
        col.mint(5);
        vm.prank(alice);
        col.setApprovalForAll(address(market), true);
        fund(bob, 1_000_000e6, address(market));
        fund(carol, 1_000_000e6, address(market));
        fund(alice, 1_000_000e6, address(market));
    }

    // price helpers: exact expected split at FEE_BPS / ROYALTY_BPS
    function feeOf(uint256 price) internal pure returns (uint256) {
        return price * FEE_BPS / 10_000;
    }

    function royaltyOf(uint256 price) internal pure returns (uint256) {
        return price * ROYALTY_BPS / 10_000;
    }

    function proceedsOf(uint256 price) internal pure returns (uint256) {
        return price - feeOf(price) - royaltyOf(price);
    }

    function listAs(address who, uint256 tokenId, uint256 price) internal {
        vm.prank(who);
        market.list(address(col), tokenId, price, 0);
    }

    function offerAs(address who, uint256 tokenId, bool wide, uint256 price, uint256 duration)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        id = market.makeOffer(address(col), tokenId, wide, price, uint64(block.timestamp + duration));
    }
}
