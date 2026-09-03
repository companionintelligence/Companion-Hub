import { Injectable } from '@nestjs/common';

/**
 * One-way invalidate signal from AppStore → Marketplace without Nest forwardRef.
 * MarketplaceService registers a listener on init; AppStoreService only emits.
 */
@Injectable()
export class MarketplaceCacheBus {
  private listener: (() => void) | null = null;

  register(listener: () => void) {
    this.listener = listener;
  }

  invalidate() {
    this.listener?.();
  }
}
