/**
 * DTOs for the custom-domains Hub API.
 *
 * The Hub is a thin proxy here — most validation happens in Portal.
 * These DTOs describe the *minimum* surface we expose to the frontend.
 */

import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

// ─── Request bodies ───────────────────────────────────────────────────────────

const launchCustomDomainSchema = z.object({
  /** Fully-qualified domain the user wants to connect (e.g. "grafana.acme.com"). */
  domain: z.string().min(1),

  /**
   * The app URN this domain should be scoped to.
   * Omit for Hub-level domains (`target_kind: 'hub'`).
   */
  applicationUrn: z.string().optional(),
});

export class LaunchCustomDomainDto extends createZodDto(launchCustomDomainSchema) {}

// ─── Response shapes (from Portal, proxied verbatim) ─────────────────────────

export interface CustomDomainStatus {
  id: string;
  domain: string;
  applicationId: string | null;
  propagationStatus: 'pending' | 'success' | 'failed';
  sslStatus: 'pending' | 'success' | 'failed';
  monitorStatus: 'active' | 'paused' | 'none';
  createdAt: string;
  updatedAt: string;
}

export interface LaunchCustomDomainResponse {
  /** Short-lived Entri JWT the frontend passes to `entri.showEntri()`. */
  token: string;
  /** Full Entri config object to pass to `entri.showEntri()`. */
  config: Record<string, unknown>;
}
