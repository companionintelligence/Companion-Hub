import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExposureSyncService } from '../exposure-sync.service';

// Both holds stand: a pairing check and a restore under way. They hold an ordinary sync. They exist
// to stop the very release this sends, so it must go out through them.
vi.mock('../registration-recovery-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../registration-recovery-state')>()),
  hasPairingAppCheck: vi.fn(async () => true),
  hasRestoreIntent: vi.fn(async () => true),
}));

const REGISTRATION = { id: 'org-1', tunnelId: 'tunnel-1', hubSubdomain: 'office-acme', slug: 'acme' };
const PORTAL_APPS = [{ name: 'printer', slug: 'printer', port: 9100, pinned: true }];

function buildSync(
  options: { registration?: Record<string, unknown> | null; syncResult?: Record<string, unknown>; portExpose?: Record<string, unknown> } = {},
) {
  const appRepository = { getApps: vi.fn(async () => [{ appName: 'wordpress', appStoreSlug: 'ci-marketplace', status: 'running' }]) };
  const cloudflare = {
    syncState: vi.fn(async () => options.syncResult ?? { ok: true, failed: [], failures: [], synced: 1 }),
    getDeviceApplications: vi.fn(async () => PORTAL_APPS),
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
    { get: vi.fn(() => options.portExpose ?? null) } as never,
  );
  return { sync, cloudflare, appRepository, logger };
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

  // The tunnel sync leaves the rows the registry pins, so a pairing again put those ports back.
  it("removes the Portal's entries for ports exposed This Machine Only or on the Private VPN", async () => {
    const portExpose = { releaseUnrestoredRegistryEntries: vi.fn(async () => ['printer']) };
    const { sync, cloudflare } = buildSync({ portExpose });

    await expect(sync.releaseAllAppsFromPortal()).resolves.toBe('released');

    expect(portExpose.releaseUnrestoredRegistryEntries).toHaveBeenCalledWith(PORTAL_APPS);
    expect(cloudflare.syncState.mock.invocationCallOrder[0]).toBeLessThan(
      portExpose.releaseUnrestoredRegistryEntries.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('throws when those entries could not be removed, since the Portal still lists them', async () => {
    const portExpose = { releaseUnrestoredRegistryEntries: vi.fn(async () => Promise.reject(new Error('PORTAL_REQUEST_FAILED'))) };
    const { sync } = buildSync({ portExpose });

    await expect(sync.releaseAllAppsFromPortal()).rejects.toThrow('PORTAL_REQUEST_FAILED');
  });
});

describe('ExposureSyncService.holdForFactoryReset', () => {
  it('sends no sync until every hold is lifted', async () => {
    const { sync, cloudflare, logger } = buildSync();
    const heldByReset = () => logger.debug.mock.calls.filter(([line]) => String(line).includes('factory reset')).length;
    const resumeFirst = sync.holdForFactoryReset();
    const resumeSecond = sync.holdForFactoryReset();

    await sync.triggerCloudflareSync();
    // Lifting one hold twice must not lift the other.
    resumeFirst();
    resumeFirst();
    await sync.triggerCloudflareSync();
    expect(heldByReset()).toBe(2);
    expect(cloudflare.syncState).not.toHaveBeenCalled();

    resumeSecond();
    await sync.triggerCloudflareSync();
    expect(heldByReset()).toBe(2);
    expect(sync.isCloudflareSyncInFlight()).toBe(false);
  });
});
