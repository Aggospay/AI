// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Registry interface implemented by CollectionFactory.
interface IArcCollectionRegistry {
    function isCollection(address collection) external view returns (bool);
}

/// @title NftMarket
/// @notice USDC-only, registry-gated noncustodial listings and escrowed NFT offers.
/// @dev Intended for Solidity 0.8.28, Cancun and OpenZeppelin 5.6.1. The configured
///      payment token must be genuine, non-rebasing, non-fee-on-transfer 6-decimal USDC.
///      Expiry is exclusive: an order expires when block.timestamp >= expiry.
contract NftMarket is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PRICE_TICK = 1000;
    uint16 public constant MAX_FEE_BPS = 1000;
    uint16 public constant MAX_ROYALTY_BPS = 1000;
    uint256 public constant MAX_OFFER_DURATION = 30 days;

    IERC20 public immutable usdc;
    IArcCollectionRegistry public immutable registry;
    address public feeRecipient;
    uint16 public feeBps;
    uint256 public nextOfferId = 1;

    struct Listing {
        address seller;
        uint128 price;
        uint64 expiry;
    }

    struct Offer {
        address bidder;
        address collection;
        uint256 tokenId;
        bool collectionWide;
        uint128 price;
        uint64 expiry;
    }

    mapping(address collection => mapping(uint256 tokenId => Listing)) public listings;
    mapping(uint256 offerId => Offer) public offers;
    mapping(address => uint256) public royaltyBalance;

    error InvalidAddress();
    error InvalidFee();
    error InvalidPrice();
    error InvalidExpiry();
    error NotRegistered();
    error NotTokenOwner();
    error NotApproved();
    error ListingNotFound();
    error ListingExpired();
    error NotSeller();
    error ListingNotStale();
    error PriceAboveMax();
    error PriceBelowMin();
    error SelfTrade();
    error OfferNotFound();
    error OfferExpired();
    error OfferNotExpired();
    error NotBidder();
    error TokenMismatch();
    error NotCollectionOffer();
    error RenounceDisabled();

    event MarketConfigured(
        address indexed usdc, address indexed registry, address indexed owner,
        address feeRecipient, uint16 feeBps
    );
    event FeeUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event Listed(address indexed collection, uint256 indexed tokenId, address indexed seller, uint128 price, uint64 expiry);
    event ListingUpdated(
        address indexed collection, uint256 indexed tokenId, address indexed seller,
        uint128 oldPrice, uint128 newPrice, uint64 newExpiry
    );
    event ListingCancelled(address indexed collection, uint256 indexed tokenId, address indexed seller, bool byAnyone);
    event Sale(
        address indexed collection, uint256 indexed tokenId, address indexed seller,
        address buyer, uint256 price, uint256 fee, uint256 royalty, uint8 kind
    );
    event OfferMade(
        uint256 indexed offerId, address indexed collection, address indexed bidder,
        uint256 tokenId, bool collectionWide, uint128 price, uint64 expiry
    );
    event OfferUpdated(uint256 indexed offerId, uint128 oldPrice, uint128 newPrice, uint64 newExpiry);
    event OfferCancelled(uint256 indexed offerId, address bidder, uint256 refund, bool expiredReclaim);
    event RoyaltyWithdrawn(address indexed receiver, uint256 amount);
    /// @notice Identifies consumed escrow explicitly, in addition to the resulting Sale event.
    event OfferAccepted(
        uint256 indexed offerId, address indexed collection, uint256 indexed tokenId,
        address seller, address bidder, uint256 price
    );

    /// @notice Fixes the payment token and registry; initializes bounded fees and two-step ownership.
    constructor(address usdc_, address registry_, address feeRecipient_, uint16 feeBps_, address owner_)
        Ownable(owner_)
    {
        if (
            usdc_ == address(0) || usdc_.code.length == 0 || registry_ == address(0)
                || registry_.code.length == 0 || feeRecipient_ == address(0) || feeRecipient_ == address(this)
        ) revert InvalidAddress();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();
        usdc = IERC20(usdc_);
        registry = IArcCollectionRegistry(registry_);
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        emit MarketConfigured(usdc_, registry_, owner_, feeRecipient_, feeBps_);
    }

    /// @notice Sets the fee charged at execution time, including for existing orders.
    function setFee(uint16 newFeeBps) external onlyOwner nonReentrant {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFee();
        uint16 oldFee = feeBps;
        feeBps = newFeeBps;
        emit FeeUpdated(oldFee, newFeeBps);
    }

    /// @notice Changes the destination of future protocol fees.
    function setFeeRecipient(address newRecipient) external onlyOwner nonReentrant {
        if (newRecipient == address(0) || newRecipient == address(this)) revert InvalidAddress();
        address oldRecipient = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(oldRecipient, newRecipient);
    }

    /// @notice Stops order creation, modification and execution; cancellations remain available.
    function pause() external onlyOwner nonReentrant { _pause(); }

    /// @notice Resumes order creation, modification and execution.
    function unpause() external onlyOwner nonReentrant { _unpause(); }

    /// @notice Ownership renunciation is disabled to preserve the ability to unpause.
    function renounceOwnership() public override {
        revert RenounceDisabled();
    }

    /// @notice Anyone may withdraw accrued royalties to their receiver, even while paused.
    function withdrawRoyalty(address receiver) external nonReentrant {
        uint256 amount = royaltyBalance[receiver];
        royaltyBalance[receiver] = 0;
        usdc.safeTransfer(receiver, amount);
        emit RoyaltyWithdrawn(receiver, amount);
    }

    /// @notice Lists an owned, approved NFT without transferring custody.
    /// @dev A current owner may replace an obsolete prior owner's listing.
    function list(address collection, uint256 tokenId, uint256 price, uint64 expiry)
        external whenNotPaused nonReentrant
    {
        _requireRegistered(collection);
        uint128 checkedPrice = _checkedPrice(price);
        _checkListingExpiry(expiry);
        _requireOwnerAndApproval(collection, tokenId, msg.sender);
        Listing memory previous = listings[collection][tokenId];
        listings[collection][tokenId] = Listing(msg.sender, checkedPrice, expiry);
        if (previous.price != 0 && previous.seller != msg.sender) {
            emit ListingCancelled(collection, tokenId, previous.seller, true);
        }
        emit Listed(collection, tokenId, msg.sender, checkedPrice, expiry);
    }

    /// @notice Updates an unexpired listing while the caller still owns and approves the NFT.
    function updateListing(address collection, uint256 tokenId, uint256 newPrice, uint64 newExpiry)
        external whenNotPaused nonReentrant
    {
        _requireRegistered(collection);
        Listing memory previous = _activeListing(collection, tokenId);
        if (previous.seller != msg.sender) revert NotSeller();
        _requireOwnerAndApproval(collection, tokenId, msg.sender);
        uint128 checkedPrice = _checkedPrice(newPrice);
        _checkListingExpiry(newExpiry);
        listings[collection][tokenId] = Listing(msg.sender, checkedPrice, newExpiry);
        emit ListingUpdated(collection, tokenId, msg.sender, previous.price, checkedPrice, newExpiry);
    }

    /// @notice Seller can always cancel; others may remove expired, unowned or unapproved listings.
    function cancelListing(address collection, uint256 tokenId) external nonReentrant {
        Listing memory listing = listings[collection][tokenId];
        if (listing.price == 0) revert ListingNotFound();
        bool byAnyone = msg.sender != listing.seller;
        if (byAnyone && !_isStale(collection, tokenId, listing)) revert ListingNotStale();
        delete listings[collection][tokenId];
        emit ListingCancelled(collection, tokenId, listing.seller, byAnyone);
    }

    /// @notice Buys a listing for exactly its price subject to the caller's maximum price.
    function buy(address collection, uint256 tokenId, uint256 maxPrice)
        external whenNotPaused nonReentrant
    {
        _requireRegistered(collection);
        Listing memory listing = _activeListing(collection, tokenId);
        if (listing.price > maxPrice) revert PriceAboveMax();
        if (listing.seller == msg.sender) revert SelfTrade();
        _requireOwnerAndApproval(collection, tokenId, listing.seller);
        delete listings[collection][tokenId];
        usdc.safeTransferFrom(msg.sender, address(this), listing.price);
        (uint256 fee, uint256 royalty) = _settle(collection, tokenId, listing.price, listing.seller);
        IERC721(collection).safeTransferFrom(listing.seller, msg.sender, tokenId);
        emit Sale(collection, tokenId, listing.seller, msg.sender, listing.price, fee, royalty, 0);
    }

    /// @notice Escrows USDC for a token-specific or collection-wide offer, returning its unique ID.
    /// @dev tokenId is informational only for collection-wide offers.
    function makeOffer(address collection, uint256 tokenId, bool collectionWide, uint256 price, uint64 expiry)
        external whenNotPaused nonReentrant returns (uint256 offerId)
    {
        _requireRegistered(collection);
        uint128 checkedPrice = _checkedPrice(price);
        _checkOfferExpiry(expiry);
        if (!collectionWide && IERC721(collection).ownerOf(tokenId) == msg.sender) revert SelfTrade();
        offerId = nextOfferId++;
        offers[offerId] = Offer(msg.sender, collection, tokenId, collectionWide, checkedPrice, expiry);
        usdc.safeTransferFrom(msg.sender, address(this), checkedPrice);
        emit OfferMade(offerId, collection, msg.sender, tokenId, collectionWide, checkedPrice, expiry);
    }

    /// @notice Adjusts a live offer and escrows/refunds only its price difference.
    function updateOffer(uint256 offerId, uint256 newPrice, uint64 newExpiry)
        external whenNotPaused nonReentrant
    {
        Offer memory offer = _existingOffer(offerId);
        if (offer.bidder != msg.sender) revert NotBidder();
        if (block.timestamp >= offer.expiry) revert OfferExpired();
        _requireRegistered(offer.collection);
        uint128 checkedPrice = _checkedPrice(newPrice);
        _checkOfferExpiry(newExpiry);
        offers[offerId].price = checkedPrice;
        offers[offerId].expiry = newExpiry;
        if (checkedPrice > offer.price) {
            usdc.safeTransferFrom(msg.sender, address(this), uint256(checkedPrice) - offer.price);
        } else if (checkedPrice < offer.price) {
            usdc.safeTransfer(offer.bidder, uint256(offer.price) - checkedPrice);
        }
        emit OfferUpdated(offerId, offer.price, checkedPrice, newExpiry);
    }

    /// @notice Cancels the caller's offer, including expired offers and while paused.
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer memory offer = _existingOffer(offerId);
        if (offer.bidder != msg.sender) revert NotBidder();
        _refundOffer(offerId, offer, false);
    }

    /// @notice Anyone can return an expired offer's escrow to its original bidder, even while paused.
    function reclaimExpiredOffer(uint256 offerId) external nonReentrant {
        Offer memory offer = _existingOffer(offerId);
        if (block.timestamp < offer.expiry) revert OfferNotExpired();
        _refundOffer(offerId, offer, true);
    }

    /// @notice Sells the caller's approved NFT into either type of offer, subject to a minimum price.
    /// @param minPrice Minimum gross offer price in USDC units, before fees and royalties.
    function acceptOffer(uint256 offerId, uint256 tokenId, uint256 minPrice) external whenNotPaused nonReentrant {
        _acceptOffer(offerId, tokenId, minPrice, false);
    }

    /// @notice Sells the caller's approved NFT into a collection-wide offer only, subject to a minimum price.
    /// @param minPrice Minimum gross offer price in USDC units, before fees and royalties.
    function acceptCollectionOffer(uint256 offerId, uint256 tokenId, uint256 minPrice) external whenNotPaused nonReentrant {
        _acceptOffer(offerId, tokenId, minPrice, true);
    }

    /// @notice Quotes execution-time fees, capped royalties and exact seller proceeds.
    /// @dev A zero/market royalty receiver is treated as no royalty. Invalid order prices revert.
    function quote(address collection, uint256 tokenId, uint256 price)
        public view returns (uint256 fee, uint256 royalty, address royaltyReceiver, uint256 sellerProceeds)
    {
        _checkedPrice(price);
        fee = Math.mulDiv(price, feeBps, 10_000);
        try IERC2981(collection).royaltyInfo(tokenId, price) returns (address receiver, uint256 amount) {
            if (receiver != address(0) && receiver != address(this)) {
                royaltyReceiver = receiver;
                royalty = Math.min(amount, Math.mulDiv(price, MAX_ROYALTY_BPS, 10_000));
                royalty = Math.min(royalty, price - fee);
            }
        } catch { /* Missing or reverting ERC2981 means zero royalty. */ }
        sellerProceeds = price - fee - royalty;
    }

    /// @notice Returns a listing; price zero indicates absence (not merely staleness).
    function getListing(address collection, uint256 tokenId) external view returns (Listing memory) {
        return listings[collection][tokenId];
    }

    /// @notice Returns an offer; price zero indicates cancelled or consumed escrow.
    function getOffer(uint256 offerId) external view returns (Offer memory) {
        return offers[offerId];
    }

    function _acceptOffer(uint256 offerId, uint256 tokenId, uint256 minPrice, bool requireCollectionWide) private {
        Offer memory offer = _existingOffer(offerId);
        if (offer.price < minPrice) revert PriceBelowMin();
        if (requireCollectionWide && !offer.collectionWide) revert NotCollectionOffer();
        if (block.timestamp >= offer.expiry) revert OfferExpired();
        if (!offer.collectionWide && tokenId != offer.tokenId) revert TokenMismatch();
        if (offer.bidder == msg.sender) revert SelfTrade();
        _requireRegistered(offer.collection);
        _requireOwnerAndApproval(offer.collection, tokenId, msg.sender);
        delete offers[offerId];
        Listing memory listing = listings[offer.collection][tokenId];
        if (listing.price != 0) {
            delete listings[offer.collection][tokenId];
            emit ListingCancelled(offer.collection, tokenId, listing.seller, msg.sender != listing.seller);
        }
        (uint256 fee, uint256 royalty) = _settle(offer.collection, tokenId, offer.price, msg.sender);
        IERC721(offer.collection).safeTransferFrom(msg.sender, offer.bidder, tokenId);
        emit OfferAccepted(offerId, offer.collection, tokenId, msg.sender, offer.bidder, offer.price);
        emit Sale(
            offer.collection, tokenId, msg.sender, offer.bidder, offer.price, fee, royalty,
            offer.collectionWide ? 2 : 1
        );
    }

    /// @dev For genuine USDC, transfers plus royalty credits sum to price exactly; no excess escrow is spent.
    function _settle(address collection, uint256 tokenId, uint256 price, address seller)
        private returns (uint256 fee, uint256 royalty)
    {
        address receiver;
        uint256 proceeds;
        (fee, royalty, receiver, proceeds) = quote(collection, tokenId, price);
        if (fee != 0) usdc.safeTransfer(feeRecipient, fee);
        if (royalty != 0) royaltyBalance[receiver] += royalty;
        if (proceeds != 0) usdc.safeTransfer(seller, proceeds);
    }

    function _refundOffer(uint256 offerId, Offer memory offer, bool expiredReclaim) private {
        delete offers[offerId];
        usdc.safeTransfer(offer.bidder, offer.price);
        emit OfferCancelled(offerId, offer.bidder, offer.price, expiredReclaim);
    }

    function _existingOffer(uint256 offerId) private view returns (Offer memory offer) {
        offer = offers[offerId];
        if (offer.price == 0) revert OfferNotFound();
    }

    function _activeListing(address collection, uint256 tokenId) private view returns (Listing memory listing) {
        listing = listings[collection][tokenId];
        if (listing.price == 0) revert ListingNotFound();
        if (listing.expiry != 0 && block.timestamp >= listing.expiry) revert ListingExpired();
    }

    function _requireRegistered(address collection) private view {
        if (!registry.isCollection(collection)) revert NotRegistered();
    }

    function _checkedPrice(uint256 price) private pure returns (uint128) {
        if (price == 0 || price % PRICE_TICK != 0 || price > type(uint128).max) revert InvalidPrice();
        return uint128(price);
    }

    function _checkListingExpiry(uint64 expiry) private view {
        if (expiry != 0 && expiry <= block.timestamp) revert InvalidExpiry();
    }

    function _checkOfferExpiry(uint64 expiry) private view {
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_OFFER_DURATION) revert InvalidExpiry();
    }

    function _requireOwnerAndApproval(address collection, uint256 tokenId, address seller) private view {
        IERC721 nft = IERC721(collection);
        if (nft.ownerOf(tokenId) != seller) revert NotTokenOwner();
        if (nft.getApproved(tokenId) != address(this) && !nft.isApprovedForAll(seller, address(this))) {
            revert NotApproved();
        }
    }

    function _isStale(address collection, uint256 tokenId, Listing memory listing) private view returns (bool) {
        if (listing.expiry != 0 && block.timestamp >= listing.expiry) return true;
        IERC721 nft = IERC721(collection);
        try nft.ownerOf(tokenId) returns (address currentOwner) {
            if (currentOwner != listing.seller) return true;
        } catch { return true; }
        try nft.getApproved(tokenId) returns (address approved) {
            if (approved == address(this)) return false;
        } catch { return true; }
        try nft.isApprovedForAll(listing.seller, address(this)) returns (bool approvedForAll) {
            return !approvedForAll;
        } catch { return true; }
    }
}
