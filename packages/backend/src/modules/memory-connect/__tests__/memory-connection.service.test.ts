import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryConnectionService } from '../memory-connection.service';
import type { MemoryConnectionRepository, MemoryConnectionRow } from '../memory-connection.repository';

/**
 * Unit tests for the Hub's encrypted memory-key custody + per-app state
 * machine. Repo, encryption, and logger are hand-mocked so we can assert the
 * exact persisted values (encrypt-on-store, decrypt-on-read, graceful
 * degradation on a corrupt row).
 */
function makeMocks() {
  const repo = {
    findByAppUrn: vi.fn(),
    upsert: vi.fn().mockResolvedValue(undefined),
    deleteByAppUrn: vi.fn().mockResolvedValue(1),
  };
  const encryption = {
    encrypt: vi.fn((data: string) => `enc(${data})`),
    decrypt: vi.fn((data: string) => data.replace(/^enc\((.*)\)$/, '$1')),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const service = new MemoryConnectionService(repo as unknown as MemoryConnectionRepository, encryption as never, logger as never);

  return { service, repo, encryption };
}

function row(overrides: Partial<MemoryConnectionRow>): MemoryConnectionRow {
  return {
    id: 1,
    appUrn: 'ci-openclaw:local',
    state: 'unconfigured',
    encryptedKey: null,
    serverUrl: null,
    keyExpiresAt: null,
    createdAt: '2026-07-08T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    ...overrides,
  };
}

describe('MemoryConnectionService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getState defaults to unconfigured when the app is untouched', async () => {
    const { service, repo } = makeMocks();
    repo.findByAppUrn.mockResolvedValue(undefined);

    expect(await service.getState('ci-openclaw:local')).toBe('unconfigured');
  });

  it('storeConnected encrypts the key (salted by URN) and flips state to connected', async () => {
    const { service, repo, encryption } = makeMocks();

    await service.storeConnected('ci-openclaw:local', 'http://gateway:8642', 'raw-key', '2026-10-07T00:00:00.000Z');

    expect(encryption.encrypt).toHaveBeenCalledWith('raw-key', 'ci-openclaw:local');
    expect(repo.upsert).toHaveBeenCalledWith('ci-openclaw:local', {
      state: 'connected',
      serverUrl: 'http://gateway:8642',
      encryptedKey: 'enc(raw-key)',
      keyExpiresAt: '2026-10-07T00:00:00.000Z',
    });
  });

  it('getInjectableCreds decrypts and returns url + token when connected', async () => {
    const { service, repo } = makeMocks();
    repo.findByAppUrn.mockResolvedValue(row({ state: 'connected', encryptedKey: 'enc(raw-key)', serverUrl: 'http://gateway:8642' }));

    expect(await service.getInjectableCreds('ci-openclaw:local')).toEqual({
      url: 'http://gateway:8642',
      token: 'raw-key',
    });
  });

  it('getInjectableCreds returns null when not connected', async () => {
    const { service, repo } = makeMocks();
    repo.findByAppUrn.mockResolvedValue(row({ state: 'skipped' }));

    expect(await service.getInjectableCreds('ci-openclaw:local')).toBeNull();
  });

  it('getInjectableCreds degrades to null (never throws) when decryption fails', async () => {
    const { service, repo, encryption } = makeMocks();
    encryption.decrypt.mockImplementation(() => {
      throw new Error('bad ciphertext');
    });
    repo.findByAppUrn.mockResolvedValue(row({ state: 'connected', encryptedKey: 'corrupt', serverUrl: 'http://gateway:8642' }));

    expect(await service.getInjectableCreds('ci-openclaw:local')).toBeNull();
  });

  it('clear resets state to unconfigured and drops the stored key', async () => {
    const { service, repo } = makeMocks();

    await service.clear('ci-openclaw:local');

    expect(repo.upsert).toHaveBeenCalledWith('ci-openclaw:local', {
      state: 'unconfigured',
      encryptedKey: null,
      serverUrl: null,
      keyExpiresAt: null,
    });
  });

  it('markSkipped and markManual persist their states', async () => {
    const { service, repo } = makeMocks();

    await service.markSkipped('ci-openclaw:local');
    await service.markManual('ci-hermes:local');

    expect(repo.upsert).toHaveBeenCalledWith('ci-openclaw:local', { state: 'skipped' });
    expect(repo.upsert).toHaveBeenCalledWith('ci-hermes:local', { state: 'manual' });
  });

  it('markManual is idempotent: no redundant upsert when already manual', async () => {
    // Env generation calls markManual on every install/update/restart of a
    // manually-configured app; it must not issue a write each time.
    const { service, repo } = makeMocks();
    repo.findByAppUrn.mockResolvedValue(row({ state: 'manual' }));

    await service.markManual('ci-hermes:local');

    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('isConnected requires both connected state and a stored key', async () => {
    const { service, repo } = makeMocks();
    repo.findByAppUrn.mockResolvedValueOnce(row({ state: 'connected', encryptedKey: 'enc(k)' }));
    expect(await service.isConnected('a')).toBe(true);

    repo.findByAppUrn.mockResolvedValueOnce(row({ state: 'connected', encryptedKey: null }));
    expect(await service.isConnected('a')).toBe(false);
  });
});
