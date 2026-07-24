import { describe, expect, it } from 'vitest';

import { resolveBlockedReasonKey } from '../use-memory-connection';

/**
 * A blocked Connect button must always be able to say WHY. Before
 * CI-Engineering#75 every one of these states collapsed to a null `connectUrl`,
 * so the button rendered disabled under the generic "what connecting does"
 * tooltip and the user was told nothing about the obstacle.
 */
describe('resolveBlockedReasonKey', () => {
  it.each([
    ['memory_absent', 'MEMORY_CONNECT_NOT_INSTALLED'],
    ['memory_starting', 'MEMORY_CONNECT_STARTING_DESC'],
    ['memory_offline', 'MEMORY_CONNECT_OFFLINE_DESC'],
    ['hub_not_provisioned', 'MEMORY_CONNECT_BLOCKED_HUB_NOT_PROVISIONED'],
    ['hub_unreachable', 'MEMORY_CONNECT_BLOCKED_HUB_UNREACHABLE'],
    ['provider_local_only', 'MEMORY_CONNECT_BLOCKED_PROVIDER_LOCAL_ONLY'],
  ] as const)('maps %s to a specific explanation', (reason, key) => {
    expect(resolveBlockedReasonKey(reason)).toBe(key);
  });

  it('returns null when nothing is blocking', () => {
    expect(resolveBlockedReasonKey(null)).toBeNull();
    expect(resolveBlockedReasonKey(undefined)).toBeNull();
  });

  it('returns null for an unrecognised reason so the caller falls back to generic copy', () => {
    // A newer backend could add a reason this build does not know; that must not
    // produce a raw key on screen.
    expect(resolveBlockedReasonKey('something_new' as never)).toBeNull();
  });
});
