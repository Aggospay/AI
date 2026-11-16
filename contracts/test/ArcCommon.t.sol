// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ArcCollection, Params} from "../ArcCollection.sol";
import {CollectionFactory} from "../CollectionFactory.sol";

/// @dev 6-decimal USDC stand-in with open mint.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Shared fixtures for collection / factory / market suites. No test functions here.
abstract contract ArcCommon is Test {
    MockUSDC internal usdc;
    CollectionFactory internal factory;

    address internal creator = makeAddr("creator");
    address internal royaltyRecv = makeAddr("royaltyRecv");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    bytes32 internal constant SECRET = keccak256("hidden-seed");
    uint64 internal constant T0 = 1_000_000;

    function setUp() public virtual {
        vm.warp(T0);
        usdc = new MockUSDC();
        factory = new CollectionFactory(address(usdc));
    }

    function commitmentOf(bytes32 s) internal pure returns (bytes32) {
        return keccak256(abi.encode(s));
    }

    function makeParams(uint256 price, uint32 maxSupply, uint32 perWallet, uint64 start, uint64 end)
        internal
        view
        returns (Params memory p)
    {
        p = Params({
            name: "Arc Test",
            symbol: "ARCT",
            mintPrice: price,
            maxSupply: maxSupply,
            maxPerWallet: perWallet,
            mintStart: start,
            royaltyReceiver: royaltyRecv,
            royaltyBps: 500,
            baseUri: "ipfs://base/",
            seedCommitment: commitmentOf(SECRET),
            mintEnd: end
        });
    }

    function createVia(Params memory p) internal returns (ArcCollection c) {
        vm.prank(creator);
        c = ArcCollection(factory.createCollection(p));
    }

    function fund(address who, uint256 amount, address spender) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(spender, type(uint256).max);
    }
}
