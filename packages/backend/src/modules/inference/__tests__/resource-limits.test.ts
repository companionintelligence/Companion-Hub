import { describe, expect, it } from 'vitest';
import { calculateMaxConcurrentApps } from '../resource-limits';

describe('resource-limits', () => {
  it('matches documented RAM tiers', () => {
    expect(calculateMaxConcurrentApps(16 * 1024)).toBe(4);
    expect(calculateMaxConcurrentApps(32 * 1024)).toBe(12);
    expect(calculateMaxConcurrentApps(64 * 1024)).toBe(24);
  });

  it('scales linearly between tiers', () => {
    expect(calculateMaxConcurrentApps(24 * 1024)).toBe(8);
    expect(calculateMaxConcurrentApps(48 * 1024)).toBe(18);
  });
});
