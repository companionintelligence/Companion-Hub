import type { PoolStatusSummary } from '@/modules/system/use-dashboard-data';

/**
 * Pool configuration that is quietly not doing what it says. The Resources page raises a notice for
 * each kind, because none of them produces an error anywhere a person looks:
 *
 * - a pin whose target can no longer serve is a no-op on the request path;
 * - a direction switched off in `.env` can't be flipped from the settings screen it appears to live on;
 * - a capabilities error means this node's own engine inventory is stale.
 *
 * An undefined `pool` (the query never answered) returns zeros on purpose. That isn't a claim that
 * the configuration is clean: the page's verdict counts the failed query as an unavailable check.
 */
export interface PoolConfigWarnings {
  stalePins: number;
  envDisabledDirections: number;
  capabilitiesError: boolean;
  total: number;
}

export function poolConfigWarnings(pool: PoolStatusSummary | undefined): PoolConfigWarnings {
  const stalePins = (pool?.pins ?? []).filter((pin) => pin.targetAvailable === false).length;
  const envDisabledDirections = [pool?.directions?.outbound, pool?.directions?.inbound].filter((direction) => direction?.disabledBy === 'env').length;
  const capabilitiesError = !!pool?.localNode?.capabilitiesError;

  return { stalePins, envDisabledDirections, capabilitiesError, total: stalePins + envDisabledDirections + (capabilitiesError ? 1 : 0) };
}
