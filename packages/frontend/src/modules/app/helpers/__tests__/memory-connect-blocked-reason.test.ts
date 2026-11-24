import { describe, expect, it } from 'vitest';

import { type MemoryConnectionStatus, memoryStatusPollMs, resolveBlockedReasonKey } from '../use-memory-connection';

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
    ['memory_address_refused', 'MEMORY_CONNECT_BLOCKED_ADDRESS_REFUSED'],
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

describe('memoryStatusPollMs', () => {
  const status = (partial: Partial<MemoryConnectionStatus>) =>
    ({ applicable: true, providerStatus: 'ready', state: 'unconfigured', reason: null, ...partial }) as MemoryConnectionStatus;

  it('polls while CI Memory is coming up', () => {
    expect(memoryStatusPollMs(status({ providerStatus: 'starting', reason: 'memory_starting' }))).toBe(10_000);
  });

  // Lifting a refusal is an exposure sync on the Hub, so no event would re-enable the button.
  it('polls while the Portal refuses CI Memory its address', () => {
    expect(memoryStatusPollMs(status({ reason: 'memory_address_refused' }))).toBe(30_000);
  });

  it.each([
    ['a connectable provider', status({})],
    ['a connected app whose provider was refused an address', status({ state: 'connected', reason: 'memory_address_refused' })],
    ['an offline provider', status({ providerStatus: 'offline', reason: 'memory_offline' })],
    ['an app that is not a memory consumer', status({ applicable: false, reason: 'memory_address_refused' })],
    ['no status yet', null],
  ])('does not poll for %s', (_name, value) => {
    expect(memoryStatusPollMs(value)).toBe(false);
  });
});
