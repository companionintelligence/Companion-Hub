import { ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  beforeEach(() => {
    // The admin guard now delegates usability to ApiKeyService.isUsable (single source of the
    // fail-closed expiry rule); give the mock that real behaviour so the guard tests exercise it.
    apiKeys.isUsable.mockImplementation((key) => {
      if (key.expiresAt === null) {
        return true;
      }
      const ms = new Date(key.expiresAt).getTime();
      return !Number.isNaN(ms) && ms > Date.now();
    });
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

  it('refuses to revoke the last usable operator key (409) so the store can never empty and re-seed it', async () => {
    // A managed key does NOT count as retained access — it dies with its app on uninstall,
    // which would empty the store and resurrect the revoked Default key at next boot.
    apiKeys.list.mockResolvedValue([keyInfo({ id: 5 }), keyInfo({ id: 7, managed: true, ownerAppUrn: 'openclaw:ci-store' })]);
    await expect(service.revokeKey(5)).rejects.toThrow(ConflictException);
    expect(apiKeys.revoke).not.toHaveBeenCalled();
  });

  it('ignores expired keys when counting retained access, and always allows revoking a dead key', async () => {
    const expired = keyInfo({ id: 8, expiresAt: '2000-01-01T00:00:00Z' });
    // Live key 5 + expired key 8: revoking 5 would leave only a dead key -> blocked.
    apiKeys.list.mockResolvedValue([keyInfo({ id: 5 }), expired]);
    await expect(service.revokeKey(5)).rejects.toThrow(ConflictException);
    // Revoking the dead key itself is always fine — it cannot reduce access.
    apiKeys.revoke.mockResolvedValue(true);
    expect(await service.revokeKey(8)).toEqual({ revoked: true });
  });

  it('allows revoking a managed key even when it is the only managed key (break-glass)', async () => {
    apiKeys.list.mockResolvedValue([keyInfo({ id: 5 }), keyInfo({ id: 7, managed: true, ownerAppUrn: 'openclaw:ci-store' })]);
    apiKeys.revoke.mockResolvedValue(true);
    expect(await service.revokeKey(7)).toEqual({ revoked: true });
  });
});
