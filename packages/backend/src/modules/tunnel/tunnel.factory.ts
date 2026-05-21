/**
 * Tunnel Factory
 *
 * Factory service for creating tunnel service instances based on the selected provider.
 * Supports Cloudflare, Octelium, and Tailscale tunnel providers.
 */

import { Injectable } from '@nestjs/common';
import { type ITunnelService, type TunnelProvider } from './tunnel.interface';

@Injectable()
export class TunnelFactory {
  private services: Map<TunnelProvider, ITunnelService> = new Map();

  /**
   * Register a tunnel service implementation with the factory.
   */
  register(provider: TunnelProvider, service: ITunnelService): void {
    this.services.set(provider, service);
  }

  /**
   * Create (or retrieve) a tunnel service instance for the given provider.
   */
  create(provider: TunnelProvider): ITunnelService {
    const service = this.services.get(provider);
    if (!service) {
      throw new Error(`Tunnel provider "${provider}" is not registered`);
    }
    return service;
  }

  /**
   * Check if a provider is registered and available.
   */
  isProviderAvailable(provider: TunnelProvider): boolean {
    return this.services.has(provider);
  }

  /**
   * Get list of all available providers.
   */
  getAvailableProviders(): TunnelProvider[] {
    return Array.from(this.services.keys());
  }
}
