// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ArcCollection, Params} from "../ArcCollection.sol";
import {ArcCommon} from "./ArcCommon.t.sol";

/// @dev Contract caller with no ERC721 receiver hook: mint must still succeed (uses _mint).
contract MintProxy {
    function doMint(ArcCollection c, uint32 q) external {
        c.mint(q);
    }
}

contract ArcCollectionTest is ArcCommon {
    ArcCollection internal c;

    uint64 internal constant START = T0 + 100;
    uint64 internal constant END = T0 + 10 days;
    uint256 internal constant PRICE = 5_000; // 0.005 USDC

    function setUp() public override {
        super.setUp();
        c = createVia(makeParams(PRICE, 10, 3, START, END));
        fund(alice, 1_000_000, address(c));
        fund(bob, 1_000_000, address(c));
    }

    function _open() internal {
        vm.warp(START);
    }

    // ---------------------------------------------------------------- constructor

    function test_ConstructorStoresConfig() public view {
        assertEq(address(c.usdc()), address(usdc));
        assertEq(c.payee(), creator);
        assertEq(c.mintPrice(), PRICE);
        assertEq(c.maxSupply(), 10);
        assertEq(c.maxPerWallet(), 3);
        assertEq(c.mintStart(), START);
        assertEq(c.mintEnd(), END);
        assertEq(c.seedCommitment(), commitmentOf(SECRET));
        assertEq(c.totalMinted(), 0);
        assertFalse(c.revealed());
        assertEq(c.name(), "Arc Test");
        assertEq(c.symbol(), "ARCT");
        (address rcv, uint256 amt) = c.royaltyInfo(1, 1_000_000);
        assertEq(rcv, royaltyRecv);
        assertEq(amt, 50_000);
    }

    function test_ConstructorEmitsConfigured() public {
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        Params memory p = makeParams(PRICE, 10, 3, START, END);
        vm.expectEmit(true, true, true, true, predicted);
        emit ArcCollection.CollectionConfigured(
            predicted, address(usdc), creator, PRICE, 10, 3, START, royaltyRecv, 500, "ipfs://base/"
        );
        vm.prank(creator);
        factory.createCollection(p);
    }

    function test_Constructor_MintEndAtExactly90DaysOk() public {
        Params memory p = makeParams(PRICE, 10, 3, START, START + 90 days);
        new ArcCollection(p, address(usdc), creator);
    }

    function test_Constructor_RevertsInvalidAddress() public {
        Params memory p = makeParams(PRICE, 10, 3, START, END);
        vm.expectRevert(ArcCollection.InvalidAddress.selector);
        new ArcCollection(p, address(0), creator);
        vm.expectRevert(ArcCollection.InvalidAddress.selector);
        new ArcCollection(p, alice, creator); // EOA, no code
        vm.expectRevert(ArcCollection.InvalidAddress.selector);
        new ArcCollection(p, address(usdc), address(0));
    }

    function test_Constructor_RevertsInvalidSupply() public {
        Params memory p = makeParams(PRICE, 0, 3, START, END);
        vm.expectRevert(ArcCollection.InvalidSupply.selector);
        new ArcCollection(p, address(usdc), creator);
        p = makeParams(PRICE, 10, 0, START, END);
        vm.expectRevert(ArcCollection.InvalidSupply.selector);
        new ArcCollection(p, address(usdc), creator);
    }

    function test_Constructor_RevertsInvalidMintPrice() public {
        Params memory p = makeParams(1_001, 10, 3, START, END);
        vm.expectRevert(ArcCollection.InvalidMintPrice.selector);
        new ArcCollection(p, address(usdc), creator);
    }

    function test_Constructor_RevertsInvalidRoyalty() public {
        Params memory p = makeParams(PRICE, 10, 3, START, END);
        p.royaltyBps = 1001;
        vm.expectRevert(ArcCollection.InvalidRoyalty.selector);
        new ArcCollection(p, address(usdc), creator);
        p.royaltyBps = 1000;
        p.royaltyReceiver = address(0);
        vm.expectRevert(ArcCollection.InvalidRoyalty.selector);
        new ArcCollection(p, address(usdc), creator);
    }

    function test_Constructor_RevertsInvalidSeedCommitment() public {
        Params memory p = makeParams(PRICE, 10, 3, START, END);
        p.seedCommitment = bytes32(0);
        vm.expectRevert(ArcCollection.InvalidSeedCommitment.selector);
        new ArcCollection(p, address(usdc), creator);
    }

    function test_Constructor_RevertsInvalidMintEnd() public {
        Params memory p = makeParams(PRICE, 10, 3, START, START);
        vm.expectRevert(ArcCollection.InvalidMintEnd.selector);
        new ArcCollection(p, address(usdc), creator);
        p = makeParams(PRICE, 10, 3, START, START - 1);
        vm.expectRevert(ArcCollection.InvalidMintEnd.selector);
        new ArcCollection(p, address(usdc), creator);
        p = makeParams(PRICE, 10, 3, START, START + 90 days + 1);
        vm.expectRevert(ArcCollection.InvalidMintEnd.selector);
        new ArcCollection(p, address(usdc), creator);
    }

    // ---------------------------------------------------------------- mint

    function test_Mint_HappyPathPaysPayeeDirectly() public {
        _open();
        uint256 payeeBefore = usdc.balanceOf(creator);
        vm.prank(alice);
        c.mint(2);
        assertEq(c.ownerOf(1), alice);
        assertEq(c.ownerOf(2), alice);
        assertEq(c.balanceOf(alice), 2);
        assertEq(c.totalMinted(), 2);
        assertEq(c.mintedBy(alice), 2);
        assertEq(usdc.balanceOf(creator), payeeBefore + 2 * PRICE);
        assertEq(usdc.balanceOf(alice), 1_000_000 - 2 * PRICE);
        assertEq(usdc.balanceOf(address(c)), 0, "collection never custodies USDC");
    }

    function test_Mint_EmitsMintedPerToken() public {
        _open();
        vm.expectEmit(true, true, false, false, address(c));
        emit ArcCollection.Minted(alice, 1);
        vm.expectEmit(true, true, false, false, address(c));
        emit ArcCollection.Minted(alice, 2);
        vm.prank(alice);
        c.mint(2);
    }

    function test_Mint_TokenIdsContinueAcrossMinters() public {
        _open();
        vm.prank(alice);
        c.mint(1);
        vm.prank(bob);
        c.mint(2);
        assertEq(c.ownerOf(1), alice);
        assertEq(c.ownerOf(2), bob);
        assertEq(c.ownerOf(3), bob);
    }

    function test_Mint_RevertsBeforeStart() public {
        vm.expectRevert(ArcCollection.MintNotStarted.selector);
        vm.prank(alice);
        c.mint(1);
        vm.warp(START - 1);
        vm.expectRevert(ArcCollection.MintNotStarted.selector);
        vm.prank(alice);
        c.mint(1);
    }

    function test_Mint_SucceedsAtExactStartAndLastSecond() public {
        vm.warp(START);
        vm.prank(alice);
        c.mint(1);
        vm.warp(END - 1);
        vm.prank(bob);
        c.mint(1);
        assertEq(c.totalMinted(), 2);
    }

    function test_Mint_RevertsAtMintEnd() public {
        vm.warp(END);
        vm.expectRevert(ArcCollection.MintClosed.selector);
        vm.prank(alice);
        c.mint(1);
        vm.warp(END + 1 days);
        vm.expectRevert(ArcCollection.MintClosed.selector);
        vm.prank(alice);
        c.mint(1);
    }

    function test_Mint_RevertsZeroQuantity() public {
        _open();
        vm.expectRevert(ArcCollection.InvalidQuantity.selector);
        vm.prank(alice);
        c.mint(0);
    }

    function test_Mint_RevertsWalletLimit() public {
        _open();
        vm.startPrank(alice);
        c.mint(3);
        vm.expectRevert(ArcCollection.WalletLimitExceeded.selector);
        c.mint(1);
        vm.stopPrank();
        // a single oversized request is rejected too
        vm.expectRevert(ArcCollection.WalletLimitExceeded.selector);
        vm.prank(bob);
        c.mint(4);
    }

    function test_Mint_SelloutClosesMintAndRevertsSupplyExceeded() public {
        _open();
        address[4] memory who = [alice, bob, carol, makeAddr("dave")];
        uint256 n;
        for (uint256 i; i < 4 && c.totalMinted() < 10; ++i) {
            fund(who[i], 1_000_000, address(c));
            uint32 q = uint32(10 - c.totalMinted() > 3 ? 3 : 10 - c.totalMinted());
            vm.prank(who[i]);
            c.mint(q);
            n += q;
        }
        assertEq(n, 10);
        assertEq(c.totalMinted(), 10);
        address erin = makeAddr("erin");
        fund(erin, 1_000_000, address(c));
        vm.expectRevert(ArcCollection.SupplyExceeded.selector);
        vm.prank(erin);
        c.mint(1);
    }

    function test_Mint_RevertsWhenRequestExceedsRemainingSupply() public {
        _open();
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            fund(who[i], 1_000_000, address(c));
            vm.prank(who[i]);
            c.mint(3);
        }
        assertEq(c.totalMinted(), 9);
        address dave = makeAddr("dave");
        fund(dave, 1_000_000, address(c));
        vm.expectRevert(ArcCollection.SupplyExceeded.selector);
        vm.prank(dave);
        c.mint(2);
        vm.prank(dave);
        c.mint(1);
        assertEq(c.totalMinted(), 10);
    }

    function test_Mint_RevertsWithoutAllowanceOrBalance() public {
        _open();
        address eve = makeAddr("eve");
        vm.expectRevert();
        vm.prank(eve);
        c.mint(1);
        assertEq(c.totalMinted(), 0);
    }

    function test_Mint_ZeroPriceCollectionNeedsNoUsdc() public {
        ArcCollection free = createVia(makeParams(0, 5, 5, START, END));
        _open();
        address eve = makeAddr("eve");
        vm.prank(eve);
        free.mint(5);
        assertEq(free.balanceOf(eve), 5);
    }

    function test_Mint_SmartContractCallerWithoutReceiverHook() public {
        ArcCollection free = createVia(makeParams(0, 5, 5, START, END));
        _open();
        MintProxy proxy = new MintProxy();
        proxy.doMint(free, 2);
        assertEq(free.balanceOf(address(proxy)), 2);
    }

    // ---------------------------------------------------------------- misc views

    function test_TokenURI_ConcatenatesPrefixAndId() public {
        _open();
        vm.prank(alice);
        c.mint(1);
        assertEq(c.tokenURI(1), "ipfs://base/1");
    }

    function test_TokenURI_RevertsForNonexistent() public {
        vm.expectRevert();
        c.tokenURI(1);
    }

    function test_SupportsInterfaces() public view {
        assertTrue(c.supportsInterface(type(IERC721).interfaceId));
        assertTrue(c.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(c.supportsInterface(type(IERC165).interfaceId));
        assertFalse(c.supportsInterface(0xffffffff));
    }
}
