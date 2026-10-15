import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DATA_DIR, TUNNEL_DIR } from '@/common/constants';
import type { LoggerService } from '@/core/logger/logger.service';
import type { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { FactoryResetService } from '@/modules/system/factory-reset.service';
import { readRegisteredDeviceId } from '../device-id.resolver';
import { probePublicHostname } from '../public-reachability';
import { RegistrationController } from '../registration.controller';
import { RegistrationService } from '../registration.service';

vi.mock('axios');
// The public-URL probe opens sockets and asks real nameservers; nothing here may reach the network.
vi.mock('../public-reachability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-reachability')>()),
  probePublicHostname: vi.fn(),
}));
// FactoryResetService imports it. No test here has an app to uninstall.
vi.mock('@/modules/app-lifecycle/commands/uninstall-app-command', () => ({ UninstallAppCommand: class {} }));

/*
 * A registration reset that lands while a pairing is still setting up wins. The pairing writes nothing
 * more. What its step under way finishes after the reset (the tunnel token, cloudflared, the
 * registration row and registration.json) is removed again. A pairing started after the reset works.
 *
 * Driven through the real RegistrationService over in-memory settings and rows and the memfs tunnel
 * folder. `tunnel.running` is the cloudflared container. Portal is axios. `holdAt` stops the pairing
 * at one step until the test has run the reset.
 */

const DEVICE_ID = 'device-under-test';
const OLD_DEVICE_KEY = 'device-key-from-the-last-pairing';
const NEW_DEVICE_KEY = 'device-key-from-this-pairing';
const TOKEN_PATH = path.join(TUNNEL_DIR, 'token');
const REGISTRATION_MARKER_PATH = path.join(TUNNEL_DIR, 'registration.json');
const PAIRING_APP_CHECK_PATH = path.join(DATA_DIR, 'state', 'pairing-app-check.json');

const ENV: Record<string, unknown> = {
  ciCloudUrl: 'https://portal.example.test',
  domain: 'example.com',
  version: '0.0.0-test',
  rootFolderHost: '/opt/ci-hub',
  directories: { dataDir: '/data' },
};

type Row = Record<string, unknown> & { id: string };

interface Persisted {
  /** state/settings.json, as `ConfigurationService` holds it. */
  settings: Record<string, string>;
  rows: Row[];
}

/** The steps a pairing or a check-in can be held at. */
type Step = 'portal pairs' | 'tunnel starts' | 'tunnel started' | 'row written' | 'check-in answers';

const answerFor = (organizationId: string) => ({
  device_id: DEVICE_ID,
  organization_id: organizationId,
  organization_name: 'Next org',
  slug: 'next-org',
  subdomain: 'hub-next',
  tunnel_id: 'tunnel-next',
  tunnel_token: 'tunnel-token-next',
  api_key: NEW_DEVICE_KEY,
  domain: 'example.test',
});

const UNREGISTERED = { phase: 'unregistered', rows: [], tunnelToken: false, cloudflaredRunning: false, registrationMarker: false };
const REGISTERED = { phase: 'publicly_ready', rows: ['org-next'], tunnelToken: true, cloudflaredRunning: true, registrationMarker: true };

describe('a registration reset that overtakes a pairing', () => {
  const cloudflare = mock<CloudflareClientService>();
  const tunnel = { running: false };
  const portal = { pairInto: 'org-next', deviceRemoved: false };
  const booted: RegistrationService[] = [];
  let disk: Persisted;
  let held: Map<Step, { reached: () => void; released: Promise<void> }>;
  /** Every `setupOrganizationInfrastructure` run, which a pairing does not wait for. */
  let setups: Promise<unknown>[];

  /** Holds the next pairing at `step`, once, until `release`. */
  function holdAt(step: Step) {
    let reached!: () => void;
    let release!: () => void;
    const atStep = new Promise<void>((resolve) => (reached = resolve));
    held.set(step, { reached, released: new Promise<void>((resolve) => (release = resolve)) });
    return { reached: atStep, release };
  }

  async function pass(step: Step) {
    const hold = held.get(step);
    if (!hold) return;
    held.delete(step);
    hold.reached();
    await hold.released;
  }

  function configOver() {
    return {
      get: (key: string) => (key in disk.settings ? disk.settings[key] || null : (ENV[key] ?? null)),
      getConfig: () => ({ ...ENV, ...disk.settings, userSettings: { domain: ENV.domain } }),
      getOutboundCiCloudUrl: () => ENV.ciCloudUrl,
      setFileOnlySettings: async (patch: Record<string, string>) => {
        Object.assign(disk.settings, patch);
      },
      setUserSettings: async (patch: Record<string, string>) => {
        Object.assign(disk.settings, patch);
      },
      setDomain: async () => undefined,
      forgetPersistedUserSettings: () => undefined,
    };
  }

  function rowsOver() {
    const update = async (id: string, patch: Record<string, unknown>) => {
      const row = disk.rows.find((candidate) => candidate.id === id);
      if (row) Object.assign(row, patch);
      return row ?? null;
    };
    return {
      getFirstDeviceRegistration: async () => disk.rows[0] ?? null,
      hasAnyDeviceRegistration: async () => disk.rows.length > 0,
      getDeviceRegistrationById: async (id: string) => disk.rows.find((row) => row.id === id) ?? null,
      createDeviceRegistration: async (row: Row) => {
        disk.rows.push({ ...row });
        await pass('row written');
        return row;
      },
      updateDeviceRegistration: update,
      updateProvisioningState: (id: string, phase: string, reasons: string[] = []) =>
        update(id, { provisioningPhase: phase, degradedReasons: JSON.stringify(reasons) }),
      deleteDeviceRegistration: async (id: string) => {
        disk.rows = disk.rows.filter((row) => row.id !== id);
      },
      deleteAll: async () => {
        disk.rows = [];
      },
    };
  }

  /** One backend process over `disk`. */
  function boot() {
    const logger = mock<LoggerService>();
    const config = configOver();
    const registration = new RegistrationService(
      config as never,
      logger,
      cloudflare,
      { writeHubRoute: async () => undefined } as never,
      rowsOver() as never,
      {} as never,
    );
    vi.spyOn(registration, 'getDeviceId').mockResolvedValue(DEVICE_ID);
    const setup = Reflect.get(registration, 'setupOrganizationInfrastructure').bind(registration);
    vi.spyOn(registration as never, 'setupOrganizationInfrastructure').mockImplementation(((...args: unknown[]) => {
      const run = setup(...args);
      setups.push(run);
      return run;
    }) as never);
    booted.push(registration);
    return { registration, config, logger };
  }

  type Hub = ReturnType<typeof boot>;

  function factoryReset(hub: Hub) {
    const db = {
      // The one statement a factory reset executes: TRUNCATE of these tables, among others.
      execute: async () => {
        disk.rows = [];
      },
      query: { app: { findMany: async () => [] } },
    };
    const filesystem = { createDirectory: async () => true, removeDirectory: async () => true, pathExists: async () => true };
    return new FactoryResetService(
      db as never,
      {} as never,
      { get: () => undefined } as never,
      filesystem as never,
      hub.config as never,
      { clear: () => undefined } as never,
      { invalidate: () => undefined } as never,
      hub.logger,
      hub.registration,
    );
  }

  const resets: Record<string, (hub: Hub) => Promise<unknown>> = {
    'Settings > Reset registration': (hub) => new RegistrationController(hub.registration, hub.config as never, hub.logger).resetRegistration(),
    'Start fresh': async (hub) => expect(await hub.registration.prepareFreshSetup()).toMatchObject({ success: true }),
    'a factory reset': (hub) => factoryReset(hub).execute(),
  };

  /** Waits for every pairing's setup, including one the reset stopped. */
  async function settled() {
    while (setups.length > 0) {
      await Promise.allSettled(setups.splice(0));
    }
  }

  function leftOn(hub: Hub) {
    return {
      phase: hub.registration.getRegistrationStatus().phase,
      rows: disk.rows.map((row) => row.id),
      tunnelToken: fs.existsSync(TOKEN_PATH),
      cloudflaredRunning: tunnel.running,
      registrationMarker: fs.existsSync(REGISTRATION_MARKER_PATH),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    disk = { settings: { ciHubApiKey: OLD_DEVICE_KEY }, rows: [] };
    held = new Map();
    setups = [];
    tunnel.running = false;
    portal.pairInto = 'org-next';
    portal.deviceRemoved = false;
    await fs.promises.mkdir(TUNNEL_DIR, { recursive: true });

    cloudflare.initializeTunnel.mockImplementation(async (_organizationId, credentials) => {
      await pass('tunnel starts');
      await fs.promises.writeFile(TOKEN_PATH, credentials.token);
      tunnel.running = true;
      await pass('tunnel started');
      return { tunnelId: credentials.tunnelId, token: credentials.token };
    });
    cloudflare.stopTunnel.mockImplementation(async () => {
      tunnel.running = false;
      return true;
    });
    cloudflare.loadTunnelTokenFromDisk.mockResolvedValue(true);
    vi.mocked(probePublicHostname).mockResolvedValue({ reachable: true, via: 'system', status: 200 });

    vi.mocked(axios.post).mockImplementation(async (url: string) => {
      if (url.endsWith('/api/devices/pair')) {
        await pass('portal pairs');
        return { status: 200, data: answerFor(portal.pairInto) };
      }
      if (url.endsWith('/api/devices/register')) {
        await pass('portal pairs');
        return { status: 200, data: answerFor(portal.pairInto) };
      }
      if (url.endsWith('/api/devices/check-in')) {
        await pass('check-in answers');
        return portal.deviceRemoved
          ? { status: 400, data: { error: 'Device not active', code: 'DEVICE_NOT_ACTIVE' } }
          : { status: 200, data: { status: 'OK' } };
      }
      throw new Error(`unexpected Portal call: ${url}`);
    });
  });

  afterEach(() => {
    for (const registration of booted.splice(0)) {
      registration.onApplicationShutdown();
    }
    vi.mocked(axios.post).mockReset();
  });

  describe.each(Object.keys(resets))('%s', (reset) => {
    const steps: Step[] = reset === 'Start fresh' ? ['tunnel starts', 'tunnel started'] : ['tunnel starts', 'tunnel started', 'row written'];

    it.each(steps)('during a first pairing, while its %s, leaves the Hub unregistered with no tunnel', async (step) => {
      const hub = boot();
      const hold = holdAt(step);
      await expect(hub.registration.pairDevice('ABC123')).resolves.toMatchObject({ success: true });
      await hold.reached;

      await resets[reset](hub);
      hold.release();
      await settled();

      expect(leftOn(hub)).toEqual(UNREGISTERED);
    });
  });

  // Portal answers DEVICE_NOT_ACTIVE only to a check-in. A Hub checks in only while it is registered,
  // so here it is a Hub pairing again into its own organization because Portal rejects its key.
  describe('a check-in answered DEVICE_NOT_ACTIVE', () => {
    async function hubWhoseKeyPortalRejects() {
      disk.rows.push({
        id: 'org-test',
        slug: 'org-test',
        name: 'Test org',
        hubSubdomain: 'hub-test',
        tunnelId: 'tunnel-test',
        tunnelToken: 'tunnel-token-test',
        provisioningPhase: 'degraded',
        degradedReasons: '["portal_rejected"]',
      });
      await fs.promises.writeFile(TOKEN_PATH, 'tunnel-token-test');
      tunnel.running = true;
      const hub = boot();
      // Restores the phase from the row, as boot does.
      await hub.registration.isRegistered();
      expect(hub.registration.getRegistrationStatus()).toMatchObject({ phase: 'degraded', degradedReasons: ['portal_rejected'] });
      return hub;
    }

    it.each(['tunnel starts', 'tunnel started'] as const)(
      'during a pairing again into the same organization, while its %s, leaves the Hub unregistered with no tunnel',
      async (step) => {
        const hub = await hubWhoseKeyPortalRejects();
        portal.pairInto = 'org-test';
        const hold = holdAt(step);
        await expect(hub.registration.pairDevice('ABC123', { callerAuthenticated: true })).resolves.toMatchObject({ success: true });
        await hold.reached;

        portal.deviceRemoved = true;
        await expect(hub.registration.checkForRemoval()).resolves.toBe('removed');
        hold.release();
        await settled();

        expect(leftOn(hub)).toEqual(UNREGISTERED);
      },
    );

    it('for a check-in sent before the pairing began, lets the pairing finish', async () => {
      const hub = await hubWhoseKeyPortalRejects();
      portal.pairInto = 'org-test';
      portal.deviceRemoved = true;
      const checkIn = holdAt('check-in answers');
      const portalPairs = holdAt('portal pairs');
      const removal = hub.registration.checkForRemoval();
      await checkIn.reached;
      const paired = hub.registration.pairDevice('ABC123', { callerAuthenticated: true });
      await portalPairs.reached;

      // The answer is about the key this Hub held before the pairing. Portal is replacing that key.
      checkIn.release();
      await expect(removal).resolves.toBe('not_checked');
      portalPairs.release();

      await expect(paired).resolves.toMatchObject({ success: true });
      await settled();
      expect(leftOn(hub)).toEqual({ ...REGISTERED, phase: 'locally_ready', rows: ['org-test'] });
      expect(disk.settings.ciHubApiKey).toBe(NEW_DEVICE_KEY);
    });

    it('for a check-in sent before a registration from the manual form began, lets the registration finish', async () => {
      const hub = await hubWhoseKeyPortalRejects();
      portal.pairInto = 'org-test';
      portal.deviceRemoved = true;
      const checkIn = holdAt('check-in answers');
      const portalRegisters = holdAt('portal pairs');
      const removal = hub.registration.checkForRemoval();
      await checkIn.reached;
      const registered = hub.registration.initiateRegistration('org-test', 'Test org');
      await portalRegisters.reached;

      checkIn.release();
      await expect(removal).resolves.toBe('not_checked');
      portalRegisters.release();

      await expect(registered).resolves.toMatchObject({ success: true });
      await settled();
      expect(leftOn(hub)).toEqual({ ...REGISTERED, phase: 'locally_ready', rows: ['org-test'] });
    });
  });

  it('stops a pairing whose Portal request was in flight before it writes anything', async () => {
    const hub = boot();
    const hold = holdAt('portal pairs');
    const paired = hub.registration.pairDevice('ABC123');
    await hold.reached;

    await resets['Start fresh'](hub);
    hold.release();

    await expect(paired).resolves.toMatchObject({ success: false, message: expect.stringContaining('reset') });
    await settled();
    expect(leftOn(hub)).toEqual(UNREGISTERED);
    // Start fresh pairs as a new device, so the ID it removed must stay gone.
    expect(readRegisteredDeviceId(DATA_DIR)).toBeNull();
    expect(disk.settings).toEqual({ ciHubApiKey: OLD_DEVICE_KEY });
    expect(fs.existsSync(PAIRING_APP_CHECK_PATH)).toBe(false);
  });

  it('stops a registration from the manual form and reports that it was reset', async () => {
    const hub = boot();
    const hold = holdAt('tunnel started');
    const registered = hub.registration.initiateRegistration('org-next', 'Next org');
    await hold.reached;

    await resets['Settings > Reset registration'](hub);
    hold.release();

    await expect(registered).resolves.toMatchObject({ success: false, message: expect.stringContaining('reset') });
    await settled();
    expect(leftOn(hub)).toEqual(UNREGISTERED);
  });

  it('stops the registration check setting up a row it read before the reset and keeps polling', async () => {
    // A complete row on a Hub whose phase is not restored yet: the registration check sets it up.
    disk.rows.push({
      id: 'org-next',
      slug: 'next-org',
      name: 'Next org',
      hubSubdomain: 'hub-next',
      tunnelId: 'tunnel-next',
      tunnelToken: 'tunnel-token-next',
      provisioningPhase: 'locally_ready',
    });
    const hub = boot();
    const hold = holdAt('tunnel started');
    const checked = Reflect.get(hub.registration, 'checkRegistrationWithCloud').call(hub.registration) as Promise<boolean>;
    await hold.reached;

    await resets['Settings > Reset registration'](hub);
    hold.release();

    // "Registered" here would stop the polling the reset started.
    await expect(checked).resolves.toBe(false);
    await settled();
    expect(leftOn(hub)).toEqual(UNREGISTERED);
    await vi.waitFor(() => expect(Reflect.get(hub.registration, 'checkInterval')).not.toBeNull());
  });

  it('leaves one polling interval on a Hub that was already polling when it reset', async () => {
    const hub = boot();
    await Reflect.get(hub.registration, 'pollRegistration').call(hub.registration);
    const before = Reflect.get(hub.registration, 'checkInterval');
    expect(before).not.toBeNull();
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    try {
      await resets['Start fresh'](hub);

      await vi.waitFor(() => expect(Reflect.get(hub.registration, 'checkInterval')).not.toBe(before));
      expect(cleared).toHaveBeenCalledWith(before);
    } finally {
      cleared.mockRestore();
    }
  });

  it('lets a pairing started after the reset complete', async () => {
    const hub = boot();
    const hold = holdAt('tunnel started');
    await hub.registration.pairDevice('ABC123');
    await hold.reached;
    await resets['Settings > Reset registration'](hub);
    hold.release();
    await settled();
    expect(leftOn(hub)).toEqual(UNREGISTERED);

    await expect(hub.registration.pairDevice('DEF456')).resolves.toMatchObject({ success: true });
    await settled();

    expect(leftOn(hub)).toEqual(REGISTERED);
  });

  it('leaves a newer pairing alone when the overtaken one resumes after it', async () => {
    const hub = boot();
    const hold = holdAt('tunnel started');
    await hub.registration.pairDevice('ABC123');
    await hold.reached;
    await resets['Settings > Reset registration'](hub);

    // The overtaken pairing is still in its tunnel step when the next one starts and finishes.
    const overtaken = setups.splice(0);
    await expect(hub.registration.pairDevice('DEF456')).resolves.toMatchObject({ success: true });
    await settled();
    expect(leftOn(hub)).toEqual(REGISTERED);

    hold.release();
    await Promise.allSettled(overtaken);

    expect(leftOn(hub)).toEqual(REGISTERED);
  });
});
