import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExposureSyncService } from '../exposure-sync.service';

// Both holds stand: a pairing check and a restore under way. They hold an ordinary sync, and exist
// to stop exactly the release this sends, so it must go out through them.
vi.mock('../registration-recovery-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../registration-recovery-state')>()),
  hasPairingAppCheck: vi.fn(async () => true),
  hasRestoreIntent: vi.fn(async () => true),
}));

const REGISTRATION = { id: 'org-1', tunnelId: 'tunnel-1', hubSubdomain: 'office-acme', slug: 'acme' };

function buildSync(options: { registration?: Record<string, unknown> | null; syncResult?: Record<string, unknown> } = {}) {
  const appRepository = { getApps: vi.fn(async () => [{ appName: 'wordpress', appStoreSlug: 'ci-marketplace', status: 'running' }]) };
  const cloudflare = {
    syncState: vi.fn(async () => options.syncResult ?? { ok: true, failed: [], failures: [], synced: 1 }),
  };
  const registration = { getDeviceRegistrationInfo: vi.fn(async () => (options.registration === undefined ? REGISTRATION : options.registration)) };
  const config = { getConfig: vi.fn(() => ({ domain: 'example.com', userSettings: {} })) };
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

  const sync = new ExposureSyncService(
    logger as never,
    appRepository as never,
    config as never,
    { emit: vi.fn() } as never,
    cloudflare as never,
    registration as never,
    {} as never,
    { get: vi.fn(() => null) } as never,
  );
  return { sync, cloudflare, appRepository };
}

describe('ExposureSyncService.releaseAllAppsFromPortal', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends the Hub entry alone, with no custom-domain report, whatever the app table holds', async () => {
    const { sync, cloudflare, appRepository } = buildSync();

    await expect(sync.releaseAllAppsFromPortal()).resolves.toBe('released');

    expect(cloudflare.syncState).toHaveBeenCalledTimes(1);
    const [organizationId, entries, tunnelId, customDomainApps] = cloudflare.syncState.mock.calls[0] as unknown as [
      string,
      Array<Record<string, unknown>>,
      string,
      unknown,
    ];
    expect(organizationId).toBe('org-1');
    expect(tunnelId).toBe('tunnel-1');
    expect(entries).toEqual([expect.objectContaining({ privilegedKind: 'hub', subdomain: 'office', originServerName: 'office-acme.example.com' })]);
    expect(customDomainApps).toBeUndefined();
    expect(appRepository.getApps).not.toHaveBeenCalled();
  });

  it('sends nothing when the Hub has no tunnel registration', async () => {
    const { sync, cloudflare } = buildSync({ registration: { ...REGISTRATION, tunnelId: null } });

    await expect(sync.releaseAllAppsFromPortal()).resolves.toBe('not_paired');
    expect(cloudflare.syncState).not.toHaveBeenCalled();
  });

  it('throws when the Portal does not take it, so the reset can say the apps are still listed', async () => {
    const { sync } = buildSync({
      syncResult: { ok: false, failed: [], failures: [], synced: 0, errorStatus: 503, errorMessage: 'Service Unavailable' },
    });

    await expect(sync.releaseAllAppsFromPortal()).rejects.toThrow('Service Unavailable');
  });
});
