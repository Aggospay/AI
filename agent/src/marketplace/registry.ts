import type { MarketplaceId, MarketplaceRegistration, MarketplaceRef } from './types'

export class MarketplaceAdapterNotFoundError extends Error {
  constructor(marketplaceId: MarketplaceId) {
    super(`Marketplace adapter is not registered: ${marketplaceId}`)
    this.name = 'MarketplaceAdapterNotFoundError'
  }
}

export class MarketplaceExecutionUnavailableError extends Error {
  constructor(marketplaceId: MarketplaceId) {
    super(`Execution is unavailable for marketplace: ${marketplaceId}`)
    this.name = 'MarketplaceExecutionUnavailableError'
  }
}

/**
 * In-memory adapter registry. Registration does not enable execution: callers must separately
 * request an execution adapter, and read-only adapters are registered without one.
 * Phase 1 defines the registry only; it is not wired into app or execution code.
 */
export class MarketplaceRegistry {
  private readonly registrations = new Map<MarketplaceId, MarketplaceRegistration>()

  constructor(registrations: readonly MarketplaceRegistration[] = []) {
    for (const registration of registrations) this.register(registration)
  }

  register(registration: MarketplaceRegistration): void {
    const id = registration.read.ref.marketplaceId
    if (!id.trim()) throw new Error('marketplaceId must not be empty')
    if (registration.execution && !sameMarketplace(registration.read.ref, registration.execution.marketplace)) {
      throw new Error('Read and execution adapters must identify the same marketplace and chain')
    }
    if (this.registrations.has(id)) throw new Error(`Marketplace adapter already registered: ${id}`)
    this.registrations.set(id, registration)
  }

  getReadAdapter(marketplaceId: MarketplaceId): MarketplaceRegistration['read'] {
    const registration = this.registrations.get(marketplaceId)
    if (!registration) throw new MarketplaceAdapterNotFoundError(marketplaceId)
    return registration.read
  }

  getExecutionAdapter(marketplaceId: MarketplaceId): NonNullable<MarketplaceRegistration['execution']> {
    const registration = this.registrations.get(marketplaceId)
    if (!registration) throw new MarketplaceAdapterNotFoundError(marketplaceId)
    if (!registration.execution || !registration.execution.capabilities.execution.enabled) {
      throw new MarketplaceExecutionUnavailableError(marketplaceId)
    }
    return registration.execution
  }

  list(): Array<{ ref: MarketplaceRef; capabilities: MarketplaceRegistration['read']['capabilities'] }> {
    return [...this.registrations.values()].map(({ read }) => ({ ref: read.ref, capabilities: read.capabilities }))
  }
}

function sameMarketplace(a: MarketplaceRef, b: MarketplaceRef): boolean {
  return a.marketplaceId === b.marketplaceId && a.chain.id === b.chain.id
}
