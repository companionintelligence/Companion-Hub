import { describe, expect, it } from 'vitest';
import { requiresPortalRePairing } from './registration-status';

describe('requiresPortalRePairing', () => {
  it('returns true when tunnel token is missing in degraded state', () => {
    expect(
      requiresPortalRePairing({
        phase: 'degraded',
        degradedReasons: ['tunnel_token_missing'],
        registered: true,
      }),
    ).toBe(true);
  });

  it('returns false for other degraded reasons', () => {
    expect(
      requiresPortalRePairing({
        phase: 'degraded',
        degradedReasons: ['cloud_validation_failed'],
        registered: true,
      }),
    ).toBe(false);
  });
});
