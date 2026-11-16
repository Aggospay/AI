// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ArcCollection, Params} from "./ArcCollection.sol";

/// @title CollectionFactory
/// @notice Permissionless registry of immutable ArcCollection deployments sharing one USDC token.
/// @dev Intended for Solidity 0.8.28, Cancun and OpenZeppelin 5.6.1.
contract CollectionFactory {
    address public immutable usdc;
    mapping(address collection => bool registered) public isCollection;
    address[] private _collections;

    error InvalidUsdc();
    error CollectionIndexOutOfBounds(uint256 index);

    event FactoryConfigured(address indexed factory, address indexed usdc);
    event CollectionCreated(
        address indexed collection, address indexed creator, string name, string symbol,
        uint256 mintPrice, uint32 maxSupply, uint32 maxPerWallet, uint64 mintStart, uint96 royaltyBps, bytes32 seedCommitment,
        uint64 mintEnd
    );

    /// @notice Fixes the ERC20 payment token for every collection created here.
    constructor(address usdc_) {
        if (usdc_ == address(0) || usdc_.code.length == 0) revert InvalidUsdc();
        usdc = usdc_;
        emit FactoryConfigured(address(this), usdc_);
    }

    /// @notice Deploys and registers a collection with the caller as its permanent mint payee.
    /// @dev Royalty receiver and metadata prefix are also emitted by the collection constructor.
    ///      params.mintEnd must be after params.mintStart and at most 90 days later.
    function createCollection(Params memory params) external returns (address collection) {
        collection = address(new ArcCollection(params, usdc, msg.sender));
        isCollection[collection] = true;
        _collections.push(collection);
        emit CollectionCreated(
            collection, msg.sender, params.name, params.symbol, params.mintPrice, params.maxSupply,
            params.maxPerWallet, params.mintStart, params.royaltyBps, params.seedCommitment, params.mintEnd
        );
    }

    /// @notice Number of collections created through this factory.
    function collectionCount() external view returns (uint256) {
        return _collections.length;
    }

    /// @notice Registered collection at a zero-based creation index.
    function collectionAt(uint256 index) external view returns (address) {
        if (index >= _collections.length) revert CollectionIndexOutOfBounds(index);
        return _collections[index];
    }
}
