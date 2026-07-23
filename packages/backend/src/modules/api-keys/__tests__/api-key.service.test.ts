import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { type ApiKeyRow, ApiKeyRepository } from '../api-key.repository';
import { ApiKeyService } from '../api-key.service';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Build a stored row from the values insert() was called with (echoes what the DB would return). */
function rowFrom(
  values: Partial<ApiKeyRow> & Pick<ApiKeyRow, 'name' | 'prefix' | 'hashedKey' | 'managed' | 'ownerAppUrn' | 'expiresAt'>,
  id = 1,
): ApiKeyRow {
  return { id, audience: 'mcp', scopes: ['mcp'], lastUsedAt: null, createdAt: '2026-01-01T00:00:00Z', ...values };
}

describe('ApiKeyService', () => {
  let repo: MockProxy<ApiKeyRepository>;
  let service: ApiKeyService;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    repo = mock<ApiKeyRepository>();
    repo.insert.mockImplementation(async (values) => rowFrom(values as never));
    repo.insertIfHashAbsent.mockImplementation(async (values) => rowFrom(values as never));
    repo.touchLastUsed.mockResolvedValue(undefined); // real repo returns a Promise (validate chains .catch)
    service = new ApiKeyService(repo, mock<LoggerService>());
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('returns a 64-hex raw key once and stores only its SHA-256 hash + prefix', async () => {
      const res = await service.create('CLI', { scopes: ['mcp'] });
      expect(res.key).toMatch(/^[a-f0-9]{64}$/);
      const stored = repo.insert.mock.calls[0][0];
      expect(stored.hashedKey).toBe(sha256(res.key)); // hash at rest, never the raw
      expect(stored.hashedKey).not.toBe(res.key);
      expect(stored.prefix).toBe(res.key.slice(0, 8));
      expect(stored.managed).toBe(false);
      expect(stored.scopes).toEqual(['mcp']);
      expect(stored.audience).toBe('mcp'); // transitional dual-write = scopes[0]
    });

    it('dedupes scopes and dual-writes audience from the first scope', async () => {
      await service.create('multi', { scopes: ['app', 'app', 'mcp'] });
      const stored = repo.insert.mock.calls[0][0];
      expect(stored.scopes).toEqual(['app', 'mcp']);
      expect(stored.audience).toBe('app');
    });
  });

  describe('validate', () => {
    it('accepts a token that hashes to a stored, non-expired key carrying the scope and bumps last-used', async () => {
      repo.findByHash.mockResolvedValue(
        rowFrom({ name: 'k', prefix: 'p', hashedKey: sha256('raw'), managed: false, ownerAppUrn: null, expiresAt: null }),
      );
      expect(await service.validate('raw', 'mcp')).toBe(true);
      expect(repo.findByHash).toHaveBeenCalledWith(sha256('raw'));
      expect(repo.touchLastUsed).toHaveBeenCalled();
    });

    it('rejects an unknown key and an empty token', async () => {
      repo.findByHash.mockResolvedValue(undefined);
      expect(await service.validate('nope', 'mcp')).toBe(false);
      expect(await service.validate('', 'mcp')).toBe(false);
    });

    it('rejects an expired key', async () => {
      repo.findByHash.mockResolvedValue(
        rowFrom({ name: 'k', prefix: 'p', hashedKey: sha256('raw'), managed: false, ownerAppUrn: null, expiresAt: '2000-01-01T00:00:00Z' }),
      );
      expect(await service.validate('raw', 'mcp')).toBe(false);
    });

    it("privilege lock: an 'app'-only callback key never opens the MCP surface, and vice versa", async () => {
      repo.findByHash.mockResolvedValue(
        rowFrom({
          name: 'importer',
          prefix: 'p',
          hashedKey: sha256('raw'),
          managed: true,
          ownerAppUrn: 'importer:s',
          expiresAt: null,
          scopes: ['app'],
          audience: 'app',
        }),
      );
      expect(await service.validate('raw', 'mcp')).toBe(false);
      expect(await service.validate('raw', 'app')).toBe(true);
    });

    it('falls back to the audience column for a pre-migration row with empty scopes', async () => {
      // A row written by an old Hub after a rollback (scopes backfill absent) must not lose access.
      repo.findByHash.mockResolvedValue(
        rowFrom({
          name: 'legacy',
          prefix: 'p',
          hashedKey: sha256('raw'),
          managed: false,
          ownerAppUrn: null,
          expiresAt: null,
          scopes: [],
          audience: 'mcp',
        }),
      );
      expect(await service.validate('raw', 'mcp')).toBe(true);
      expect(await service.validate('raw', 'app')).toBe(false);
    });
  });

  describe('resolveManagedAppUrn', () => {
    const managedRow = (scopes: string[]) =>
      rowFrom({ name: 'a', prefix: 'p', hashedKey: sha256('raw'), managed: true, ownerAppUrn: 'a:s', expiresAt: null, scopes });

    it('resolves the owner when the key carries one of the accepted scopes', async () => {
      repo.findByHash.mockResolvedValue(managedRow(['app']));
      expect(await service.resolveManagedAppUrn('raw', ['app', 'mcp'])).toBe('a:s');
    });

    it("resolves a legacy ['mcp'] managed key against the callback scope set (fleet back-compat)", async () => {
      repo.findByHash.mockResolvedValue(managedRow(['mcp']));
      expect(await service.resolveManagedAppUrn('raw', ['app', 'mcp'])).toBe('a:s');
    });

    it('returns null for a key with none of the accepted scopes, a non-managed key, or an empty token', async () => {
      repo.findByHash.mockResolvedValue(managedRow(['mcp']));
      expect(await service.resolveManagedAppUrn('raw', ['app'])).toBeNull();

      repo.findByHash.mockResolvedValue(
        rowFrom({ name: 'op', prefix: 'p', hashedKey: sha256('raw'), managed: false, ownerAppUrn: null, expiresAt: null }),
      );
      expect(await service.resolveManagedAppUrn('raw', ['mcp'])).toBeNull();

      expect(await service.resolveManagedAppUrn('', ['mcp'])).toBeNull();
    });
  });

  describe('provisionManagedKey', () => {
    it("preserves the app's existing key when it still validates as that app's managed key", async () => {
      repo.findByHash.mockResolvedValue(
        rowFrom({ name: 'openclaw', prefix: 'p', hashedKey: sha256('existing'), managed: true, ownerAppUrn: 'openclaw:ci-store', expiresAt: null }),
      );
      const key = await service.provisionManagedKey({
        appUrn: 'openclaw:ci-store',
        appName: 'openclaw',
        existingRawKey: 'existing',
        scopes: ['mcp'],
      });
      expect(key).toBe('existing'); // no churn
      expect(repo.insert).not.toHaveBeenCalled();
      expect(repo.deleteByOwnerAppUrn).not.toHaveBeenCalled();
      expect(repo.updateScopes).not.toHaveBeenCalled(); // scopes already match — nothing to reconcile
    });

    it('reconciles scopes IN PLACE without rotating the key when the desired set changes', async () => {
      // A Hermes-style app upgrading ['mcp'] → ['mcp','app'] must keep the exact credential
      // its running container already holds — only the row's scopes may change.
      repo.findByHash.mockResolvedValue(
        rowFrom({
          id: 7,
          name: 'hermes',
          prefix: 'p',
          hashedKey: sha256('existing'),
          managed: true,
          ownerAppUrn: 'hermes:ci-marketplace',
          expiresAt: null,
          scopes: ['mcp'],
        }),
      );
      const key = await service.provisionManagedKey({
        appUrn: 'hermes:ci-marketplace',
        appName: 'hermes',
        existingRawKey: 'existing',
        scopes: ['mcp', 'app'],
      });
      expect(key).toBe('existing');
      expect(repo.updateScopes).toHaveBeenCalledWith(7, ['mcp', 'app'], 'mcp');
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('mints a fresh key with the requested scopes (revoking stale ones) when there is no valid existing key', async () => {
      repo.findByHash.mockResolvedValue(undefined);
      const key = await service.provisionManagedKey({ appUrn: 'importer:ci-marketplace', appName: 'importer', scopes: ['app'] });
      expect(repo.deleteByOwnerAppUrn).toHaveBeenCalledWith('importer:ci-marketplace');
      const stored = repo.insert.mock.calls[0][0];
      expect(stored.managed).toBe(true);
      expect(stored.ownerAppUrn).toBe('importer:ci-marketplace');
      expect(stored.scopes).toEqual(['app']);
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    });

    it('refuses to preserve a key owned by a DIFFERENT app (mints fresh instead)', async () => {
      repo.findByHash.mockResolvedValue(
        rowFrom({ name: 'other', prefix: 'p', hashedKey: sha256('stolen'), managed: true, ownerAppUrn: 'other:s', expiresAt: null }),
      );
      const key = await service.provisionManagedKey({ appUrn: 'me:s', appName: 'me', existingRawKey: 'stolen', scopes: ['app'] });
      expect(key).not.toBe('stolen');
      expect(repo.deleteByOwnerAppUrn).toHaveBeenCalledWith('me:s');
    });
  });

  describe('seedDefaultKeyIfEmpty', () => {
    it('seeds MCP_API_KEY as the "Default" mcp-scoped key when the store is empty (conflict-tolerant insert)', async () => {
      process.env.MCP_API_KEY = 'legacy-key';
      repo.countByScope.mockResolvedValue(0);
      await service.seedDefaultKeyIfEmpty();
      // insertIfHashAbsent (not plain insert) so a double-start race can't kill bootstrap.
      const stored = repo.insertIfHashAbsent.mock.calls[0][0];
      expect(stored.name).toBe('Default');
      expect(stored.scopes).toEqual(['mcp']);
      expect(stored.audience).toBe('mcp');
      expect(stored.hashedKey).toBe(sha256('legacy-key'));
    });

    it('is a no-op when keys already exist (so a deliberately revoked key is never resurrected) or no key is set', async () => {
      process.env.MCP_API_KEY = 'legacy-key';
      repo.countByScope.mockResolvedValue(2);
      await service.seedDefaultKeyIfEmpty();

      delete process.env.MCP_API_KEY;
      repo.countByScope.mockResolvedValue(0);
      await service.seedDefaultKeyIfEmpty();

      expect(repo.insertIfHashAbsent).not.toHaveBeenCalled();
      expect(repo.insert).not.toHaveBeenCalled();
    });
  });
});
