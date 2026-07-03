import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { type ApiKeyRow, ApiKeyRepository } from '../api-key.repository';
import { McpApiKeyService } from '../mcp-api-key.service';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Build a stored row from the values insert() was called with (echoes what the DB would return).
 *  audience defaults to 'mcp' so row fixtures can omit it. */
function rowFrom(values: Omit<Parameters<ApiKeyRepository['insert']>[0], 'audience'> & { audience?: string }, id = 1): ApiKeyRow {
  return { id, audience: 'mcp', lastUsedAt: null, createdAt: '2026-01-01T00:00:00Z', ...values };
}

describe('McpApiKeyService', () => {
  let repo: MockProxy<ApiKeyRepository>;
  let service: McpApiKeyService;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    repo = mock<ApiKeyRepository>();
    repo.insert.mockImplementation(async (values) => rowFrom(values));
    repo.insertIfHashAbsent.mockImplementation(async (values) => rowFrom(values));
    repo.touchLastUsed.mockResolvedValue(undefined); // real repo returns a Promise (validate chains .catch)
    service = new McpApiKeyService(repo, mock<LoggerService>());
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('returns a 64-hex raw key once and stores only its SHA-256 hash + prefix', async () => {
      const res = await service.create('CLI');
      expect(res.key).toMatch(/^[a-f0-9]{64}$/);
      const stored = repo.insert.mock.calls[0][0];
      expect(stored.hashedKey).toBe(sha256(res.key)); // hash at rest, never the raw
      expect(stored.hashedKey).not.toBe(res.key);
      expect(stored.prefix).toBe(res.key.slice(0, 8));
      expect(stored.managed).toBe(false);
      expect(stored.audience).toBe('mcp'); // MCP service tags every key with its audience
    });
  });

  describe('validate', () => {
    it('accepts a token that hashes to a stored, non-expired key and bumps last-used', async () => {
      repo.findByHash.mockResolvedValue(
        rowFrom({ name: 'k', prefix: 'p', hashedKey: sha256('raw'), managed: false, ownerAppUrn: null, expiresAt: null }),
      );
      expect(await service.validate('raw')).toBe(true);
      expect(repo.findByHash).toHaveBeenCalledWith(sha256('raw'), 'mcp');
      expect(repo.touchLastUsed).toHaveBeenCalled();
    });

    it('rejects an unknown key and an empty token', async () => {
      repo.findByHash.mockResolvedValue(undefined);
      expect(await service.validate('nope')).toBe(false);
      expect(await service.validate('')).toBe(false);
    });

    it('rejects an expired key', async () => {
      repo.findByHash.mockResolvedValue(
        rowFrom({ name: 'k', prefix: 'p', hashedKey: sha256('raw'), managed: false, ownerAppUrn: null, expiresAt: '2000-01-01T00:00:00Z' }),
      );
      expect(await service.validate('raw')).toBe(false);
    });

    it('does not authenticate a key that exists only under a different audience', async () => {
      // Audience isolation: the same secret stored for another surface (e.g. 'rest') must not open MCP.
      // The repo mock honours its audience arg, so a lookup scoped to 'mcp' misses the 'rest' row.
      const restRow = rowFrom({
        name: 'rest',
        prefix: 'p',
        hashedKey: sha256('raw'),
        managed: false,
        ownerAppUrn: null,
        expiresAt: null,
        audience: 'rest',
      });
      repo.findByHash.mockImplementation(async (hash, audience) =>
        hash === restRow.hashedKey && audience === restRow.audience ? restRow : undefined,
      );
      expect(await service.validate('raw')).toBe(false);
      expect(repo.findByHash).toHaveBeenCalledWith(sha256('raw'), 'mcp'); // never queried the 'rest' slice
    });
  });

  describe('provisionManagedKey', () => {
    it("preserves the app's existing key when it still validates as that app's managed key", async () => {
      repo.findByHash.mockResolvedValue(
        rowFrom({ name: 'openclaw', prefix: 'p', hashedKey: sha256('existing'), managed: true, ownerAppUrn: 'openclaw:ci-store', expiresAt: null }),
      );
      const key = await service.provisionManagedKey({ appUrn: 'openclaw:ci-store', appName: 'openclaw', existingRawKey: 'existing' });
      expect(key).toBe('existing'); // no churn
      expect(repo.insert).not.toHaveBeenCalled();
      expect(repo.deleteByOwnerAppUrn).not.toHaveBeenCalled();
    });

    it('mints a fresh key (revoking stale ones) when there is no valid existing key', async () => {
      repo.findByHash.mockResolvedValue(undefined);
      const key = await service.provisionManagedKey({ appUrn: 'openclaw:ci-store', appName: 'openclaw' });
      expect(repo.deleteByOwnerAppUrn).toHaveBeenCalledWith('openclaw:ci-store', 'mcp'); // scoped to the MCP audience
      const stored = repo.insert.mock.calls[0][0];
      expect(stored.managed).toBe(true);
      expect(stored.ownerAppUrn).toBe('openclaw:ci-store');
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('seedDefaultKeyIfEmpty', () => {
    it('seeds MCP_API_KEY as the "Default" key when the store is empty (conflict-tolerant insert)', async () => {
      process.env.MCP_API_KEY = 'legacy-key';
      repo.countByAudience.mockResolvedValue(0);
      await service.seedDefaultKeyIfEmpty();
      // insertIfHashAbsent (not plain insert) so a double-start race can't kill bootstrap.
      const stored = repo.insertIfHashAbsent.mock.calls[0][0];
      expect(stored.name).toBe('Default');
      expect(stored.audience).toBe('mcp');
      expect(stored.hashedKey).toBe(sha256('legacy-key'));
    });

    it('is a no-op when keys already exist (so a deliberately revoked key is never resurrected) or no key is set', async () => {
      process.env.MCP_API_KEY = 'legacy-key';
      repo.countByAudience.mockResolvedValue(2);
      await service.seedDefaultKeyIfEmpty();

      delete process.env.MCP_API_KEY;
      repo.countByAudience.mockResolvedValue(0);
      await service.seedDefaultKeyIfEmpty();

      expect(repo.insertIfHashAbsent).not.toHaveBeenCalled();
      expect(repo.insert).not.toHaveBeenCalled();
    });
  });
});
