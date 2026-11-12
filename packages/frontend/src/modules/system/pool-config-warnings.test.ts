import { describe, expect, it } from 'vitest';
import { poolConfigWarnings } from './pool-config-warnings';
import type { PoolStatusSummary } from './use-dashboard-data';

describe('poolConfigWarnings', () => {
  it('counts stale pins, directions switched off in .env and a capabilities error', () => {
    const pool = {
      enabled: true,
      pins: [{ targetAvailable: false }, { targetAvailable: true }, { targetAvailable: false }],
      directions: { outbound: { enabled: false, disabledBy: 'env' }, inbound: { enabled: false, disabledBy: 'setting' } },
      localNode: { capabilitiesError: 'ollama did not answer' },
    } as unknown as PoolStatusSummary;

    expect(poolConfigWarnings(pool)).toEqual({ stalePins: 2, envDisabledDirections: 1, capabilitiesError: true, total: 4 });
  });

  it('reads an unanswered pool query as nothing to count, not as a clean bill', () => {
    expect(poolConfigWarnings(undefined)).toEqual({ stalePins: 0, envDisabledDirections: 0, capabilitiesError: false, total: 0 });
  });
});
