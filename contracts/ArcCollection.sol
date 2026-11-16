// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Permanent collection configuration shared with CollectionFactory.
/// @dev mintEnd must be after mintStart and at most 90 days later.
struct Params {
    string name;
    string symbol;
    uint256 mintPrice;
    uint32 maxSupply;
    uint32 maxPerWallet;
    uint64 mintStart;
    address royaltyReceiver;
    uint96 royaltyBps;
    string baseUri;
    bytes32 seedCommitment;
    uint64 mintEnd;
}

/// @title ArcCollection
/// @notice Immutable-configuration NFT collection paid exclusively in constructor-supplied USDC.
/// @dev Intended for Solidity 0.8.28, Cancun and OpenZeppelin 5.6.1. No owner or admin surface.
///      A hidden seed makes traits unknowable to minters until reveal; the creator knows its
///      preimage in advance, as with any pre-generated collection. Fallback uses a public seed.
contract ArcCollection is ERC721, ERC2981, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    IERC20 public immutable usdc;
    address public immutable payee;
    uint256 public immutable mintPrice;
    uint32 public immutable maxSupply;
    uint32 public immutable maxPerWallet;
    uint64 public immutable mintStart;
    uint64 public immutable mintEnd;
    string private _baseTokenURI;
    uint256 public totalMinted;
    mapping(address minter => uint256 quantity) public mintedBy;
    bytes32 public immutable seedCommitment;
    bytes32 public seed;
    bool public revealed;
    uint256 public constant REVEAL_FALLBACK_DELAY = 7 days;

    error InvalidAddress();
    error InvalidSupply();
    error InvalidMintPrice();
    error InvalidMintEnd();
    error InvalidRoyalty();
    error MintNotStarted();
    error InvalidQuantity();
    error SupplyExceeded();
    error WalletLimitExceeded();
    error InvalidSeedCommitment();
    error InvalidSeed();
    error AlreadyRevealed();
    error RevealNotReady();
    error MintClosed();
    error NotRevealed();

    event Minted(address indexed minter, uint256 indexed tokenId);
    event Revealed(bytes32 seed, bool fallbackSeed);
    event CollectionConfigured(
        address indexed collection, address indexed usdc, address indexed payee,
        uint256 mintPrice, uint32 maxSupply, uint32 maxPerWallet, uint64 mintStart,
        address royaltyReceiver, uint96 royaltyBps, string baseUri
    );

    /// @notice Configures permanent mint terms, metadata prefix and default royalty.
    /// @dev Prices use 6-decimal USDC units; zero-price minting is permitted.
    ///      params.mintEnd must be after params.mintStart and at most 90 days later.
    constructor(Params memory params, address usdc_, address payee_) ERC721(params.name, params.symbol) {
        if (usdc_ == address(0) || usdc_.code.length == 0 || payee_ == address(0)) revert InvalidAddress();
        if (params.maxSupply == 0 || params.maxPerWallet == 0) revert InvalidSupply();
        if (params.mintPrice % 1000 != 0) revert InvalidMintPrice();
        if (params.royaltyReceiver == address(0) || params.royaltyBps > 1000) revert InvalidRoyalty();
        if (params.seedCommitment == bytes32(0)) revert InvalidSeedCommitment();
        if (params.mintEnd <= params.mintStart || uint256(params.mintEnd) > uint256(params.mintStart) + 90 days) {
            revert InvalidMintEnd();
        }
        usdc = IERC20(usdc_);
        payee = payee_;
        mintPrice = params.mintPrice;
        maxSupply = params.maxSupply;
        maxPerWallet = params.maxPerWallet;
        mintStart = params.mintStart;
        mintEnd = params.mintEnd;
        _baseTokenURI = params.baseUri;
        seedCommitment = params.seedCommitment;
        _setDefaultRoyalty(params.royaltyReceiver, params.royaltyBps);
        emit CollectionConfigured(
            address(this), usdc_, payee_, params.mintPrice, params.maxSupply, params.maxPerWallet, params.mintStart,
            params.royaltyReceiver, params.royaltyBps, params.baseUri
        );
    }

    /// @notice Mints quantity tokens to the caller before mintEnd, paying the payee directly.
    /// @dev Uses _mint deliberately: smart-contract callers must be able to manage ERC721s.
    ///      Minting closes at mintEnd, on reveal or on sellout.
    function mint(uint32 quantity) external nonReentrant {
        if (revealed || block.timestamp >= mintEnd) revert MintClosed();
        if (block.timestamp < mintStart) revert MintNotStarted();
        if (totalMinted == maxSupply) revert SupplyExceeded();
        if (quantity == 0) revert InvalidQuantity();
        uint256 firstId = totalMinted + 1;
        uint256 newTotal = totalMinted + quantity;
        uint256 newWalletTotal = mintedBy[msg.sender] + quantity;
        if (newTotal > maxSupply) revert SupplyExceeded();
        if (newWalletTotal > maxPerWallet) revert WalletLimitExceeded();
        totalMinted = newTotal;
        mintedBy[msg.sender] = newWalletTotal;
        uint256 payment = mintPrice * quantity;
        if (payment != 0) usdc.safeTransferFrom(msg.sender, payee, payment);
        for (uint256 tokenId = firstId; tokenId <= newTotal; ++tokenId) {
            _mint(msg.sender, tokenId);
            emit Minted(msg.sender, tokenId);
        }
    }

    /// @notice Reveals the committed seed only after sellout or once mintEnd is reached.
    function reveal(bytes32 _seed) external {
        if (revealed) revert AlreadyRevealed();
        if (keccak256(abi.encode(_seed)) != seedCommitment) revert InvalidSeed();
        if (totalMinted != maxSupply && block.timestamp < mintEnd) revert RevealNotReady();
        seed = _seed;
        revealed = true;
        emit Revealed(_seed, false);
    }

    /// @notice Uses the public commitment as the seed seven days after mintEnd.
    function revealFallback() external {
        if (revealed) revert AlreadyRevealed();
        if (block.timestamp < uint256(mintEnd) + REVEAL_FALLBACK_DELAY) revert RevealNotReady();
        seed = seedCommitment;
        revealed = true;
        emit Revealed(seedCommitment, true);
    }

    /// @notice Returns background/body/accessory/aura in low-to-high bytes; reverts if unrevealed or nonexistent.
    function traitsOf(uint256 tokenId) external view returns (uint32) {
        if (!revealed || _ownerOf(tokenId) == address(0)) revert NotRevealed();
        uint32 packed;
        for (uint256 slot; slot < 4; ++slot) {
            uint256 roll = uint256(keccak256(abi.encode(seed, tokenId, slot))) % 100;
            uint32 index = roll < 50 ? 0 : roll < 75 ? 1 : roll < 90 ? 2 : roll < 97 ? 3 : 4;
            packed |= index << (slot * 8);
        }
        return packed;
    }

    /// @notice Returns the permanent prefix concatenated with the decimal token ID.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_baseTokenURI, tokenId.toString());
    }

    /// @inheritdoc ERC721
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
