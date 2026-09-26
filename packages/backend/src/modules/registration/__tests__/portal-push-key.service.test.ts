import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PORTAL_PUSH_KEY_NAME, PortalPushKeyService } from '../portal-push-key.service';

/*
 * The key Portal presents for its pushes, minted here and delivered over the
 * check-in. What matters: the raw key travels only until Portal confirms; a
 * confirmed delivery is what retires the device key as a bearer (the settings
 * the middleware reads); a lost or revoked key is replaced, never resurrected.
 */
describe('PortalPushKeyService', () => {
  const settings: Record<string, string | null> = {};
  const config = {
    get: vi.fn((key: string) => settings[key] ?? null),
    setFileOnlySettings: vi.fn(async (patch: Record<string, string>) => {
      for (const [key, value] of Object.entries(patch)) {
        settings[key] = value || null;
      }
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const rows: Array<{ id: number; prefix: string; scopes: string[] }> = [];
  let nextId = 1;
  const apiKeys = {
    list: vi.fn(async () => rows.map((row) => ({ ...row }))),
    create: vi.fn(async (name: string, opts: { scopes: string[] }) => {
      const key = `${nextId}`.padStart(8, 'f') + 'a'.repeat(56);
      const row = { id: nextId++, prefix: key.slice(0, 8), scopes: opts.scopes, name };
      rows.push(row);
      return { ...row, key };
    }),
    revoke: vi.fn(async (id: number) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
      return index >= 0;
    }),
  };
  let service: PortalPushKeyService;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(settings)) delete settings[key];
    rows.splice(0);
    nextId = 1;
    service = new PortalPushKeyService(apiKeys as never, config as never, logger as never);
  });

  it('mints a portal-scoped row on first use and sends the raw key until Portal confirms', async () => {
    const fields = await service.checkInFields();

    expect(apiKeys.create).toHaveBeenCalledWith(PORTAL_PUSH_KEY_NAME, { scopes: ['portal'] });
    expect(fields).toEqual({ hub_push_key_prefix: rows[0]?.prefix, hub_push_key: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(settings.portalPushKeyPrefix).toBe(rows[0]?.prefix);
    expect(settings.portalPushKeyPending).toBe(fields?.hub_push_key);
    expect(settings.portalPushKeyDeliveredAt).toBeNull();

    // Not yet confirmed: the next check-in carries it again.
    expect(await service.checkInFields()).toEqual(fields);
    expect(apiKeys.create).toHaveBeenCalledTimes(1);
  });

  it("drops the raw key and records delivery once Portal answers with the key's fingerprint", async () => {
    const fields = await service.checkInFields();

    await service.acknowledge({ status: 'OK', hub_push_key_prefix: fields?.hub_push_key_prefix });

    expect(settings.portalPushKeyPending).toBeNull();
    expect(settings.portalPushKeyDeliveredAt).toEqual(expect.stringMatching(/^\d{4}-/));
    // From here the fingerprint alone travels.
    expect(await service.checkInFields()).toEqual({ hub_push_key_prefix: fields?.hub_push_key_prefix });
  });

  it('concludes nothing from a Portal that does not answer the field (predates the exchange)', async () => {
    const fields = await service.checkInFields();

    await service.acknowledge({ status: 'OK' });

    expect(settings.portalPushKeyPending).toBe(fields?.hub_push_key);
    expect(settings.portalPushKeyDeliveredAt).toBeNull();
  });

  it('keeps resending while Portal names another key and the raw key is still on hand', async () => {
    const fields = await service.checkInFields();

    await service.acknowledge({ status: 'OK', hub_push_key_prefix: 'deadbeef' });

    expect(settings.portalPushKeyPending).toBe(fields?.hub_push_key);
    expect(apiKeys.create).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('resending'));
  });

  it('mints a replacement when Portal has lost the key after delivery', async () => {
    const first = await service.checkInFields();
    await service.acknowledge({ status: 'OK', hub_push_key_prefix: first?.hub_push_key_prefix });

    // Portal re-imaged, or the device was re-registered: it holds nothing for us.
    await service.acknowledge({ status: 'OK', hub_push_key_prefix: null });

    expect(apiKeys.create).toHaveBeenCalledTimes(2);
    expect(apiKeys.revoke).toHaveBeenCalledWith(1);
    expect(settings.portalPushKeyPrefix).toBe(rows[0]?.prefix);
    expect(settings.portalPushKeyPending).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(settings.portalPushKeyDeliveredAt).toBeNull();
  });

  it('mints a replacement when an operator revoked the row', async () => {
    await service.checkInFields();
    rows.splice(0); // revoked in Settings → Security

    const fields = await service.checkInFields();

    expect(apiKeys.create).toHaveBeenCalledTimes(2);
    expect(fields?.hub_push_key_prefix).toBe(rows[0]?.prefix);
  });

  it('forget() revokes and clears everything, so a re-paired Hub delivers a fresh key', async () => {
    const first = await service.checkInFields();
    await service.acknowledge({ status: 'OK', hub_push_key_prefix: first?.hub_push_key_prefix });

    await service.forget();

    expect(rows).toHaveLength(0);
    expect(settings.portalPushKeyPrefix).toBeNull();
    expect(settings.portalPushKeyDeliveredAt).toBeNull();
    const next = await service.checkInFields();
    expect(next?.hub_push_key).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(next?.hub_push_key_prefix).not.toBe(first?.hub_push_key_prefix);
  });

  it('never fails a check-in: a key store error yields null fields and a warning', async () => {
    apiKeys.list.mockRejectedValueOnce(new Error('db down'));
    settings.portalPushKeyPrefix = 'abcdef01';

    await expect(service.checkInFields()).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});
