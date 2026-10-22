import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUrn } from '@ci-hub/common/types';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { memoryConnection } from '@/core/database/drizzle/schema';
import { MemoryConnectService } from '@/modules/memory-connect/memory-connect.service';
import { MemoryConnectionRepository } from '@/modules/memory-connect/memory-connection.repository';
import { MemoryConnectionService } from '@/modules/memory-connect/memory-connection.service';
import { type TestDatabase, createTestDatabase } from '../utils/create-test-database';

/*
 * Two people on one Hub, against the real database: person 2 connects OpenClaw to CI Memory, then
 * person 1 (the owner) opens OpenClaw's page, chooses "Not now" and finally connects too. Only the
 * finished connect may change whose key the app runs with (Companion-Hub#2080). CI Memory, the app
 * restart and the consent round trip are stand-ins; the rows and the key the app is given are real.
 */
describe('Memory connect with two Hub people', () => {
  const APP = 'ci-openclaw:ci-marketplace' as AppUrn;
  const PROVIDER = { appUrn: 'ci-memory:ci-marketplace', internalUrl: 'http://gateway:8642', publicUrl: 'https://memory.example.org' };

  let db: TestDatabase;
  let connections: MemoryConnectionService;
  let service: MemoryConnectService;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const exchange = { exchange: vi.fn(), revoke: vi.fn(), rotate: vi.fn(), isKeyValid: vi.fn() };
  const lifecycle = { restartApp: vi.fn(), restartAppAndWait: vi.fn(), regenerateAppEnv: vi.fn() };
  const pending = { create: vi.fn(), consume: vi.fn(), recordOutcome: vi.fn() };

  beforeAll(async () => {
    db = await createTestDatabase('memoryconnecttwopeople');
    connections = new MemoryConnectionService(
      new MemoryConnectionRepository(db as never),
      new EncryptionService({ get: () => 'two-people-test-secret' } as never),
      logger as never,
    );
    const resolver = {
      findProvider: vi.fn().mockResolvedValue(PROVIDER),
      getProviderRuntimeInfo: vi.fn().mockResolvedValue({ status: 'ready', localOnly: false }),
      isConsumerApp: vi.fn().mockResolvedValue(true),
      getAppName: vi.fn().mockResolvedValue('OpenClaw WebCLI'),
      getAppAccessUrls: vi.fn().mockResolvedValue({ publicUrl: 'https://openclaw.example.org' }),
    };
    service = new MemoryConnectService(
      resolver as never,
      exchange as never,
      connections,
      pending as never,
      { getFirstDeviceRegistration: vi.fn().mockResolvedValue({ hubSubdomain: 'hub-test' }) } as never,
      { getConfig: () => ({ domain: 'example.org', userSettings: { internalIp: '192.168.1.9', port: 80 } }) } as never,
      logger as never,
      { getAppByUrn: vi.fn().mockResolvedValue({ status: 'running' }) } as never,
      { getHealth: () => 'up', getHealthNow: async () => 'up', invalidate: vi.fn() } as never,
      { get: () => lifecycle } as never,
    );
  });

  beforeEach(async () => {
    await db.delete(memoryConnection);
    vi.clearAllMocks();
    exchange.revoke.mockResolvedValue(true);
    exchange.isKeyValid.mockResolvedValue(true);
    lifecycle.restartApp.mockResolvedValue({ requestId: 'r' });
    lifecycle.restartAppAndWait.mockResolvedValue(true);
  });

  /** The consent round trip as the callback sees it: CI Memory hands back a code for `key`. */
  async function finishConnect(hubUserId: string, key: string) {
    pending.consume.mockReturnValueOnce({ outcome: 'consumed', appUrn: APP, next: 'https://openclaw.example.org/', userId: hubUserId });
    exchange.exchange.mockResolvedValueOnce({ appUrn: APP, key, expiresAt: '2026-12-31T00:00:00.000Z' });

    return service.handleCallback(`code-${key}`, `state-${key}`, hubUserId);
  }

  async function rowOf(hubUserId: number) {
    const [row] = await db.select().from(memoryConnection).where(eq(memoryConnection.hubUserId, hubUserId));

    return row;
  }

  it("keeps person 2's connection while person 1 looks, skips and is refused a disconnect", async () => {
    await finishConnect('2', 'key-of-2');
    expect((await connections.getInjectableCreds(APP))?.token).toBe('key-of-2');
    vi.clearAllMocks();

    // Person 1 opens OpenClaw's page in the Hub. OpenClaw's own gate asks the Hub too.
    const ui = await service.getUiStatus(APP, undefined, '1');
    const gate = await service.getStatus(APP, undefined, '1');

    expect(ui).toMatchObject({ state: 'unconfigured', connectedByOther: true });
    expect(gate.state).toBe('unconfigured');
    expect(exchange.revoke).not.toHaveBeenCalled();
    expect(lifecycle.restartApp).not.toHaveBeenCalled();
    expect(lifecycle.restartAppAndWait).not.toHaveBeenCalled();
    expect((await rowOf(2)).state).toBe('connected');

    // "Not now" on OpenClaw's gate makes person 1's row the app's newest. The app keeps person 2's key.
    await service.skip(APP, '1');
    expect((await rowOf(1)).state).toBe('skipped');
    expect((await connections.getInjectableCreds(APP))?.token).toBe('key-of-2');

    await expect(service.disconnect(APP, '1')).rejects.toMatchObject({ message: 'MEMORY_CONNECT_DISCONNECT_REFUSED', status: 403 });
    expect(exchange.revoke).not.toHaveBeenCalled();
    expect((await rowOf(2)).state).toBe('connected');

    // Person 2 still sees their own connection.
    expect(await service.getUiStatus(APP, undefined, '2')).toMatchObject({ state: 'connected', connectedByOther: false });
  });

  it("hands the app to person 1 only when person 1 finishes Connect, revoking person 2's key first", async () => {
    await finishConnect('2', 'key-of-2');
    vi.clearAllMocks();

    const result = await finishConnect('1', 'key-of-1');

    expect(result.error).toBeUndefined();
    expect(exchange.revoke).toHaveBeenCalledTimes(1);
    expect(exchange.revoke.mock.invocationCallOrder[0]).toBeLessThan(exchange.exchange.mock.invocationCallOrder[0]);
    expect(await rowOf(2)).toMatchObject({ state: 'unconfigured', encryptedKey: null });
    expect((await rowOf(1)).state).toBe('connected');
    expect((await connections.getInjectableCreds(APP))?.token).toBe('key-of-1');
    expect(await service.getUiStatus(APP, undefined, '2')).toMatchObject({ state: 'unconfigured', connectedByOther: true });
  });

  it("tells person 1 the truth when the connect fails after person 2's key was already revoked", async () => {
    await finishConnect('2', 'key-of-2');
    vi.clearAllMocks();
    pending.consume.mockReturnValueOnce({ outcome: 'consumed', appUrn: APP, next: 'https://openclaw.example.org/', userId: '1' });
    exchange.exchange.mockRejectedValueOnce(new Error('CI Memory answered 502'));

    const result = await service.handleCallback('code-x', 'state-x', '1');

    expect(result).toEqual({ next: '/?memoryConnect=previous_removed', error: true });
    expect(await rowOf(2)).toMatchObject({ state: 'unconfigured', encryptedKey: null });
    expect(await connections.getInjectableCreds(APP)).toBeNull();
    expect(lifecycle.restartApp).toHaveBeenCalled();
  });

  it("treats a connection with no Hub person on it as nobody's", async () => {
    // Stored the way rows from before per-person connections read: hub_user_id 0.
    await connections.storeConnected(APP, PROVIDER.internalUrl, 'key-of-nobody', '2026-12-31T00:00:00.000Z');
    expect((await rowOf(0)).state).toBe('connected');

    expect(await service.getUiStatus(APP, undefined, '1')).toMatchObject({ state: 'connected', connectedByOther: false });
    expect(await service.getStatus(APP, undefined, '1')).toMatchObject({ state: 'connected', connectedByOther: false });

    await service.disconnect(APP, '1');

    expect(exchange.revoke).toHaveBeenCalledTimes(1);
    expect(await rowOf(0)).toMatchObject({ state: 'unconfigured', encryptedKey: null });
    expect(await connections.getInjectableCreds(APP)).toBeNull();
  });
});
