import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import type { HubManageVerdict } from '@/core/portal/hub-manage-verdict';
import { ApiKeyAdminService } from '../api-key-admin.service';
import type { ApiKeyInfo } from '../api-key.service';
import { ApiKeyService } from '../api-key.service';

/** Operator key by default; override for managed/expired variants. */
function keyInfo(overrides: Partial<ApiKeyInfo> & { id: number }): ApiKeyInfo {
  return {
    name: `key-${overrides.id}`,
    prefix: 'abcd1234',
    scopes: ['mcp'],
    capability: 'write',
    managed: false,
    ownerAppUrn: null,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    createdByUserId: null,
    createdByUsername: null,
    ...overrides,
  };
}

describe('ApiKeyAdminService', () => {
  const apiKeys: MockProxy<ApiKeyService> = mock<ApiKeyService>();
  const service = new ApiKeyAdminService(apiKeys, mock<LoggerService>());

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("createKey mints an 'mcp'-scoped operator key and returns the raw key once", async () => {
    apiKeys.create.mockResolvedValue({ ...keyInfo({ id: 5, name: 'CLI' }), key: 'abcd1234RAW' });
    const res = await service.createKey('CLI', 'write', null);
    // Operator keys never carry 'app': that scope requires an owning app URN to pass the
    // callback guard, so an operator-created 'app' key would be a dead credential.
    expect(apiKeys.create).toHaveBeenCalledWith('CLI', { scopes: ['mcp'], capability: 'write', createdByUserId: null });
    expect(res.key).toBe('abcd1234RAW');
  });

  it('createKey mints at the requested capability, so a read-only key is never wide open in between', async () => {
    apiKeys.create.mockResolvedValue({ ...keyInfo({ id: 6, name: 'recall', capability: 'read' }), key: 'raw' });
    await service.createKey('recall', 'read', null);
    expect(apiKeys.create).toHaveBeenCalledWith('recall', { scopes: ['mcp'], capability: 'read', createdByUserId: null });
  });

  it('createKey records the person creating the key, so it acts with their grants and role', async () => {
    apiKeys.create.mockResolvedValue({ ...keyInfo({ id: 7, name: 'n8n', createdByUserId: 4 }), key: 'raw' });
    await service.createKey('n8n', 'write', 4);
    expect(apiKeys.create).toHaveBeenCalledWith('n8n', { scopes: ['mcp'], capability: 'write', createdByUserId: 4 });
  });

  describe('setKeyCapability', () => {
    it('changes the level and reports the transition, not just the new state', async () => {
      apiKeys.findById.mockResolvedValue(keyInfo({ id: 5, capability: 'write' }));
      apiKeys.setCapability.mockResolvedValue(true);

      expect(await service.setKeyCapability(5, 'read')).toEqual({ changed: true, capability: 'read', previousCapability: 'write' });
      expect(apiKeys.setCapability).toHaveBeenCalledWith(5, 'read');
    });

    it('is a no-op when the key is already at that level, and does not write', async () => {
      apiKeys.findById.mockResolvedValue(keyInfo({ id: 5, capability: 'read' }));

      expect(await service.setKeyCapability(5, 'read')).toEqual({ changed: false, capability: 'read', previousCapability: 'read' });
      expect(apiKeys.setCapability).not.toHaveBeenCalled();
    });

    it('reports changed:false for an id that no longer exists (revoked in another tab)', async () => {
      apiKeys.findById.mockResolvedValue(null);

      expect(await service.setKeyCapability(99, 'full')).toEqual({ changed: false, capability: 'full', previousCapability: null });
      expect(apiKeys.setCapability).not.toHaveBeenCalled();
    });

    it("changes a managed app key too — it is the operator's appliance", async () => {
      apiKeys.findById.mockResolvedValue(keyInfo({ id: 7, managed: true, ownerAppUrn: 'openclaw:ci-store' }));
      apiKeys.setCapability.mockResolvedValue(true);

      expect((await service.setKeyCapability(7, 'read')).changed).toBe(true);
    });
  });

  it('listKeys returns every stored key (all scopes, operator + managed)', async () => {
    const rows = [
      keyInfo({ id: 1, scopes: ['inference'] }),
      keyInfo({ id: 2, scopes: ['app'], managed: true, ownerAppUrn: 'importer:ci-marketplace' }),
    ];
    apiKeys.list.mockResolvedValue(rows);
    expect(await service.listKeys(null)).toEqual(rows.map((row) => ({ ...row, hubWideBlocked: null })));
  });

  /*
   * The Hub-wide MCP tools take a key whose creator may manage the Hub. The list says which keys can't,
   * from the Hub's own records, so an owner can see which to revoke or reissue.
   */
  describe('listKeys: which keys the Hub-wide tools refuse', () => {
    const verdicts: Record<number, HubManageVerdict> = { 2: 'allowed', 3: 'refused', 4: 'unknown' };
    const whois = { storedHubManageVerdictFor: vi.fn(async (userId: number) => verdicts[userId] ?? 'unknown') };

    it.each([
      ['a managed app key', keyInfo({ id: 1, scopes: ['mcp', 'app'], managed: true, ownerAppUrn: 'ci-hermes:ci-marketplace' }), 'app-key'],
      ['a key with no recorded creator', keyInfo({ id: 1, createdByUserId: null }), 'no-creator'],
      ['a key whose creator the Hub has stored as a member', keyInfo({ id: 1, createdByUserId: 3, createdByUsername: 'sam' }), 'creator-role'],
      ['a key whose creator is an owner or admin', keyInfo({ id: 1, createdByUserId: 2 }), null],
      ["a key whose creator's role the Hub hasn't stored", keyInfo({ id: 1, createdByUserId: 4 }), null],
      ['a key with no MCP scope', keyInfo({ id: 1, scopes: ['inference'], createdByUserId: null }), null],
      [
        'a managed key that only calls back into the Hub as its app',
        keyInfo({ id: 1, scopes: ['app'], managed: true, ownerAppUrn: 'importer:ci-marketplace' }),
        null,
      ],
    ] as const)('marks %s as %s', async (_label, key, expected) => {
      apiKeys.list.mockResolvedValue([key]);

      expect(await service.listKeys(whois)).toEqual([{ ...key, hubWideBlocked: expected }]);
    });

    it("reads each creator's role once, however many keys they made", async () => {
      apiKeys.list.mockResolvedValue([
        keyInfo({ id: 1, createdByUserId: 3 }),
        keyInfo({ id: 2, createdByUserId: 3 }),
        keyInfo({ id: 3, createdByUserId: 2 }),
      ]);

      await service.listKeys(whois);

      expect(whois.storedHubManageVerdictFor).toHaveBeenCalledTimes(2);
    });

    it("marks no creator's role when WhoIs can't be resolved, and still marks the keys with nobody behind them", async () => {
      apiKeys.list.mockResolvedValue([keyInfo({ id: 1, createdByUserId: 3 }), keyInfo({ id: 2, createdByUserId: null })]);

      expect((await service.listKeys(null)).map((key) => key.hubWideBlocked)).toEqual([null, 'no-creator']);
    });
  });

  it('revokeKey delegates and reports the outcome', async () => {
    apiKeys.list.mockResolvedValue([keyInfo({ id: 5 }), keyInfo({ id: 6 })]); // two operator keys — revoke allowed
    apiKeys.revoke.mockResolvedValue(true);
    expect(await service.revokeKey(5)).toEqual({ revoked: true });
    expect(apiKeys.revoke).toHaveBeenCalledWith(5);
  });

  it('returns revoked:false (not 409) for an id that no longer exists, even when one key remains', async () => {
    apiKeys.list.mockResolvedValue([keyInfo({ id: 6 })]); // id 5 already revoked from another tab
    expect(await service.revokeKey(5)).toEqual({ revoked: false });
    expect(apiKeys.revoke).not.toHaveBeenCalled();
  });

  it('revokes the last operator key, leaving the appliance with none', async () => {
    // Nothing reseeds a key any more, so an empty store is a legitimate end state: the MCP tool
    // surface is simply closed until an operator creates a key. Refusing here would force the
    // appliance to keep a credential alive that its operator had decided to retire.
    apiKeys.list.mockResolvedValue([keyInfo({ id: 5 })]);
    apiKeys.revoke.mockResolvedValue(true);
    expect(await service.revokeKey(5)).toEqual({ revoked: true });
    expect(apiKeys.revoke).toHaveBeenCalledWith(5);
  });

  it('allows revoking a managed key even when it is the only managed key (break-glass)', async () => {
    apiKeys.list.mockResolvedValue([keyInfo({ id: 5 }), keyInfo({ id: 7, managed: true, ownerAppUrn: 'openclaw:ci-store' })]);
    apiKeys.revoke.mockResolvedValue(true);
    expect(await service.revokeKey(7)).toEqual({ revoked: true });
  });
});
