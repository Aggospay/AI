export interface MarketplaceCapabilities {
  read: {
    collections: boolean
    nfts: boolean
    listings: boolean
    stats: boolean
    floorHistory: boolean
    search: boolean
    rankings: boolean
    activity: boolean
  }
  execution: {
    enabled: boolean
    buy: boolean
    sell: boolean
    cancel: boolean
    offer: boolean
    transfer: boolean
  }
}

/** All execution operations stay disabled for the OpenSea adapter. */
export const OPENSEA_READ_ONLY_CAPABILITIES: MarketplaceCapabilities = {
  read: {
    collections: true,
    nfts: true,
    listings: true,
    stats: true,
    floorHistory: true,
    search: true,
    rankings: true,
    activity: true,
  },
  execution: {
    enabled: false,
    buy: false,
    sell: false,
    cancel: false,
    offer: false,
    transfer: false,
  },
}

/** Capability declaration for the currently implemented internal Arc marketplace. */
export const ARC_MARKETPLACE_CAPABILITIES: MarketplaceCapabilities = {
  read: {
    collections: true,
    nfts: true,
    listings: true,
    stats: true,
    floorHistory: false,
    search: false,
    rankings: false,
    activity: true,
  },
  execution: {
    enabled: true,
    buy: true,
    sell: true,
    cancel: true,
    offer: true,
    transfer: false,
  },
}
