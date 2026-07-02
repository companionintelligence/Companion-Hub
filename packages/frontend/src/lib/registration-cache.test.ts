import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistrationStatus } from './registration-status';

const { fetchRegistrationStatus } = vi.hoisted(() => ({
  fetchRegistrationStatus: vi.fn(),
}));

vi.mock('./registration-api', () => ({
  fetchRegistrationStatus,
}));

const { cacheRegistrationStatus, getCachedRegistrationStatus, resolveRegistrationStatus } = await import('./registration-cache');

function makeStatus(phase: RegistrationStatus['phase'], registered = false): RegistrationStatus {
  return {
    phase,
    registered,
    degradedReasons: [],
  };
}

describe('registration-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('falls back to the cached operational status when the API lookup fails', async () => {
    cacheRegistrationStatus(makeStatus('locally_ready', true));
    fetchRegistrationStatus.mockRejectedValue(new Error('network error'));

    await expect(resolveRegistrationStatus()).resolves.toEqual(makeStatus('locally_ready', true));
  });

  it('returns null when the API lookup fails and no valid cache exists', async () => {
    fetchRegistrationStatus.mockResolvedValue(null);

    await expect(resolveRegistrationStatus()).resolves.toBeNull();
    expect(getCachedRegistrationStatus()).toBeNull();
  });
});
