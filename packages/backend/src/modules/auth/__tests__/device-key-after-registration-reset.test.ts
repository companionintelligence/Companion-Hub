import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { TUNNEL_DIR } from '@/common/constants';
import { TranslatableError } from '@/common/error/translatable-error';
import type { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import type { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { PortalPushKeyService } from '@/modules/registration/portal-push-key.service';
import { probePublicHostname } from '@/modules/registration/public-reachability';
import { RegistrationController } from '@/modules/registration/registration.controller';
import { RegistrationService } from '@/modules/registration/registration.service';
import { FactoryResetService } from '@/modules/system/factory-reset.service';
import { AuthGuard } from '../auth.guard';
import { AuthMiddleware } from '../auth.middleware';

vi.mock('axios');
// The public-URL probe opens sockets and asks real nameservers; nothing here may reach the network.
vi.mock('@/modules/registration/public-reachability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/registration/public-reachability')>()),
  probePublicHostname: vi.fn(),
}));
vi.mock('@/modules/app-lifecycle/commands/uninstall-app-command', () => ({ UninstallAppCommand: class {} }));

/*
 * A registration reset forgets that Portal holds the push key but keeps the Portal device key, so the
 * next pairing can prove this is the same device. The device key must not authenticate on the Hub's
 * own API in between, after any of the four resets, nor after the backend restarts.
 *
 * Driven through the real AuthMiddleware and AuthGuard, RegistrationService, PortalPushKeyService and
 * ApiKeyService. What they share is `Persisted`: settings.json, the database rows these paths read and
 * write and the files (memfs). A restart is `boot()` again over the same `Persisted`. Portal is axios.
 */

const OLD_DEVICE_KEY = 'device-key-from-the-last-pairing';
const NEW_DEVICE_KEY = 'device-key-from-the-next-pairing';
const DEVICE_ID = 'device-under-test';
const TOKEN_PATH = path.join(TUNNEL_DIR, 'token');

const ENV: Record<string, unknown> = {
  ciCloudUrl: 'https://portal.example.test',
  domain: 'example.com',
  version: '0.0.0-test',
  jwtSecret: 'jwt-secret-for-tests',
  rootFolderHost: '/opt/ci-hub',
  directories: { dataDir: '/data' },
};

type Row = Record<string, unknown>;

interface Persisted {
  /** state/settings.json, as `ConfigurationService` holds it. */
  settings: Record<string, string>;
  deviceRegistrations: Array<Row & { id: string }>;
  apiKeys: Array<Row & { id: number; hashedKey: string }>;
  operators: Array<{ id: number; username: string }>;
}

/** Runs `fn` as if `ms` had passed, so a check-in is not held back by the 30-second throttle. */
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + ms);
  try {
    return await fn();
  } finally {
    clock.mockRestore();
  }
}

function configOver(disk: Persisted) {
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

interface Hooks {
  beforeDeleteAll?: () => Promise<void>;
  /** Thrown, one per read, by the next reads of the registration row. */
  failReads?: unknown[];
}

function deviceRegistrationsOver(disk: Persisted, hooks: Hooks) {
  const update = async (id: string, patch: Row) => {
    const row = disk.deviceRegistrations.find((candidate) => candidate.id === id);
    if (row) Object.assign(row, patch);
    return row ?? null;
  };
  return {
    getFirstDeviceRegistration: async () => {
      const failure = hooks.failReads?.shift();
      if (failure) throw failure;
      return disk.deviceRegistrations[0] ?? null;
    },
    hasAnyDeviceRegistration: async () => disk.deviceRegistrations.length > 0,
    getDeviceRegistrationById: async (id: string) => disk.deviceRegistrations.find((row) => row.id === id) ?? null,
    createDeviceRegistration: async (row: Row & { id: string }) => {
      disk.deviceRegistrations.push({ ...row });
      return row;
    },
    updateDeviceRegistration: update,
    updateProvisioningState: (id: string, phase: string, reasons: string[] = []) =>
      update(id, { provisioningPhase: phase, degradedReasons: JSON.stringify(reasons) }),
    deleteAll: async () => {
      await hooks.beforeDeleteAll?.();
      disk.deviceRegistrations.splice(0);
    },
  };
}

function apiKeyRowsOver(disk: Persisted) {
  let nextId = Math.max(0, ...disk.apiKeys.map((row) => row.id)) + 1;
  return {
    insert: async (row: Row & { hashedKey: string }) => {
      const stored = { ...row, id: nextId++, createdAt: new Date().toISOString(), lastUsedAt: null };
      disk.apiKeys.push(stored);
      return stored;
    },
    findByHash: async (hashedKey: string) => disk.apiKeys.find((row) => row.hashedKey === hashedKey),
    touchLastUsed: async () => undefined,
    list: async () => disk.apiKeys.map((row) => ({ ...row, createdByUsername: null })),
    deleteById: async (id: number) => {
      const index = disk.apiKeys.findIndex((row) => row.id === id);
      if (index < 0) return 0;
      disk.apiKeys.splice(index, 1);
      return 1;
    },
  };
}

/** What Portal does with this Hub's calls. */
const portal = {
  /** Stores a delivered push key and names it in its answer. Off: a Portal that predates the push key. */
  knowsPushKeys: true,
  heldPushKeyPrefix: null as string | null,
  /** Answers the next check-in `DEVICE_NOT_ACTIVE`, as after an owner deletes the device. */
  deviceRemoved: false,
};

const pairingAnswer = {
  device_id: DEVICE_ID,
  organization_id: 'org-next',
  organization_name: 'Next org',
  slug: 'next-org',
  subdomain: 'hub-next',
  tunnel_id: 'tunnel-next',
  tunnel_token: 'tunnel-token-next',
  api_key: NEW_DEVICE_KEY,
  domain: 'example.test',
};

describe('the Portal device key after a registration reset', () => {
  const cloudflare = mock<CloudflareClientService>();
  const traefik = { writeHubRoute: vi.fn(async () => undefined) };
  const hooks: Hooks = {};
  const booted: RegistrationService[] = [];
  let disk: Persisted;

  /** One backend process over `disk`. */
  function boot() {
    const logger = mock<LoggerService>();
    const config = configOver(disk);
    const apiKeys = new ApiKeyService(apiKeyRowsOver(disk) as never, logger);
    const pushKeys = new PortalPushKeyService(apiKeys, config as never, logger);
    const moduleRef = { get: (token: unknown) => (token === PortalPushKeyService ? pushKeys : undefined) };
    const registration = new RegistrationService(
      config as never,
      logger,
      cloudflare,
      traefik as never,
      deviceRegistrationsOver(disk, hooks) as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      moduleRef as never,
    );
    vi.spyOn(registration, 'getDeviceId').mockResolvedValue(DEVICE_ID);
    booted.push(registration);

    const sessions = { resolveSessionUserId: () => null, getSessionExpiresAt: () => null };
    const operators = { getFirstOperator: async () => disk.operators[0] ?? null, getUserDtoById: async () => null };
    const sessionUserCache = { get: () => undefined };
    const middleware = new AuthMiddleware(sessions as never, config as never, operators as never, sessionUserCache as never, apiKeys, registration);
    const guard = new AuthGuard(logger);

    return {
      registration,
      config,
      logger,
      /** What `AuthGuard` answers `GET /api/api-keys` sent with this bearer: 200 when it lets it through. */
      async answer(token: string): Promise<number> {
        const req = {
          cookies: {},
          headers: { authorization: `Bearer ${token}` },
          query: {},
          get: () => undefined,
          method: 'GET',
          originalUrl: '/api/api-keys',
          url: '/api/api-keys',
        } as unknown as Request;
        await middleware.use(req, {} as never, () => undefined);
        try {
          await guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never);
          return 200;
        } catch (error) {
          if (error instanceof TranslatableError) return error.getStatus();
          throw error;
        }
      },
    };
  }

  /** A Hub paired under `OLD_DEVICE_KEY` that has checked in once. With `knowsPushKeys`, Portal now holds its push key. */
  async function pairedHub({ knowsPushKeys = true } = {}) {
    portal.knowsPushKeys = knowsPushKeys;
    disk.settings.ciHubApiKey = OLD_DEVICE_KEY;
    disk.deviceRegistrations.push({
      id: 'org-test',
      slug: 'org-test',
      name: 'Test org',
      hubSubdomain: 'hub-test',
      tunnelId: 'tunnel-test',
      tunnelToken: 'tunnel-token-test',
      provisioningPhase: 'publicly_ready',
      degradedReasons: '[]',
    });
    disk.operators.push({ id: 1, username: 'owner@example.com' });
    await fs.promises.mkdir(TUNNEL_DIR, { recursive: true });
    await fs.promises.writeFile(TOKEN_PATH, 'tunnel-token-test');

    const hub = boot();
    // Restores the phase from the row, as boot does.
    await expect(hub.registration.isRegisteredAndServing()).resolves.toBe(true);
    await expect(hub.registration.checkForRemoval()).resolves.toBe('still_registered');
    return hub;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    disk = { settings: {}, deviceRegistrations: [], apiKeys: [], operators: [] };
    delete hooks.beforeDeleteAll;
    delete hooks.failReads;
    portal.knowsPushKeys = true;
    portal.heldPushKeyPrefix = null;
    portal.deviceRemoved = false;

    cloudflare.stopTunnel.mockResolvedValue(true);
    cloudflare.loadTunnelTokenFromDisk.mockResolvedValue(undefined as never);
    cloudflare.initializeTunnel.mockImplementation(async (_organizationId, credentials) => {
      await fs.promises.writeFile(TOKEN_PATH, credentials.token);
      return { tunnelId: credentials.tunnelId, token: credentials.token } as never;
    });
    vi.mocked(probePublicHostname).mockResolvedValue({ reachable: true, via: 'system', status: 200 });

    vi.mocked(axios.post).mockImplementation(async (url: string, body?: unknown) => {
      if (url.endsWith('/api/devices/pair')) {
        return { status: 200, data: pairingAnswer };
      }
      if (url.endsWith('/api/devices/check-in')) {
        if (portal.deviceRemoved) {
          return { status: 400, data: { error: 'Device not active', code: 'DEVICE_NOT_ACTIVE' } };
        }
        if (!portal.knowsPushKeys) {
          return { status: 200, data: { status: 'OK' } };
        }
        const sent = body as { hub_push_key_prefix?: string; hub_push_key?: string };
        if (sent.hub_push_key) {
          portal.heldPushKeyPrefix = sent.hub_push_key_prefix ?? null;
        }
        return { status: 200, data: { status: 'OK', hub_push_key_prefix: portal.heldPushKeyPrefix } };
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

  it('refuses the device key after Settings > Reset registration and after a restart', async () => {
    const hub = await pairedHub();
    // Portal holds the push key, so the device key is already refused before the reset.
    expect(disk.settings.portalPushKeyDeliveredAt).toBeTruthy();
    expect(await hub.answer(OLD_DEVICE_KEY)).toBe(401);

    await new RegistrationController(hub.registration, hub.config as never, hub.logger).resetRegistration();

    // Kept for the next pairing; the delivery is forgotten, as it was before.
    expect(disk.settings.ciHubApiKey).toBe(OLD_DEVICE_KEY);
    expect(disk.settings.portalPushKeyDeliveredAt).toBe('');
    expect(await hub.answer(OLD_DEVICE_KEY)).toBe(401);
    expect(await boot().answer(OLD_DEVICE_KEY)).toBe(401);
  });

  it('refuses the device key after a check-in answered DEVICE_NOT_ACTIVE and after a restart', async () => {
    const hub = await pairedHub();
    expect(await hub.answer(OLD_DEVICE_KEY)).toBe(401);
    portal.deviceRemoved = true;

    await expect(later(31_000, () => hub.registration.checkForRemoval())).resolves.toBe('removed');

    expect(disk.settings.ciHubApiKey).toBe(OLD_DEVICE_KEY);
    expect(await hub.answer(OLD_DEVICE_KEY)).toBe(401);
    expect(await boot().answer(OLD_DEVICE_KEY)).toBe(401);
  });

  it('refuses the device key after Start fresh during a pairing that is still provisioning', async () => {
    const hub = await pairedHub();
    await new RegistrationController(hub.registration, hub.config as never, hub.logger).resetRegistration();
    // The tunnel never comes up, so this pairing stays in `provisioning`.
    cloudflare.initializeTunnel.mockReturnValue(new Promise(() => undefined));
    await expect(hub.registration.pairDevice('ABC123')).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(hub.registration.getRegistrationStatus().phase).toBe('provisioning'));
    expect(await hub.answer(NEW_DEVICE_KEY)).toBe(200);

    await expect(hub.registration.prepareFreshSetup()).resolves.toMatchObject({ success: true });

    expect(disk.settings.ciHubApiKey).toBe(NEW_DEVICE_KEY);
    expect(await hub.answer(NEW_DEVICE_KEY)).toBe(401);
  });

  it('refuses the device key after a factory reset, which leaves it in memory until a restart', async () => {
    const hub = await pairedHub();
    expect(await hub.answer(OLD_DEVICE_KEY)).toBe(401);
    const db = {
      // The one statement a factory reset executes: TRUNCATE of these tables, among others.
      execute: vi.fn(async () => {
        disk.deviceRegistrations.splice(0);
        disk.apiKeys.splice(0);
        disk.operators.splice(0);
      }),
      query: { app: { findMany: async () => [] } },
    };
    const filesystem = { createDirectory: async () => true, removeDirectory: async () => true, pathExists: async () => true };
    const factoryReset = new FactoryResetService(
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

    await expect(factoryReset.execute()).resolves.toMatchObject({ success: true });

    expect(disk.settings.ciHubApiKey).toBe(OLD_DEVICE_KEY);
    expect(await hub.answer(OLD_DEVICE_KEY)).toBe(401);
    expect(await boot().answer(OLD_DEVICE_KEY)).toBe(401);
  });

  it('refuses the device key while the reset is still under way', async () => {
    const hub = await pairedHub();
    const answers: number[] = [];
    hooks.beforeDeleteAll = async () => {
      answers.push(await hub.answer(OLD_DEVICE_KEY));
    };

    await hub.registration.resetRegistration();

    expect(answers).toEqual([401]);
  });

  it('refuses the device key while Start fresh resets a Hub whose phase is not restored yet', async () => {
    await pairedHub();
    // A new process before boot restores the phase, on a Hub whose tunnel token file is gone: Start fresh
    // goes ahead, and the reset has no phase change to write to the row before it deletes it.
    await fs.promises.unlink(TOKEN_PATH);
    const restarted = boot();
    const answers: number[] = [];
    hooks.beforeDeleteAll = async () => {
      answers.push(await restarted.answer(OLD_DEVICE_KEY));
    };

    await expect(restarted.registration.prepareFreshSetup()).resolves.toMatchObject({ success: true });

    expect(answers).toEqual([401]);
  });

  it('refuses the device key of a Hub whose Portal never took a push key while the reset is under way', async () => {
    const hub = await pairedHub({ knowsPushKeys: false });
    const answers: number[] = [];
    hooks.beforeDeleteAll = async () => {
      answers.push(await hub.answer(OLD_DEVICE_KEY));
    };

    await hub.registration.resetRegistration();

    // No delivery to forget here: the row, already marked `unregistered`, is what refuses it.
    expect(answers).toEqual([401]);
  });

  it('reads the registration again through a database blip but refuses the device key when it stays unreadable', async () => {
    const hub = await pairedHub({ knowsPushKeys: false });
    const blip = () => Object.assign(new Error('getaddrinfo EAI_AGAIN ci-hub-db'), { code: 'EAI_AGAIN' });

    hooks.failReads = [blip()];
    expect(await hub.answer(OLD_DEVICE_KEY)).toBe(200);

    hooks.failReads = [new Error('relation "device_registration" does not exist')];
    expect(await hub.answer(OLD_DEVICE_KEY)).toBe(401);
    expect(hub.logger.warn).toHaveBeenCalledWith(expect.stringContaining('the Portal device key is refused'));
  });

  it('still accepts the device key on a paired Hub whose Portal never took a push key, also after a restart', async () => {
    const hub = await pairedHub({ knowsPushKeys: false });

    expect(disk.settings.portalPushKeyDeliveredAt).toBe('');
    expect(await hub.answer(OLD_DEVICE_KEY)).toBe(200);
    // The new process has not restored its phase yet; the row is what counts.
    expect(await boot().answer(OLD_DEVICE_KEY)).toBe(200);
  });

  it("accepts the next pairing's device key from the start, until Portal holds the new push key", async () => {
    const hub = await pairedHub();
    await new RegistrationController(hub.registration, hub.config as never, hub.logger).resetRegistration();
    let tunnelUp: () => void = () => undefined;
    cloudflare.initializeTunnel.mockImplementation(async (_organizationId, credentials) => {
      await new Promise<void>((resolve) => (tunnelUp = resolve));
      await fs.promises.writeFile(TOKEN_PATH, credentials.token);
      return { tunnelId: credentials.tunnelId, token: credentials.token } as never;
    });

    await expect(hub.registration.pairDevice('ABC123')).resolves.toMatchObject({ success: true });

    // Before the row exists.
    await vi.waitFor(() => expect(cloudflare.initializeTunnel).toHaveBeenCalled());
    expect(hub.registration.getRegistrationStatus().phase).toBe('provisioning');
    expect(await hub.answer(NEW_DEVICE_KEY)).toBe(200);
    expect(await hub.answer(OLD_DEVICE_KEY)).toBe(401);

    tunnelUp();
    await vi.waitFor(() => expect(hub.registration.getRegistrationStatus().phase).toBe('publicly_ready'));
    expect(await hub.answer(NEW_DEVICE_KEY)).toBe(200);
    expect(await boot().answer(NEW_DEVICE_KEY)).toBe(200);

    await expect(later(31_000, () => hub.registration.checkForRemoval())).resolves.toBe('still_registered');
    expect(disk.settings.portalPushKeyDeliveredAt).toBeTruthy();
    expect(await hub.answer(NEW_DEVICE_KEY)).toBe(401);
  });
});
