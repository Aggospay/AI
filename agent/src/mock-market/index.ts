import { OpenSeaMockAdapter } from './opensea-mock-adapter'
import { InMemoryMarketplaceRepository } from './repository'
import { MockListingService, MockOrderService } from './services'

export const mockMarketplaceRepository = new InMemoryMarketplaceRepository()
export const mockMarketplaceAdapter = new OpenSeaMockAdapter(mockMarketplaceRepository)
export const mockListingService = new MockListingService(mockMarketplaceAdapter)
export const mockOrderService = new MockOrderService(mockMarketplaceAdapter)
