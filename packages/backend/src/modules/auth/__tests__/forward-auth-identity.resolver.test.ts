import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import type { LoggerService } from '@/core/logger/logger.service';
import type { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import type { UserRepository } from '@/modules/user/user.repository';
import { ForwardAuthIdentityResolver } from '../forward-auth-identity.resolver';

const DIRECTORY_ID = '6f1c2a4e-2f3b-4c5d-8e9f-0a1b2c3d4e5f';
const PUBLIC_ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
const NEW_DIRECTORY_ID = '7a2d3b5f-3a4c-4d6e-9fa0-1b2c3d4e5f60';
const NEW_PUBLIC_ID = '0293b4c5-d6e7-4f80-8b1c-2d3e4f5a6b7c';
const PORTAL = 'https://hub.ci.computer';

/** A drizzle client answering only the two statements the resolver issues for the directory. */
function fakeDb({ failInsert = 0, directory = () => DIRECTORY_ID } = {}) {
  let failuresLeft = failInsert;
  const insert = vi.fn(() => ({
    values: () => ({
      onConflictDoNothing: async () => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('ci-hub-db went away');
        }
      },
    }),
  }));
  const select = vi.fn(() => ({ from: () => ({ where: async () => [{ directoryId: directory() }] }) }));

  return { insert, select };
}

describe('ForwardAuthIdentityResolver', () => {
  let users: MockProxy<UserRepository>;
  let federated: MockProxy<FederatedIdentityRepository>;
  let logger: MockProxy<LoggerService>;

  const make = (db: ReturnType<typeof fakeDb>) => new ForwardAuthIdentityResolver(db as never, users, federated, new SessionUserCache(), logger);

  beforeEach(() => {
    users = mock<UserRepository>();
    federated = mock<FederatedIdentityRepository>();
    logger = mock<LoggerService>();
    users.getPublicId.mockResolvedValue(PUBLIC_ID);
  });

  it('names a user by their public id under this Hub directory', async () => {
    await expect(make(fakeDb()).stableIdFor(7)).resolves.toEqual({ issuer: `urn:ci-hub:${DIRECTORY_ID}`, userId: PUBLIC_ID });
  });

  it('reads the directory once and each public id once: forward auth runs on every request', async () => {
    const db = fakeDb();
    const resolver = make(db);

    await resolver.stableIdFor(7);
    await resolver.stableIdFor(7);
    await resolver.stableIdFor(7);

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(users.getPublicId).toHaveBeenCalledTimes(1);
  });

  it('signs the username alone when the directory cannot be read, and recovers on the next request', async () => {
    const resolver = make(fakeDb({ failInsert: 1 }));

    await expect(resolver.stableIdFor(7)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('signing the username alone'));

    // The failure is not remembered.
    await expect(resolver.stableIdFor(7)).resolves.toEqual({ issuer: `urn:ci-hub:${DIRECTORY_ID}`, userId: PUBLIC_ID });
  });

  it('names nobody by id for a user with no row', async () => {
    users.getPublicId.mockResolvedValue(undefined);

    await expect(make(fakeDb()).stableIdFor(404)).resolves.toBeNull();
  });

  it("names a Portal subject's Hub person by their Hub username, not their Portal email", async () => {
    federated.findByIssuerSubject.mockResolvedValue({ userId: 7 } as never);
    users.getUserDtoById.mockResolvedValue({ id: 7, username: 'owner@example.com', accessStatus: 'active' } as never);

    await expect(make(fakeDb()).personForPortalSubject(PORTAL, 'portal-sub')).resolves.toEqual({
      username: 'owner@example.com',
      stableId: { issuer: `urn:ci-hub:${DIRECTORY_ID}`, userId: PUBLIC_ID },
    });
    expect(federated.findByIssuerSubject).toHaveBeenCalledWith(PORTAL, 'portal-sub');
  });

  it('names nobody for a revoked Hub person', async () => {
    federated.findByIssuerSubject.mockResolvedValue({ userId: 7 } as never);
    users.getUserDtoById.mockResolvedValue({ id: 7, username: 'gone@example.com', accessStatus: 'revoked' } as never);

    await expect(make(fakeDb()).personForPortalSubject(PORTAL, 'portal-sub')).resolves.toBeNull();
  });

  it('does not remember that a subject has no Hub person: they can be admitted at any moment', async () => {
    federated.findByIssuerSubject.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ userId: 7 } as never);
    users.getUserDtoById.mockResolvedValue({ id: 7, username: 'new@example.com', accessStatus: 'active' } as never);
    const resolver = make(fakeDb());

    await expect(resolver.personForPortalSubject(PORTAL, 'portal-sub')).resolves.toBeNull();
    await expect(resolver.personForPortalSubject(PORTAL, 'portal-sub')).resolves.toMatchObject({ username: 'new@example.com' });
  });

  it('falls back to the Portal claims, never an error, when the lookup fails', async () => {
    federated.findByIssuerSubject.mockRejectedValue(new Error('ci-hub-db went away'));

    await expect(make(fakeDb()).personForPortalSubject(PORTAL, 'portal-sub')).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  // A factory reset empties `user` and `user_directory`, and `RESTART IDENTITY` hands id 1 to the
  // next account. The cached public id was then signed for that new person, until a restart.
  it('reads the directory and each public id again after forget', async () => {
    let directoryId = DIRECTORY_ID;
    const resolver = make(fakeDb({ directory: () => directoryId }));
    await expect(resolver.stableIdFor(1)).resolves.toEqual({ issuer: `urn:ci-hub:${DIRECTORY_ID}`, userId: PUBLIC_ID });

    directoryId = NEW_DIRECTORY_ID;
    users.getPublicId.mockResolvedValue(NEW_PUBLIC_ID);
    resolver.forget();

    await expect(resolver.stableIdFor(1)).resolves.toEqual({ issuer: `urn:ci-hub:${NEW_DIRECTORY_ID}`, userId: NEW_PUBLIC_ID });
  });

  it('forgets which Hub person a Portal subject was', async () => {
    federated.findByIssuerSubject.mockResolvedValueOnce({ userId: 1 } as never).mockResolvedValueOnce(undefined);
    users.getUserDtoById.mockResolvedValue({ id: 1, username: 'owner@example.com', accessStatus: 'active' } as never);
    const resolver = make(fakeDb());
    await expect(resolver.personForPortalSubject(PORTAL, 'portal-sub')).resolves.toMatchObject({ username: 'owner@example.com' });

    resolver.forget();

    // Bound to nobody after the reset, although id 1 now belongs to someone.
    await expect(resolver.personForPortalSubject(PORTAL, 'portal-sub')).resolves.toBeNull();
  });

  it('does not keep a public id read before forget', async () => {
    let release: (id: string) => void = () => undefined;
    users.getPublicId.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
    const resolver = make(fakeDb());
    const reading = resolver.stableIdFor(1);

    resolver.forget();
    release(PUBLIC_ID);
    await reading;
    users.getPublicId.mockResolvedValue(NEW_PUBLIC_ID);

    await expect(resolver.stableIdFor(1)).resolves.toMatchObject({ userId: NEW_PUBLIC_ID });
  });
});
