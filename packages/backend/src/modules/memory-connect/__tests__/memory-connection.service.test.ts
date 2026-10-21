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
    findByAppUrnAndUser: vi.fn(),
    findLatestConnected: vi.fn(),
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
    hubUserId: 0,
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
    expect(repo.upsert).toHaveBeenCalledWith(
      'ci-openclaw:local',
      {
        state: 'connected',
        serverUrl: 'http://gateway:8642',
        encryptedKey: 'enc(raw-key)',
        keyExpiresAt: '2026-10-07T00:00:00.000Z',
      },
      0,
    );
  });

  it('getInjectableCreds decrypts and returns url + token when connected', async () => {
    const { service, repo } = makeMocks();
    repo.findLatestConnected.mockResolvedValue(row({ state: 'connected', encryptedKey: 'enc(raw-key)', serverUrl: 'http://gateway:8642' }));

    expect(await service.getInjectableCreds('ci-openclaw:local')).toEqual({
      url: 'http://gateway:8642',
      token: 'raw-key',
    });
  });

  it('getInjectableCreds returns null when nobody is connected', async () => {
    const { service, repo } = makeMocks();
    repo.findLatestConnected.mockResolvedValue(undefined);

    expect(await service.getInjectableCreds('ci-openclaw:local')).toBeNull();
  });

  it("getInjectableCreds reads the newest CONNECTED row, so another person's newer skip does not unplug the app", async () => {
    // Person 2 connected; person 1 later chose "Not now", which makes person 1's skipped row the
    // app's newest. The app must keep person 2's key, not lose it at its next restart.
    const { service, repo } = makeMocks();
    repo.findByAppUrn.mockResolvedValue(row({ id: 2, hubUserId: 1, state: 'skipped' }));
    repo.findLatestConnected.mockResolvedValue(
      row({ id: 1, hubUserId: 2, state: 'connected', encryptedKey: 'enc(key-2)', serverUrl: 'http://gateway:8642' }),
    );

    expect(await service.getInjectableCreds('ci-openclaw:local')).toEqual({ url: 'http://gateway:8642', token: 'key-2' });
    expect(repo.findByAppUrn).not.toHaveBeenCalled();
  });

  it('getInjectableCreds degrades to null (never throws) when decryption fails', async () => {
    const { service, repo, encryption } = makeMocks();
    encryption.decrypt.mockImplementation(() => {
      throw new Error('bad ciphertext');
    });
    repo.findLatestConnected.mockResolvedValue(row({ state: 'connected', encryptedKey: 'corrupt', serverUrl: 'http://gateway:8642' }));

    expect(await service.getInjectableCreds('ci-openclaw:local')).toBeNull();
  });

  it('clear resets state to unconfigured and drops the stored key', async () => {
    const { service, repo } = makeMocks();

    await service.clear('ci-openclaw:local');

    expect(repo.upsert).toHaveBeenCalledWith(
      'ci-openclaw:local',
      {
        state: 'unconfigured',
        encryptedKey: null,
        serverUrl: null,
        keyExpiresAt: null,
      },
      0,
    );
  });

  it('markSkipped and markManual persist their states', async () => {
    const { service, repo } = makeMocks();

    await service.markSkipped('ci-openclaw:local');
    await service.markManual('ci-hermes:local');

    expect(repo.upsert).toHaveBeenCalledWith('ci-openclaw:local', { state: 'skipped' }, 0);
    expect(repo.upsert).toHaveBeenCalledWith('ci-hermes:local', { state: 'manual' }, 0);
  });

  it('markManual is idempotent: no redundant upsert when already manual', async () => {
    // Env generation calls markManual on every install/update/restart of a
    // manually-configured app; it must not issue a write each time.
    const { service, repo } = makeMocks();
    repo.findByAppUrn.mockResolvedValue(row({ state: 'manual' }));

    await service.markManual('ci-hermes:local');

    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('getState for a Hub person reads that person, not a sibling row', async () => {
    const { service, repo } = makeMocks();
    repo.findByAppUrn.mockResolvedValue(row({ hubUserId: 1, state: 'connected', encryptedKey: 'enc(k)' }));
    repo.findByAppUrnAndUser.mockResolvedValue(undefined);

    expect(await service.getState('ci-openclaw:local', '2')).toBe('unconfigured');
    expect(repo.findByAppUrnAndUser).toHaveBeenCalledWith('ci-openclaw:local', 2);
  });

  it('storeConnected persists the Hub person who consented', async () => {
    const { service, repo } = makeMocks();

    await service.storeConnected('ci-openclaw:local', 'http://gateway:8642', 'raw-key', '2026-10-07T00:00:00.000Z', '7');

    expect(repo.upsert).toHaveBeenCalledWith(expect.any(String), expect.any(Object), 7);
  });
});
