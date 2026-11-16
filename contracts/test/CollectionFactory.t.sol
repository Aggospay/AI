// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ArcCollection, Params} from "../ArcCollection.sol";
import {CollectionFactory} from "../CollectionFactory.sol";
import {ArcCommon} from "./ArcCommon.t.sol";

contract CollectionFactoryTest is ArcCommon {
    uint64 internal constant START = T0 + 100;
    uint64 internal constant END = T0 + 10 days;

    function test_Constructor_StoresUsdcAndEmits() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectEmit(true, true, false, false, predicted);
        emit CollectionFactory.FactoryConfigured(predicted, address(usdc));
        CollectionFactory f = new CollectionFactory(address(usdc));
        assertEq(f.usdc(), address(usdc));
        assertEq(f.collectionCount(), 0);
    }

    function test_Constructor_RevertsInvalidUsdc() public {
        vm.expectRevert(CollectionFactory.InvalidUsdc.selector);
        new CollectionFactory(address(0));
        vm.expectRevert(CollectionFactory.InvalidUsdc.selector);
        new CollectionFactory(alice);
    }

    function test_CreateCollection_RegistersAndRecordsPayee() public {
        Params memory p = makeParams(5_000, 10, 3, START, END);
        ArcCollection c = createVia(p);
        assertTrue(factory.isCollection(address(c)));
        assertEq(factory.collectionCount(), 1);
        assertEq(factory.collectionAt(0), address(c));
        assertEq(c.payee(), creator, "caller is permanent payee");
        assertEq(address(c.usdc()), address(usdc), "collection uses factory USDC");
        assertEq(c.mintPrice(), 5_000);
        assertEq(c.maxSupply(), 10);
    }

    function test_CreateCollection_EmitsCollectionCreated() public {
        Params memory p = makeParams(5_000, 10, 3, START, END);
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        vm.expectEmit(true, true, false, true, address(factory));
        emit CollectionFactory.CollectionCreated(
            predicted, creator, "Arc Test", "ARCT", 5_000, 10, 3, START, 500, commitmentOf(SECRET), END
        );
        vm.prank(creator);
        factory.createCollection(p);
    }

    function test_CreateCollection_MultipleDistinctAndIndexed() public {
        Params memory p = makeParams(5_000, 10, 3, START, END);
        ArcCollection a = createVia(p);
        vm.prank(alice);
        ArcCollection b = ArcCollection(factory.createCollection(p));
        assertTrue(address(a) != address(b));
        assertEq(factory.collectionCount(), 2);
        assertEq(factory.collectionAt(0), address(a));
        assertEq(factory.collectionAt(1), address(b));
        assertEq(b.payee(), alice);
        assertTrue(factory.isCollection(address(a)) && factory.isCollection(address(b)));
    }

    function test_IsCollection_FalseForUnregistered() public {
        Params memory p = makeParams(5_000, 10, 3, START, END);
        ArcCollection direct = new ArcCollection(p, address(usdc), creator);
        assertFalse(factory.isCollection(address(direct)));
        assertFalse(factory.isCollection(address(0)));
        assertFalse(factory.isCollection(alice));
        assertFalse(factory.isCollection(address(factory)));
    }

    function test_CollectionAt_RevertsOutOfBounds() public {
        vm.expectRevert(abi.encodeWithSelector(CollectionFactory.CollectionIndexOutOfBounds.selector, 0));
        factory.collectionAt(0);
        createVia(makeParams(5_000, 10, 3, START, END));
        vm.expectRevert(abi.encodeWithSelector(CollectionFactory.CollectionIndexOutOfBounds.selector, 1));
        factory.collectionAt(1);
    }

    function test_CreateCollection_BadParamsRevertAndRegisterNothing() public {
        Params memory p = makeParams(5_000, 10, 3, START, START); // mintEnd == mintStart
        vm.expectRevert(ArcCollection.InvalidMintEnd.selector);
        vm.prank(creator);
        factory.createCollection(p);
        assertEq(factory.collectionCount(), 0);
    }

    function testFuzz_CreateCollection_AnyCallerBecomesPayee(address caller) public {
        vm.assume(caller != address(0));
        Params memory p = makeParams(2_000, 7, 2, START, END);
        vm.prank(caller);
        ArcCollection c = ArcCollection(factory.createCollection(p));
        assertEq(c.payee(), caller);
        assertTrue(factory.isCollection(address(c)));
        assertEq(factory.collectionAt(factory.collectionCount() - 1), address(c));
    }
}
