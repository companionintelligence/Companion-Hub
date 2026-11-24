import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPublicWebIdentity } from '@ci-hub/common/types';
import { resolveHubPublicDomainRoot } from '@/common/helpers/hub-origin';
import { ExposureSyncService } from '../exposure-sync.service';

/*
 * The report of what each custom domain is waiting for rides on a sync and is built before the
 * request, while the binding is written after the answer. A domain connected in the Portal was
 * therefore reported one poll later, 5 minutes in which the Portal said "Waiting for your Hub" and
 * offered no Restart. A pass that writes a binding now books one more pass shortly after.
 */

vi.mock('../registration-recovery-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../registration-recovery-state')>()),
  hasPairingAppCheck: vi.fn(async () => false),
  hasRestoreIntent: vi.fn(async () => false),
}));

// The rows here carry no install form; these say the app is published and can take a domain.
vi.mock('@/modules/apps/app-public-routing.helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/apps/app-public-routing.helpers')>()),
  publishesCloudflarePublicRoute: () => true,
  canServeOnCustomDomain: () => true,
  publicRoutingSnapshotOf: <T>(app: T) => app,
}));

const REGISTRATION = { id: 'org-1', tunnelId: 'tunnel-1', hubSubdomain: 'ubuntu', slug: 'hanz-corp' };
const CONFIG = { domain: 'ci0.pw', userSettings: {} };
const DOMAIN = 'wp-dev.xrti.me';
const OTHER_DOMAIN = 'blog.xrti.me';
const PLATFORM_HOSTNAME = buildPublicWebIdentity({
  appSubdomain: 'wordpress-ci-marketplace',
  hubSubdomain: REGISTRATION.hubSubdomain,
  orgSlug: REGISTRATION.slug,
  publicDomainRoot: resolveHubPublicDomainRoot(CONFIG as never),
}).hostname;

type Row = Record<string, unknown> & { id: number; status: string; customDomain: string | null; pendingRestart: boolean };
type SyncAnswer = { ok: boolean; failed: string[]; failures: unknown[]; synced: number; customDomains?: unknown[] };

const answerWith = (...domains: string[]): SyncAnswer => ({
  ok: true,
  failed: [],
  failures: [],
  synced: 1,
  customDomains: domains.map((domain, index) => ({ id: `cd_${index + 1}`, domain, targetHostname: PLATFORM_HOSTNAME })),
});

function buildSync(row: Partial<Row> = {}) {
  const app: Row = {
    id: 1,
    appName: 'wordpress',
    appStoreSlug: 'ci-marketplace',
    status: 'running',
    customDomain: null,
    customDomainIntent: null,
    customDomainTakeover: false,
    pendingRestart: false,
    autoRestartOnDomainChange: false,
    localSubdomain: null,
    publicDomain: null,
    port: null,
    config: {},
    ...row,
  };
  const appRepository = {
    getApps: vi.fn(async () => [{ ...app }]),
    updateAppByIdIfStatus: vi.fn(async (_id: number, status: string, patch: Partial<Row>) => {
      if (status !== app.status) return false;
      Object.assign(app, patch);
      return true;
    }),
    updateAppById: vi.fn(async (_id: number, patch: Partial<Row>) => {
      Object.assign(app, patch);
    }),
  };
  const cloudflare = { syncState: vi.fn(async (..._args: unknown[]): Promise<SyncAnswer> => answerWith(DOMAIN)) };
  const registration = { getDeviceRegistrationInfo: vi.fn(async () => REGISTRATION) };
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  // The app's env still names its platform hostname: nothing has restarted it onto the domain.
  const appFiles = {
    getAppEnv: vi.fn(async () => ({ content: `APP_PUBLIC_HOSTNAME=${PLATFORM_HOSTNAME}\n` })),
    getInstalledAppInfo: vi.fn(async () => null),
  };
  const envUtils = {
    envStringToMap: (content: string) =>
      new Map(
        content
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('=') as [string, string]),
      ),
  };
  const moduleRef = {
    get: vi.fn((token: { name?: string }) => {
      if (token?.name === 'AppFilesManager') return appFiles;
      if (token?.name === 'EnvUtils') return envUtils;
      return null;
    }),
  };

  const sync = new ExposureSyncService(
    logger as never,
    appRepository as never,
    { getConfig: vi.fn(() => CONFIG) } as never,
    { emit: vi.fn() } as never,
    cloudflare as never,
    registration as never,
    {} as never,
    moduleRef as never,
  );
  const reportAt = (call: number) => cloudflare.syncState.mock.calls[call]?.[3] as Array<Record<string, unknown>> | undefined;
  return { sync, app, cloudflare, reportAt };
}

describe('ExposureSyncService custom-domain report after a bind', () => {
  let service: ExposureSyncService | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    service?.onModuleDestroy();
    service = null;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('reports a domain the Portal just connected a couple of seconds after binding it, once', async () => {
    const { sync, app, cloudflare, reportAt } = buildSync();
    service = sync;

    await sync.triggerCloudflareSync();
    expect(app.customDomain).toBe(DOMAIN);
    expect(cloudflare.syncState).toHaveBeenCalledTimes(1);
    // Built before the answer, so it could not name the domain.
    expect(reportAt(0)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(cloudflare.syncState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cloudflare.syncState).toHaveBeenCalledTimes(2);
    expect(reportAt(1)).toEqual([{ domain: DOMAIN, targetHostname: PLATFORM_HOSTNAME, state: 'pending-restart', autoRestart: false }]);

    // The follow-up changed nothing, so nothing else goes out before the poll.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(cloudflare.syncState).toHaveBeenCalledTimes(2);
  });

  it('sends no extra pass when nothing was bound or unbound', async () => {
    const { sync, cloudflare, reportAt } = buildSync({ customDomain: DOMAIN, pendingRestart: true });
    service = sync;

    await sync.triggerCloudflareSync();
    expect(reportAt(0)).toEqual([{ domain: DOMAIN, targetHostname: PLATFORM_HOSTNAME, state: 'pending-restart', autoRestart: false }]);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(cloudflare.syncState).toHaveBeenCalledTimes(1);
  });

  it('reports an unbind the same way', async () => {
    const { sync, app, cloudflare, reportAt } = buildSync({ customDomain: DOMAIN, pendingRestart: true });
    service = sync;
    // The Portal moved the domain to another Hub's app. (An empty answer is only believed the second time.)
    cloudflare.syncState.mockResolvedValue({
      ...answerWith(),
      customDomains: [{ id: 'cd_9', domain: OTHER_DOMAIN, targetHostname: 'blog-other-hub.ci0.pw' }],
    });
    // A save owns this app's restart, so the reconcile dispatches none.
    const appUrn = 'wordpress:ci-marketplace' as never;

    await sync.triggerCloudflareSync({ skipAutoRestartAppUrns: [appUrn] });
    expect(app.customDomain).toBeNull();
    expect(reportAt(0)).toEqual([{ domain: DOMAIN, targetHostname: PLATFORM_HOSTNAME, state: 'pending-restart', autoRestart: false }]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(cloudflare.syncState).toHaveBeenCalledTimes(2);
    expect(reportAt(1)).toEqual([]);
  });

  it('does not start over a pass that is still running, and sends nothing once that pass carried the report', async () => {
    const { sync, cloudflare, reportAt } = buildSync();
    service = sync;

    let answerSlowPass: (answer: SyncAnswer) => void = () => undefined;
    cloudflare.syncState
      .mockResolvedValueOnce(answerWith(DOMAIN))
      .mockImplementationOnce(() => new Promise<SyncAnswer>((resolve) => (answerSlowPass = resolve)));

    await sync.triggerCloudflareSync();
    await vi.advanceTimersByTimeAsync(500);
    // Someone saves a setting: a pass starts and waits on the Portal well past the follow-up's time.
    const slowPass = sync.triggerCloudflareSync();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync.isCloudflareSyncInFlight()).toBe(true);
    expect(cloudflare.syncState).toHaveBeenCalledTimes(2);

    // That pass was built after the bind, so its report already names the domain.
    expect(reportAt(1)).toEqual([{ domain: DOMAIN, targetHostname: PLATFORM_HOSTNAME, state: 'pending-restart', autoRestart: false }]);
    answerSlowPass(answerWith(DOMAIN));
    await slowPass;

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(cloudflare.syncState).toHaveBeenCalledTimes(2);
  });

  it('sends the report once a pass that could not carry it has finished', async () => {
    const { sync, cloudflare, reportAt } = buildSync();
    service = sync;

    let answerSlowPass: (answer: SyncAnswer) => void = () => undefined;
    cloudflare.syncState
      .mockResolvedValueOnce(answerWith(DOMAIN))
      .mockImplementationOnce(() => new Promise<SyncAnswer>((resolve) => (answerSlowPass = resolve)));

    await sync.triggerCloudflareSync();
    const slowPass = sync.triggerCloudflareSync();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cloudflare.syncState).toHaveBeenCalledTimes(2);

    // The Portal never answered that pass, so its report never arrived.
    answerSlowPass({ ok: false, failed: [], failures: [], synced: 0 });
    await slowPass;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(cloudflare.syncState).toHaveBeenCalledTimes(3);
    expect(reportAt(2)).toEqual([{ domain: DOMAIN, targetHostname: PLATFORM_HOSTNAME, state: 'pending-restart', autoRestart: false }]);
  });

  it('never books a pass from the pass it booked, even when that one moves the binding again', async () => {
    const { sync, app, cloudflare } = buildSync();
    service = sync;
    cloudflare.syncState.mockResolvedValueOnce(answerWith(DOMAIN)).mockResolvedValue(answerWith(OTHER_DOMAIN));
    // A caller owns the restart, so the move dispatches none and every pass finishes at once.
    const appUrn = 'wordpress:ci-marketplace' as never;

    await sync.triggerCloudflareSync({ skipAutoRestartAppUrns: [appUrn] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cloudflare.syncState).toHaveBeenCalledTimes(2);
    expect(app.customDomain).toBe(OTHER_DOMAIN);
    expect(sync.isCloudflareSyncInFlight()).toBe(false);

    // The second move waits for the poll, as every report did before.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(cloudflare.syncState).toHaveBeenCalledTimes(2);
  });

  it("keeps the apps whose restart a caller owns out of the follow-up's restarts", async () => {
    const { sync, cloudflare } = buildSync();
    service = sync;
    const appUrn = 'wordpress:ci-marketplace' as never;
    const trigger = vi.spyOn(sync, 'triggerCloudflareSync');

    await sync.triggerCloudflareSync({ skipAutoRestartAppUrns: [appUrn] });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(cloudflare.syncState).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveBeenLastCalledWith({ customDomainReportFollowUp: true, skipAutoRestartAppUrns: [appUrn] });
  });
});
