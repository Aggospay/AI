// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {NftMarket} from "../NftMarket.sol";
import {MockUSDC} from "./ArcCommon.t.sol";

contract MockRegistry {
    mapping(address => bool) public isCollection;

    function set(address c, bool v) external {
        isCollection[c] = v;
    }
}

/// @dev ERC721 with a fully configurable (possibly hostile) ERC2981 royaltyInfo.
contract MockRoyaltyNFT is ERC721 {
    address public rcv;
    uint256 public bps;
    bool public broken;

    constructor() ERC721("Mock", "MCK") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function configure(address rcv_, uint256 bps_, bool broken_) external {
        rcv = rcv_;
        bps = bps_;
        broken = broken_;
    }

    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) {
        require(!broken, "broken");
        return (rcv, price * bps / 10_000);
    }
}

/// @dev Hostile / unusual ERC2981 behaviour and registry-revocation paths.
contract NftMarketEdgeTest is Test {
    MockUSDC internal usdc;
    MockRegistry internal reg;
    MockRoyaltyNFT internal nft;
    NftMarket internal market;

    address internal owner = makeAddr("owner");
    address internal feeTo = makeAddr("feeTo");
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal rcv = makeAddr("rcv");

    uint256 internal constant P = 100e6;

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        reg = new MockRegistry();
        nft = new MockRoyaltyNFT();
        market = new NftMarket(address(usdc), address(reg), feeTo, 250, owner);
        reg.set(address(nft), true);
        nft.mint(seller, 1);
        nft.mint(seller, 2);
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(market), type(uint256).max);
    }

    function _buyAndCheck(uint256 expectRoyalty) internal {
        vm.prank(seller);
        market.list(address(nft), 1, P, 0);
        uint256 sellerBefore = usdc.balanceOf(seller);
        vm.prank(buyer);
        market.buy(address(nft), 1, P);
        assertEq(market.royaltyBalance(rcv), expectRoyalty);
        assertEq(usdc.balanceOf(feeTo), P * 250 / 10_000);
        assertEq(usdc.balanceOf(seller) - sellerBefore, P - P * 250 / 10_000 - expectRoyalty);
        assertEq(usdc.balanceOf(address(market)), expectRoyalty);
    }

    function test_Royalty_CappedAtTenPercent() public {
        nft.configure(rcv, 5_000, false); // collection claims 50%
        _buyAndCheck(P * 1000 / 10_000);
    }

    function test_Royalty_BelowCapPassesThrough() public {
        nft.configure(rcv, 300, false);
        _buyAndCheck(P * 300 / 10_000);
    }

    function test_Royalty_ZeroReceiverMeansNoRoyalty() public {
        nft.configure(address(0), 500, false);
        _buyAndCheck(0);
    }

    function test_Royalty_MarketAsReceiverMeansNoRoyalty() public {
        nft.configure(address(market), 500, false);
        vm.prank(seller);
        market.list(address(nft), 1, P, 0);
        vm.prank(buyer);
        market.buy(address(nft), 1, P);
        assertEq(market.royaltyBalance(address(market)), 0);
        assertEq(usdc.balanceOf(address(market)), 0);
    }

    function test_Royalty_RevertingRoyaltyInfoMeansNoRoyalty() public {
        nft.configure(rcv, 500, true);
        _buyAndCheck(0);
    }

    function test_Royalty_OnOfferAcceptCappedAndAccrued() public {
        nft.configure(rcv, 5_000, false);
        vm.prank(buyer);
        uint256 id = market.makeOffer(address(nft), 1, false, P, uint64(block.timestamp + 1 days));
        vm.prank(seller);
        market.acceptOffer(id, 1, P);
        assertEq(market.royaltyBalance(rcv), P * 1000 / 10_000);
        market.withdrawRoyalty(rcv);
        assertEq(usdc.balanceOf(rcv), P * 1000 / 10_000);
        assertEq(usdc.balanceOf(address(market)), 0);
    }

    function test_RegistryRevocation_BlocksExecutionButNotExits() public {
        nft.configure(rcv, 500, false);
        vm.prank(seller);
        market.list(address(nft), 1, P, 0);
        vm.prank(buyer);
        uint256 id = market.makeOffer(address(nft), 2, false, P, uint64(block.timestamp + 1 days));

        reg.set(address(nft), false);

        vm.expectRevert(NftMarket.NotRegistered.selector);
        vm.prank(buyer);
        market.buy(address(nft), 1, P);
        vm.expectRevert(NftMarket.NotRegistered.selector);
        vm.prank(seller);
        market.acceptOffer(id, 2, P);
        vm.expectRevert(NftMarket.NotRegistered.selector);
        vm.prank(buyer);
        market.updateOffer(id, P * 2, uint64(block.timestamp + 1 days));

        // exits always work
        vm.prank(seller);
        market.cancelListing(address(nft), 1);
        uint256 before = usdc.balanceOf(buyer);
        vm.prank(buyer);
        market.cancelOffer(id);
        assertEq(usdc.balanceOf(buyer) - before, P);
    }
}
