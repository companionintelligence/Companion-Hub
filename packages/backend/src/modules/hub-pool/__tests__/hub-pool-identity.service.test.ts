import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { HubPoolIdentityRepository, type HubPoolIdentityRow } from '../hub-pool-identity.repository';
import { HubPoolIdentityService } from '../hub-pool-identity.service';
import { publicKeyFingerprint } from '../hub-pool-peer-auth';

/** In-memory `hub_pool_identity`, with `insertIfAbsent` genuinely no-op'ing when the row is taken. */
class FakeIdentityRepository {
  row: HubPoolIdentityRow | undefined;
  inserts = 0;

  async get(): Promise<HubPoolIdentityRow | undefined> {
    return this.row;
  }

  async insertIfAbsent(values: Omit<HubPoolIdentityRow, 'id' | 'createdAt' | 'rotatedAt'>): Promise<void> {
    this.inserts += 1;
    this.row ??= { id: 'self', createdAt: new Date().toISOString(), rotatedAt: null, ...values };
  }

  async replaceKeys(publicKey: string, privateKeyEncrypted: string): Promise<void> {
    if (this.row) {
      this.row = { ...this.row, publicKey, privateKeyEncrypted, rotatedAt: new Date().toISOString() };
    }
  }
}

describe('HubPoolIdentityService', () => {
  let repo: FakeIdentityRepository;
  let encryption: MockProxy<EncryptionService>;
  let logger: MockProxy<LoggerService>;

  function build(): HubPoolIdentityService {
    return new HubPoolIdentityService(logger, repo as unknown as HubPoolIdentityRepository, encryption);
  }

  beforeEach(() => {
    repo = new FakeIdentityRepository();
    logger = mock<LoggerService>();
    encryption = mock<EncryptionService>();
    encryption.encrypt.mockImplementation((data: string, salt: string) => `ENC(${salt}):${data}`);
    encryption.decrypt.mockImplementation((data: string, salt: string) => {
      const prefix = `ENC(${salt}):`;
      if (!data.startsWith(prefix)) throw new Error('Unsupported state or unable to authenticate data');
      return data.slice(prefix.length);
    });
  });

  it('mints one identity and reuses it across a restart', async () => {
    const first = await build().get();
    expect(first?.nodeUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(first?.privateKey).not.toBeNull();

    // A "restart" is a fresh service over the same table.
    const second = await build().get();

    expect(second?.nodeUuid).toBe(first?.nodeUuid);
    expect(second?.publicKey).toBe(first?.publicKey);
  });

  it('yields exactly one identity when two boots race, which is what ON CONFLICT DO NOTHING buys', async () => {
    // The desktop wrapper can double-start the backend during an upgrade; two identities would mean
    // two public keys on a node every peer has pinned exactly one of.
    const [a, b] = await Promise.all([build().get(), build().get()]);

    expect(repo.inserts).toBe(2);
    expect(a?.nodeUuid).toBe(b?.nodeUuid);
  });

  it('caches after the first load, so /pool/status polling costs no query', async () => {
    const service = build();
    await service.get();
    const getSpy = vi.spyOn(repo, 'get');

    await service.get();
    await service.summary();

    expect(getSpy).not.toHaveBeenCalled();
  });

  it('salts the private key with the node UUID, so a rename never makes it undecryptable', async () => {
    const identity = await build().get();

    // The FQDN salt the peer tokens use would break on exactly the event the UUID exists to survive.
    expect(encryption.encrypt).toHaveBeenCalledWith(expect.any(String), identity?.nodeUuid);
  });

  describe('when the stored private key cannot be decrypted', () => {
    /** A regenerated `.env` over a retained Postgres volume — an ordinary reinstall, not an exotic failure. */
    async function withUndecryptableKey(): Promise<HubPoolIdentityService> {
      await build().get();
      const stored = repo.row as HubPoolIdentityRow;
      repo.row = { ...stored, privateKeyEncrypted: 'ENC(some-other-secret):garbage' };
      return build();
    }

    it('does not throw out of onModuleInit — a crash-loop here would take down peerless Hubs too', async () => {
      const service = await withUndecryptableKey();

      expect(() => service.onModuleInit()).not.toThrow();
      await expect(service.get()).resolves.not.toBeNull();
    });

    it('keeps verifying while refusing to sign, so peers can still authenticate to this node', async () => {
      const service = await withUndecryptableKey();

      const identity = await service.get();

      // `node_uuid` and `public_key` are stored in the clear, and verification needs only this
      // node's UUID plus the peers' own public keys — so inbound authentication survives.
      expect(identity?.nodeUuid).toBe(repo.row?.nodeUuid);
      expect(identity?.privateKey).toBeNull();
      await expect(service.canSign()).resolves.toBe(false);
    });

    it('reports it as identityError, exactly the way a down backend reports capabilitiesError', async () => {
      const service = await withUndecryptableKey();

      const summary = await service.summary();

      expect(summary.identityError).toMatch(/could not be decrypted/);
      expect(summary.nodeUuid).toBe(repo.row?.nodeUuid);
    });

    it('NEVER re-mints — that would unpair the whole fleet to work around a recoverable env problem', async () => {
      const service = await withUndecryptableKey();
      const beforeUuid = repo.row?.nodeUuid;
      const beforePublicKey = repo.row?.publicKey;

      await service.get();

      expect(repo.row?.nodeUuid).toBe(beforeUuid);
      expect(repo.row?.publicKey).toBe(beforePublicKey);
    });
  });

  it('degrades to null rather than throwing when the table itself is unreadable', async () => {
    repo.get = async () => {
      throw new Error('connection terminated');
    };
    const service = build();

    await expect(service.get()).resolves.toBeNull();
    await expect(service.summary()).resolves.toMatchObject({ nodeUuid: null, identityError: expect.stringContaining('connection terminated') });
  });

  it('rotate replaces the key, preserves the node UUID, and clears the error', async () => {
    const service = build();
    const before = await service.get();

    const after = await service.rotate();

    expect(after.nodeUuid).toBe(before?.nodeUuid);
    expect(after.publicKey).not.toBe(before?.publicKey);
    expect(publicKeyFingerprint(after.publicKey)).not.toBe(publicKeyFingerprint(before?.publicKey));
    expect(repo.row?.rotatedAt).not.toBeNull();
    await expect(service.summary()).resolves.toMatchObject({ nodeUuid: after.nodeUuid, identityError: null });
  });

  it('refuses to rotate a node that has no identity yet', async () => {
    await expect(build().rotate()).rejects.toThrow(/no pool identity/);
  });

  it('hands each observed peer name to exactly one reader, so the health tick cannot act on it twice', () => {
    const service = build();
    service.noteObservedPeerFqdn('peer-1', 'hub-new.example-tailnet.ts.net');

    expect(service.takeObservedPeerFqdn('peer-1')).toBe('hub-new.example-tailnet.ts.net');
    expect(service.takeObservedPeerFqdn('peer-1')).toBeUndefined();
  });
});
