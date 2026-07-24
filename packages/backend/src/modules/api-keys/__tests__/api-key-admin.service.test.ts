import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyAdminService } from '../api-key-admin.service';
import type { ApiKeyInfo } from '../api-key.service';
import { ApiKeyService } from '../api-key.service';

/** Operator key by default; override for managed/expired variants. */
function keyInfo(overrides: Partial<ApiKeyInfo> & { id: number }): ApiKeyInfo {
  return {
    name: `key-${overrides.id}`,
    prefix: 'abcd1234',
    scopes: ['mcp'],
    managed: false,
    ownerAppUrn: null,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
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
    const res = await service.createKey('CLI');
    // Operator keys never carry 'app': that scope requires an owning app URN to pass the
    // callback guard, so an operator-created 'app' key would be a dead credential.
    expect(apiKeys.create).toHaveBeenCalledWith('CLI', { scopes: ['mcp'] });
    expect(res.key).toBe('abcd1234RAW');
  });

  it('listKeys returns every stored key (all scopes, operator + managed)', async () => {
    const rows = [keyInfo({ id: 1 }), keyInfo({ id: 2, scopes: ['app'], managed: true, ownerAppUrn: 'importer:ci-marketplace' })];
    apiKeys.list.mockResolvedValue(rows);
    expect(await service.listKeys()).toEqual(rows);
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
