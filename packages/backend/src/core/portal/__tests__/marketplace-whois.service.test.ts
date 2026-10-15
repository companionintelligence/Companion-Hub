import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { mock } from 'vitest-mock-extended';
import type { Request } from 'express';
import type { AppUrn } from '@ci-hub/common/types';
import { TranslatableError } from '@/common/error/translatable-error';
import { DatabaseService } from '@/core/database/database.service';
import { LoggerService } from '@/core/logger/logger.service';
import { EVERY_ADDRESS_FAILED, axiosEveryAddressFailed } from '@/tests/utils/network-failures';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { UserRepository } from '@/modules/user/user.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { PortalClientService } from '../portal-client.service';
import { MarketplaceWhoIsService } from '../marketplace-whois.service';
import { DEFAULT_MEMBER_ACTIONS, HUB_ACTIONS } from '../hub-actions';

const APP_URN = 'immich:ci-marketplace' as AppUrn;
const SUBJECT = 'portal-user-1';
const USER_ID = 7;

describe('MarketplaceWhoIsService', () => {
  let portal: ReturnType<typeof mock<PortalClientService>>;
  let database: ReturnType<typeof mock<DatabaseService>>;
  let logger: ReturnType<typeof mock<LoggerService>>;
  let federatedIdentities: ReturnType<typeof mock<FederatedIdentityRepository>>;
  let registration: ReturnType<typeof mock<RegistrationService>>;
  let users: ReturnType<typeof mock<UserRepository>>;
  let service: MarketplaceWhoIsService;
  let cacheRows: Array<{
    subject: string;
    appId: string;
    canJson: string;
    version: number;
    cachedAt: string;
  }>;
  let portExposeRows: Array<{ appName: string; config: { kind?: string } | null }>;
  /** When set, reading `_user` rows from the app table fails with it. */
  let appRowsError: Error | null;

  const sessionReq = (userId = USER_ID): Request => ({ hubSessionId: 'sess-1', user: { id: userId }, hubPrincipal: 'session' }) as Request;

  /** A Portal push: the device-key bearer arm, exempt because it names itself. */
  const portalPushReq = (userId = USER_ID): Request => ({ user: { id: userId }, hubPrincipal: 'portal-device' }) as Request;

  /** The `cihub` CLI: the JWT arm, the other exempt principal. */
  const cliReq = (userId = USER_ID): Request => ({ user: { id: userId }, hubPrincipal: 'cli' }) as Request;

  /** An authenticated caller with no recognised principal — a middleware bug. */
  const unknownPrincipalReq = (userId = USER_ID): Request => ({ user: { id: userId } }) as Request;

  beforeEach(() => {
    portal = mock<PortalClientService>();
    database = mock<DatabaseService>();
    logger = mock<LoggerService>();
    federatedIdentities = mock<FederatedIdentityRepository>();
    registration = mock<RegistrationService>();
    users = mock<UserRepository>();
    cacheRows = [];
    portExposeRows = [];
    appRowsError = null;

    database.db = {
      select: () => ({
        from: (table: object) => ({
          where: () => {
            if ('appName' in table && appRowsError) {
              return Promise.reject(appRowsError);
            }
            const rows = 'appName' in table ? portExposeRows : cacheRows;
            const query = Promise.resolve(rows) as Promise<typeof rows> & { limit: () => Promise<typeof rows> };
            query.limit = () => Promise.resolve(rows);
            return query;
          },
        }),
      }),
      insert: () => ({
        values: (row: (typeof cacheRows)[number]) => ({
          onConflictDoUpdate: async () => {
            cacheRows = [row];
          },
        }),
      }),
    } as unknown as DatabaseService['db'];

    federatedIdentities.findByUserId.mockResolvedValue([{ subject: SUBJECT }] as never);
    registration.getDeviceRegistrationInfo.mockResolvedValue({ id: 'org-hub' } as never);

    // The operator who claimed this Hub is someone else unless a test says otherwise.
    users.getFirstOperator.mockResolvedValue({ id: 1 } as never);

    service = new MarketplaceWhoIsService(portal, database, logger, federatedIdentities, registration, users);
  });

  it('gives an unlinked operator the member actions only, and logs once', async () => {
    /*
     * ⚠ `DEFAULT_MEMBER_ACTIONS` WAS `HUB_ACTIONS` — the complete verb set —
     * while the comment on it called it "this explicit member list, not owner
     * `*`". It was owner `*`, spelt out. So an unlinked operator resolved to
     * `install`, `uninstall`, `reset`, `restore` and `configure` on every app.
     *
     * A fallback is a state in which we do not know what somebody may do. The
     * verbs that survive that are the ones whose worst outcome is an app being
     * stopped and started again.
     */
    federatedIdentities.findByUserId.mockResolvedValue([]);

    await expect(service.has(USER_ID, APP_URN, 'view')).resolves.toBe(true);
    await expect(service.has(USER_ID, APP_URN, 'restart')).resolves.toBe(true);
    await expect(service.has(USER_ID, APP_URN, 'install')).resolves.toBe(false);
    await expect(service.has(USER_ID, APP_URN, 'uninstall')).resolves.toBe(false);
    await expect(service.has(USER_ID, APP_URN, 'configure')).resolves.toBe(false);
    expect(portal.whoisApps).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(`whois_skipped_unlinked_operator userId=${USER_ID}`);
    expect(DEFAULT_MEMBER_ACTIONS).toContain('view');
    expect(DEFAULT_MEMBER_ACTIONS).not.toContain('install');
  });

  it('lets a linked operator manage a local port-expose app without asking WhoIs', async () => {
    portExposeRows = [{ appName: 'qa-probe', config: { kind: 'port-expose' } }];

    await expect(service.has(USER_ID, 'qa-probe:_user' as AppUrn, 'view')).resolves.toBe(true);
    await expect(service.has(USER_ID, 'qa-probe:_user' as AppUrn, 'start')).resolves.toBe(true);
    await expect(service.has(USER_ID, 'qa-probe:_user' as AppUrn, 'stop')).resolves.toBe(true);
    await expect(service.has(USER_ID, 'qa-probe:_user' as AppUrn, 'uninstall')).resolves.toBe(true);
    for (const action of ['configure', 'install', 'update', 'reset', 'restart', 'backup', 'restore'] as const) {
      await expect(service.has(USER_ID, 'qa-probe:_user' as AppUrn, action)).resolves.toBe(false);
    }
    await expect(service.assertSessionAction(sessionReq(), 'qa-probe:_user' as AppUrn, 'view')).resolves.toBeUndefined();
    await expect(service.assertSessionAction(sessionReq(), 'qa-probe:_user' as AppUrn, 'install')).rejects.toMatchObject({
      message: 'APP_ACTION_GRANT_DENIED',
    });
    expect(portal.whoisApps).not.toHaveBeenCalled();
    expect(cacheRows).toEqual([]);
  });

  it('still asks WhoIs for a catalog app that shares the port-expose name', async () => {
    portExposeRows = [{ appName: 'immich', config: { kind: 'port-expose' } }];
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [{ organizationId: 'org-hub', version: 1, apps: [{ appId: 'immich', can: ['view'] }] }],
      },
    });

    await expect(service.has(USER_ID, 'immich:_user' as AppUrn, 'uninstall')).resolves.toBe(true);
    await expect(service.has(USER_ID, APP_URN, 'uninstall')).resolves.toBe(false);
    await expect(service.has(USER_ID, APP_URN, 'view')).resolves.toBe(true);
    expect(portal.whoisApps).toHaveBeenCalledWith({
      subject: SUBJECT,
      appIds: ['immich'],
      surface: 'hub',
      organizationId: 'org-hub',
    });
  });

  /*
   * The Portal has no catalog row for an app made on this Hub and answers `can: []` for it, which
   * locked everyone, the owner included, out of the app they had just created. The Hub decides
   * instead: anyone signed in may see a custom app, and changing one takes an organization owner or
   * admin. The grant is never cached under the name, which a catalog app can share.
   */
  describe('a custom app in _user', () => {
    const CUSTOM_URN = 'my-compose:_user' as AppUrn;
    const CHANGES = HUB_ACTIONS.filter((action) => action !== 'view');
    const roleAnswer = (role: string, status = 200) =>
      ({ status, body: { organizations: [{ organizationId: 'org-hub', version: 1, user: { role }, apps: [] }] } }) as never;

    beforeEach(() => {
      portExposeRows = [{ appName: 'my-compose', config: {} }];
    });

    it('may be viewed by anyone signed in, without asking WhoIs', async () => {
      portal.whoisApps.mockResolvedValue(roleAnswer('member'));

      await expect(service.has(USER_ID, CUSTOM_URN, 'view')).resolves.toBe(true);
      await expect(service.assertSessionAction(sessionReq(), CUSTOM_URN, 'view')).resolves.toBeUndefined();
      expect(portal.whoisApps).not.toHaveBeenCalled();
      expect(cacheRows).toEqual([]);
    });

    it('is listed next to catalog apps WhoIs still decides', async () => {
      portal.whoisApps.mockResolvedValue({
        status: 200,
        body: { organizations: [{ organizationId: 'org-hub', version: 1, apps: [] }] },
      });
      const items = [{ urn: 'my-compose:_user' }, { urn: APP_URN }];

      await expect(service.filterSessionByView(sessionReq(), items, (item) => item.urn, 'hub')).resolves.toEqual([{ urn: 'my-compose:_user' }]);
      expect(portal.whoisApps).toHaveBeenCalledTimes(1);
      expect(portal.whoisApps).toHaveBeenCalledWith(expect.objectContaining({ appIds: ['immich'] }));
    });

    it.each(['owner', 'admin'])('may be started, stopped, removed and changed by an organization %s', async (role) => {
      portal.whoisApps.mockResolvedValue(roleAnswer(role));

      for (const action of CHANGES) {
        await expect(service.has(USER_ID, CUSTOM_URN, action)).resolves.toBe(true);
      }
      await expect(service.assertSessionAction(sessionReq(), CUSTOM_URN, 'start')).resolves.toBeUndefined();
      // Only the role is asked of the Portal, in the form `hasManagingRole` uses.
      expect(portal.whoisApps).toHaveBeenCalledWith({ subject: SUBJECT, appIds: ['my-compose'], surface: 'hub', organizationId: 'org-hub' });
      expect(cacheRows).toEqual([]);
    });

    it('decides a batch of custom apps and a port expose with one role read', async () => {
      portExposeRows = [
        { appName: 'my-compose', config: {} },
        { appName: 'other-compose', config: {} },
        { appName: 'qa-probe', config: { kind: 'port-expose' } },
      ];
      portal.whoisApps.mockResolvedValue(roleAnswer('member'));
      const urns = [CUSTOM_URN, 'other-compose:_user', 'qa-probe:_user'] as AppUrn[];

      await expect(service.filterSessionByAction(sessionReq(), urns, 'stop')).resolves.toEqual(['qa-probe:_user']);
      await expect(service.assertSessionActions(sessionReq(), urns, 'stop')).rejects.toMatchObject({ message: 'APP_ACTION_GRANT_DENIED' });
      // One role question per call, and the identity read once for it.
      expect(portal.whoisApps).toHaveBeenCalledTimes(2);
      expect(federatedIdentities.findByUserId).toHaveBeenCalledTimes(2);
      expect(cacheRows).toEqual([]);
    });

    it('can be seen, but not started or changed, by a member without a managing role', async () => {
      portal.whoisApps.mockResolvedValue(roleAnswer('member'));

      await expect(service.has(USER_ID, CUSTOM_URN, 'view')).resolves.toBe(true);
      await expect(service.assertSessionAction(sessionReq(), CUSTOM_URN, 'start')).rejects.toMatchObject({
        message: 'APP_ACTION_GRANT_DENIED',
      });
      for (const action of CHANGES) {
        await expect(service.has(USER_ID, CUSTOM_URN, action)).resolves.toBe(false);
      }
      expect(cacheRows).toEqual([]);
    });

    it.each([
      ['WhoIs answering 503', () => portal.whoisApps.mockResolvedValue(roleAnswer('owner', 503))],
      ['WhoIs throwing', () => portal.whoisApps.mockRejectedValue(new Error('ECONNRESET'))],
      // Not knowing who the operator is, which is not the same as knowing they have no Portal identity.
      ['the linked-identity read failing', () => federatedIdentities.findByUserId.mockRejectedValue(new Error('db down'))],
    ])('refuses a change but stays listed on %s, since the role cannot be read', async (_label, arrange) => {
      arrange();

      await expect(service.assertSessionAction(sessionReq(), CUSTOM_URN, 'start')).rejects.toMatchObject({
        message: 'APP_ACTION_GRANT_DENIED',
      });
      await expect(service.has(USER_ID, CUSTOM_URN, 'view')).resolves.toBe(true);
      const items = [{ urn: 'my-compose:_user' }];
      await expect(service.filterSessionByView(sessionReq(), items, (item) => item.urn, 'hub')).resolves.toEqual(items);
    });

    it('keeps the member fallback for an operator with no linked Portal identity: start, stop and restart, not uninstall', async () => {
      // There is no role to read without a Portal subject. Such an operator got `DEFAULT_MEMBER_ACTIONS`
      // on every app before custom apps were decided here, and keeps them on a custom app.
      federatedIdentities.findByUserId.mockResolvedValue([] as never);

      for (const action of HUB_ACTIONS) {
        await expect(service.has(USER_ID, CUSTOM_URN, action)).resolves.toBe(DEFAULT_MEMBER_ACTIONS.includes(action));
      }
      await expect(service.assertSessionAction(sessionReq(), CUSTOM_URN, 'start')).resolves.toBeUndefined();
      await expect(service.assertSessionAction(sessionReq(), CUSTOM_URN, 'uninstall')).rejects.toMatchObject({
        message: 'APP_ACTION_GRANT_DENIED',
      });
      expect(portal.whoisApps).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(`whois_skipped_unlinked_operator userId=${USER_ID}`);
    });

    it('refuses a change, without asking the Portal, when its row cannot be read', async () => {
      // Without the row a port expose can't be told from a custom app, so only the view is left.
      appRowsError = new Error('db down');

      await expect(service.assertSessionAction(sessionReq(), CUSTOM_URN, 'start')).rejects.toMatchObject({
        message: 'APP_ACTION_GRANT_DENIED',
      });
      await expect(service.has(USER_ID, CUSTOM_URN, 'view')).resolves.toBe(true);
      expect(portal.whoisApps).not.toHaveBeenCalled();
      expect(cacheRows).toEqual([]);
    });

    /*
     * Custom apps in general, with no app to ask about: what the UI shows, and who may create one.
     * The role is asked about no app (a role-only WhoIs), and nothing is cached.
     */
    describe('in general, and creating one', () => {
      it.each(['owner', 'admin'])('gives an organization %s every verb, and lets them create one', async (role) => {
        portal.whoisApps.mockResolvedValue(roleAnswer(role));

        await expect(service.customAppActions(sessionReq())).resolves.toEqual([...HUB_ACTIONS]);
        await expect(service.assertSessionMayCreateCustomApp(sessionReq())).resolves.toBeUndefined();
        expect(portal.whoisApps).toHaveBeenCalledWith({ subject: SUBJECT, appIds: [], surface: 'hub', organizationId: 'org-hub' });
        expect(cacheRows).toEqual([]);
      });

      it('gives a member the view only, and refuses them a new custom app', async () => {
        portal.whoisApps.mockResolvedValue(roleAnswer('member'));

        await expect(service.customAppActions(sessionReq())).resolves.toEqual(['view']);
        await expect(service.assertSessionMayCreateCustomApp(sessionReq())).rejects.toMatchObject({
          message: 'CUSTOM_APP_CREATE_ROLE_REQUIRED',
          status: HttpStatus.FORBIDDEN,
        });
      });

      it('keeps the member fallback for an operator with no linked Portal identity, which creates nothing', async () => {
        federatedIdentities.findByUserId.mockResolvedValue([] as never);

        await expect(service.customAppActions(sessionReq())).resolves.toEqual([...DEFAULT_MEMBER_ACTIONS]);
        await expect(service.assertSessionMayCreateCustomApp(sessionReq())).rejects.toMatchObject({ message: 'CUSTOM_APP_CREATE_ROLE_REQUIRED' });
        expect(portal.whoisApps).not.toHaveBeenCalled();
      });

      it('refuses a new custom app when the role cannot be read', async () => {
        portal.whoisApps.mockResolvedValue(roleAnswer('owner', 503));

        await expect(service.customAppActions(sessionReq())).resolves.toEqual(['view']);
        await expect(service.assertSessionMayCreateCustomApp(sessionReq())).rejects.toMatchObject({ message: 'CUSTOM_APP_CREATE_ROLE_REQUIRED' });
      });

      /*
       * The UI's question. Asking the Portal took seconds, and the page waited on it, so the answer comes
       * from the role stored at sign-in. Every action still asks the Portal fresh.
       */
      describe('what the UI offers', () => {
        const withStoredRole = (orgRole: 'owner' | 'admin' | 'member' | null) =>
          ({ hubSessionId: 'sess-1', user: { id: USER_ID, orgRole }, hubPrincipal: 'session' }) as unknown as Request;

        it.each(['owner', 'admin'] as const)('offers a stored %s every verb without asking the Portal', async (role) => {
          await expect(service.customAppActionsHint(withStoredRole(role))).resolves.toEqual([...HUB_ACTIONS]);
          expect(portal.whoisApps).not.toHaveBeenCalled();
        });

        it('offers a stored member the view only, without asking the Portal', async () => {
          await expect(service.customAppActionsHint(withStoredRole('member'))).resolves.toEqual(['view']);
          expect(portal.whoisApps).not.toHaveBeenCalled();
        });

        it('asks the Portal when no role is stored', async () => {
          portal.whoisApps.mockResolvedValue(roleAnswer('admin'));

          await expect(service.customAppActionsHint(withStoredRole(null))).resolves.toEqual([...HUB_ACTIONS]);
          expect(portal.whoisApps).toHaveBeenCalledWith({ subject: SUBJECT, appIds: [], surface: 'hub', organizationId: 'org-hub' });
        });

        it('offers an operator with no linked Portal identity the member fallback, whatever role the row says', async () => {
          federatedIdentities.findByUserId.mockResolvedValue([] as never);

          await expect(service.customAppActionsHint(withStoredRole('owner'))).resolves.toEqual([...DEFAULT_MEMBER_ACTIONS]);
          expect(portal.whoisApps).not.toHaveBeenCalled();
        });

        it('offers the view only when the identity cannot be read', async () => {
          federatedIdentities.findByUserId.mockRejectedValue(new Error('db down'));

          await expect(service.customAppActionsHint(withStoredRole('owner'))).resolves.toEqual(['view']);
        });

        it('offers a named exempt principal everything', async () => {
          await expect(service.customAppActionsHint(cliReq())).resolves.toEqual([...HUB_ACTIONS]);
          expect(portal.whoisApps).not.toHaveBeenCalled();
        });
      });

      it('lets a named exempt principal do everything without asking the Portal, and an unnamed one nothing', async () => {
        await expect(service.customAppActions(cliReq())).resolves.toEqual([...HUB_ACTIONS]);
        await expect(service.assertSessionMayCreateCustomApp(portalPushReq())).resolves.toBeUndefined();
        await expect(service.customAppActions(unknownPrincipalReq())).resolves.toEqual([]);
        await expect(service.assertSessionMayCreateCustomApp(unknownPrincipalReq())).rejects.toMatchObject({
          message: 'CUSTOM_APP_CREATE_ROLE_REQUIRED',
        });
        expect(portal.whoisApps).not.toHaveBeenCalled();
      });
    });
  });

  it('uses WhoIs can[] for a linked operator', async () => {
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [
          {
            organizationId: 'org-hub',
            version: 4,
            apps: [{ appId: 'immich', can: ['view', 'start'] }],
          },
        ],
      },
    });

    await expect(service.has(USER_ID, APP_URN, 'view')).resolves.toBe(true);
    await expect(service.has(USER_ID, APP_URN, 'start')).resolves.toBe(true);
    await expect(service.has(USER_ID, APP_URN, 'install')).resolves.toBe(false);
  });

  it("sends this device's own organization id on device WhoIs, read once", async () => {
    // Portal answers 409 `ORGANIZATION_REQUIRED` for a device two organizations paired at the same moment,
    // unless the Hub names its own. The name is checked against the device's registrations: it narrows, never widens.
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [{ organizationId: 'org-hub', version: 1, apps: [{ appId: 'immich', can: ['view'] }] }],
      },
    });

    await expect(service.has(USER_ID, APP_URN, 'view')).resolves.toBe(true);

    expect(portal.whoisApps).toHaveBeenCalledWith({
      subject: SUBJECT,
      appIds: ['immich'],
      surface: 'hub',
      organizationId: 'org-hub',
    });
    // Once for the request and the match against the answer, not once each.
    expect(registration.getDeviceRegistrationInfo).toHaveBeenCalledTimes(1);
  });

  it('picks this Hub’s org from a multi-org WhoIs response', async () => {
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [
          { organizationId: 'org-other', version: 1, apps: [{ appId: 'immich', can: ['view', 'install'] }] },
          { organizationId: 'org-hub', version: 2, apps: [{ appId: 'immich', can: ['view'] }] },
        ],
      },
    });

    await expect(service.has(USER_ID, APP_URN, 'install')).resolves.toBe(false);
    await expect(service.has(USER_ID, APP_URN, 'view')).resolves.toBe(true);
  });

  it('treats linked + Portal 403 as empty can, not default member', async () => {
    portal.whoisApps.mockResolvedValue({ status: 403, body: null });

    await expect(service.has(USER_ID, APP_URN, 'view')).resolves.toBe(false);
    await expect(service.has(USER_ID, APP_URN, 'start')).resolves.toBe(false);
  });

  it('inherits member actions only when Portal URL is not configured', async () => {
    // "No Portal configured" is not "everyone may do everything here".
    portal.whoisApps.mockResolvedValue(null);

    await expect(service.has(USER_ID, APP_URN, 'view')).resolves.toBe(true);
    await expect(service.has(USER_ID, APP_URN, 'install')).resolves.toBe(false);
  });

  it("refuses rather than picking an arbitrary organization's grants", async () => {
    /*
     * ⚠ `organizations[0]` IS AN ARBITRARY TENANT. A subject who belongs to two
     * organizations could have this Hub answer with the grants of whichever one
     * Portal happened to serialize first — a grant read from the wrong tenant,
     * and possibly wider than the real one.
     */
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [{ organizationId: 'org-somebody-else', version: 1, apps: [{ appId: 'immich', can: ['install', 'uninstall'] }] }],
      },
    });

    await expect(service.has(USER_ID, APP_URN, 'install')).resolves.toBe(false);
    await expect(service.has(USER_ID, APP_URN, 'view')).resolves.toBe(false);
  });

  it("refuses, without asking Portal, when this device's own organization cannot be read", async () => {
    // The registration read failing used to be swallowed into `null` and fall
    // through to the same arbitrary pick — so a transient failure to learn our
    // own identity silently widened every grant on the appliance.
    registration.getDeviceRegistrationInfo.mockRejectedValue(new Error('db down'));
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [{ organizationId: 'org-hub', version: 1, apps: [{ appId: 'immich', can: ['install', 'start'] }] }],
      },
    });

    await expect(service.has(USER_ID, APP_URN, 'install')).resolves.toBe(false);
    // Nor the member fallback: unknown with no fresh cache refuses even `start`.
    await expect(service.has(USER_ID, APP_URN, 'start')).resolves.toBe(false);
    expect(portal.whoisApps).not.toHaveBeenCalled();
  });

  it('forgets a cached grant once the cache is cleared', async () => {
    cacheRows = [
      {
        subject: SUBJECT,
        appId: 'immich',
        canJson: JSON.stringify(['view', 'configure']),
        version: 3,
        cachedAt: new Date().toISOString(),
      },
    ];
    database.db.delete = (async () => {
      cacheRows = [];
    }) as unknown as DatabaseService['db']['delete'];
    registration.getDeviceRegistrationInfo.mockResolvedValue(undefined as never);

    await service.clearCache();

    await expect(service.has(USER_ID, APP_URN, 'configure')).resolves.toBe(false);
    expect(portal.whoisApps).not.toHaveBeenCalled();
  });

  it.each([
    ['cannot be read', () => registration.getDeviceRegistrationInfo.mockRejectedValue(new Error('db down'))],
    ['does not exist', () => registration.getDeviceRegistrationInfo.mockResolvedValue(undefined as never)],
  ])("serves the fresh cache, without asking Portal, when this device's registration %s", async (_label, arrange) => {
    arrange();
    cacheRows = [
      {
        subject: SUBJECT,
        appId: 'immich',
        canJson: JSON.stringify(['view', 'configure']),
        version: 3,
        cachedAt: new Date().toISOString(),
      },
    ];

    // The cached grant — not an empty one, and not the member fallback.
    await expect(service.has(USER_ID, APP_URN, 'configure')).resolves.toBe(true);
    await expect(service.has(USER_ID, APP_URN, 'start')).resolves.toBe(false);
    expect(portal.whoisApps).not.toHaveBeenCalled();
  });

  /*
   * ⚠ "OUR ORG IS UNKNOWN" IS NOT "OUR ORG GRANTED NOTHING". Refusing by
   * falling through to an empty `can` looks identical at `has()` — both are
   * `false` — but the two values part company everywhere else: `[]` gets
   * WRITTEN TO THE CACHE with a fresh timestamp, so the next Portal outage
   * inside the 24h TTL serves that empty row as though it were a real answer.
   */
  it("does not cache an empty grant when this device's organization is unknown", async () => {
    registration.getDeviceRegistrationInfo.mockRejectedValue(new Error('db down'));
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [{ organizationId: 'org-hub', version: 1, apps: [{ appId: 'immich', can: ['view', 'install'] }] }],
      },
    });

    await service.has(USER_ID, APP_URN, 'install');

    expect(cacheRows).toEqual([]);
  });

  /*
   * ⚠ AND `[]` HIDES THE APP. `filterSessionByView` keeps a row whose grant is
   * unknown ("an outage does not empty the house") and hides one that is known
   * to be empty — so routing an unresolved organization through the empty list
   * emptied the operator's whole app list on a transient database blip.
   */
  it("keeps the app list when this device's organization is unknown", async () => {
    registration.getDeviceRegistrationInfo.mockRejectedValue(new Error('db down'));
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [{ organizationId: 'org-hub', version: 1, apps: [{ appId: 'immich', can: ['view'] }] }],
      },
    });

    await expect(service.filterSessionByView(sessionReq(), [APP_URN], (urn) => urn, 'hub')).resolves.toEqual([APP_URN]);
  });

  it('uses a fresh cache when Portal is unreachable', async () => {
    cacheRows = [
      {
        subject: SUBJECT,
        appId: 'immich',
        canJson: JSON.stringify(['view']),
        version: 3,
        cachedAt: new Date().toISOString(),
      },
    ];
    portal.whoisApps.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.has(USER_ID, APP_URN, 'view')).resolves.toBe(true);
    await expect(service.has(USER_ID, APP_URN, 'start')).resolves.toBe(false);
  });

  it('fails closed on mutate when Portal is unreachable and there is no fresh cache', async () => {
    portal.whoisApps.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.has(USER_ID, APP_URN, 'start')).resolves.toBe(false);
  });

  it('says why WhoIs got no answer when no address of the Portal accepted the connection', async () => {
    portal.whoisApps.mockRejectedValue(axiosEveryAddressFailed());

    await expect(service.has(USER_ID, APP_URN, 'start')).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(`Portal WhoIs failed: ${EVERY_ADDRESS_FAILED}`);
  });

  it('fails open on list when Portal is unreachable and there is no fresh cache', async () => {
    portal.whoisApps.mockRejectedValue(new Error('ECONNREFUSED'));
    const items = [{ urn: APP_URN }, { urn: 'plex:ci-marketplace' as AppUrn }];

    const visible = await service.filterSessionByView(sessionReq(), items, (item) => item.urn, 'hub');

    expect(visible).toEqual(items);
  });

  it('keeps one app listing visible when WhoIs has no answer', async () => {
    portal.whoisApps.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.catalogVisibility(sessionReq(), APP_URN, 'store')).resolves.toBe('visible');
  });

  it('refuses one app listing when WhoIs answers with an empty grant', async () => {
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [{ organizationId: 'org-hub', version: 1, apps: [{ appId: 'immich', can: [] }] }],
      },
    });

    await expect(service.catalogVisibility(sessionReq(), APP_URN, 'store')).resolves.toBe('refused');
  });

  it('shows one app listing when WhoIs grants view', async () => {
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [{ organizationId: 'org-hub', version: 1, apps: [{ appId: 'immich', can: ['view'] }] }],
      },
    });

    await expect(service.catalogVisibility(sessionReq(), APP_URN, 'store')).resolves.toBe('visible');
  });

  /*
   * A 409 `ORGANIZATION_REQUIRED` is Portal declining to guess between tied organizations, not a
   * refusal. Read as one, it would overwrite a fresh grant with nothing for the whole TTL.
   */
  const organizationRequired = { status: 409, body: { error: 'Name the organization', code: 'ORGANIZATION_REQUIRED' } as never };

  it('keeps the fresh cache on a 409 ORGANIZATION_REQUIRED rather than caching an empty grant', async () => {
    cacheRows = [
      {
        subject: SUBJECT,
        appId: 'immich',
        canJson: JSON.stringify(['view']),
        version: 3,
        cachedAt: new Date().toISOString(),
      },
    ];
    portal.whoisApps.mockResolvedValue(organizationRequired);

    await expect(service.has(USER_ID, APP_URN, 'view')).resolves.toBe(true);
    expect(cacheRows.map((row) => row.canJson)).toEqual([JSON.stringify(['view'])]);
    expect(logger.warn).toHaveBeenCalledWith('Portal WhoIs returned HTTP 409');
  });

  it('fails closed on mutate and open on list on a 409 ORGANIZATION_REQUIRED with no fresh cache', async () => {
    portal.whoisApps.mockResolvedValue(organizationRequired);

    await expect(service.has(USER_ID, APP_URN, 'start')).resolves.toBe(false);
    await expect(service.filterSessionByView(sessionReq(), [APP_URN], (urn) => urn, 'hub')).resolves.toEqual([APP_URN]);
  });

  it('hides list rows whose WhoIs can does not include view', async () => {
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [
          {
            organizationId: 'org-hub',
            version: 1,
            apps: [
              { appId: 'immich', can: ['view'] },
              { appId: 'plex', can: [] },
            ],
          },
        ],
      },
    });
    const items = [{ urn: APP_URN }, { urn: 'plex:ci-marketplace' as AppUrn }];

    const visible = await service.filterSessionByView(sessionReq(), items, (item) => item.urn, 'hub');

    expect(visible).toEqual([{ urn: APP_URN }]);
  });

  it.each([
    ['the Portal-device principal', portalPushReq],
    ['the CLI principal', cliReq],
  ])('no-ops assertSessionAction for %s', async (_label, buildReq) => {
    await expect(service.assertSessionAction(buildReq(), APP_URN, 'install')).resolves.toBeUndefined();
    expect(portal.whoisApps).not.toHaveBeenCalled();
    expect(federatedIdentities.findByUserId).not.toHaveBeenCalled();
  });

  it.each([
    ['the Portal-device principal', portalPushReq],
    ['the CLI principal', cliReq],
  ])('sweeps everything for %s', async (_label, buildReq) => {
    await expect(service.filterSessionByAction(buildReq(), [APP_URN], 'install')).resolves.toEqual([APP_URN]);
    expect(portal.whoisApps).not.toHaveBeenCalled();
  });

  it.each([
    ['the Portal-device principal', portalPushReq],
    ['the CLI principal', cliReq],
  ])('resolves no sweep operator for %s, so the sweep is unfiltered', (_label, buildReq) => {
    expect(service.sweepOperatorUserId(buildReq(), 'update')).toBeUndefined();
  });

  it('refuses an action from a caller with no recognised principal', async () => {
    // The exemption used to follow from a missing session, which was equally true
    // of every arm that forgot to set one. A gated route reached with no principal
    // is a middleware bug, and the safe reading of a bug is a refusal.
    await expect(service.assertSessionAction(unknownPrincipalReq(), APP_URN, 'install')).rejects.toMatchObject({
      status: 403,
    });
    expect(portal.whoisApps).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('whois_unrecognised_principal'));
  });

  /**
   * A `qa:read` key has no person behind it and is not exempt. It exists so a test can read an app's
   * install status without holding operator authority, so `view` must pass without a grant lookup —
   * and nothing else may, or the key would be an operator credential by another name.
   */
  describe('a qa:read key', () => {
    const qaReadReq = (): Request => ({ hubPrincipal: 'qa-read' }) as Request;

    it('may view an app without a WhoIs round trip', async () => {
      await expect(service.assertSessionAction(qaReadReq(), APP_URN, 'view')).resolves.toBeUndefined();
      expect(portal.whoisApps).not.toHaveBeenCalled();
    });

    it.each(['install', 'configure', 'uninstall', 'restart'] as const)('is refused %s, like any unrecognised principal', async (action) => {
      await expect(service.assertSessionAction(qaReadReq(), APP_URN, action)).rejects.toMatchObject({ status: 403 });
    });

    it('is never a lifecycle actor, so no lifecycle verb can run as it', () => {
      expect(() => service.lifecycleActor(qaReadReq(), 'view')).toThrowError(TranslatableError);
    });

    it('sweeps nothing', async () => {
      await expect(service.filterSessionByAction(qaReadReq(), [APP_URN], 'restart')).resolves.toEqual([]);
    });
  });

  it('refuses a sweep from a caller with no recognised principal', () => {
    // `updateAllApps` and friends act on every installed app, so the sweep gets the
    // same answer the named routes do rather than being read as exempt.
    expect(() => service.sweepOperatorUserId(unknownPrincipalReq(), 'update')).toThrowError(TranslatableError);
  });

  it('resolves the sweep operator for a Hub session', () => {
    expect(service.sweepOperatorUserId(sessionReq(), 'update')).toBe(USER_ID);
  });

  describe('lifecycleActor (CI-Hub#1397)', () => {
    it('names a Hub session person as an operator', () => {
      expect(service.lifecycleActor(sessionReq(), 'install')).toEqual({ kind: 'operator', userId: USER_ID });
    });

    it.each([
      ['portal-device', portalPushReq],
      ['cli', cliReq],
    ] as const)('names the %s principal as exempt', (principal, buildReq) => {
      expect(service.lifecycleActor(buildReq(), 'install')).toEqual({ kind: 'exempt', principal });
    });

    it('refuses a caller with no recognised principal', () => {
      expect(() => service.lifecycleActor(unknownPrincipalReq(), 'install')).toThrowError(TranslatableError);
    });

    it('refuses a session with no user, rather than reading it as exempt', () => {
      const userless = { hubSessionId: 'sess-1', hubPrincipal: 'session' } as Request;

      expect(() => service.lifecycleActor(userless, 'configure')).toThrowError(TranslatableError);
    });
  });

  it('sweeps nothing for a caller with no recognised principal', async () => {
    const swept = await service.filterSessionByAction(unknownPrincipalReq(), [APP_URN], 'install');

    expect(swept).toEqual([]);
  });

  it('still shows list rows to an unrecognised principal, because reads fail open', async () => {
    // `filterSessionByView`'s own contract: hiding a row from a read is how an
    // operator loses sight of an app they own. Only the mutating paths refuse.
    const items = [{ urn: APP_URN }];

    await expect(service.filterSessionByView(unknownPrincipalReq(), items, (item) => item.urn, 'hub')).resolves.toEqual(items);
  });

  it('refuses a Hub-session action that is not in can[]', async () => {
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [{ organizationId: 'org-hub', version: 1, apps: [{ appId: 'immich', can: ['view'] }] }],
      },
    });

    await expect(service.assertSessionAction(sessionReq(), APP_URN, 'install')).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    });
    await expect(service.assertSessionAction(sessionReq(), APP_URN, 'install')).rejects.toBeInstanceOf(TranslatableError);
  });

  describe('hasManagingRole (R2-HUBDOMAINS-1)', () => {
    const answer = (organizations: unknown[], status = 200) => ({ status, body: { organizations } }) as never;

    it.each(['owner', 'admin'])('is true for an organization %s', async (role) => {
      portal.whoisApps.mockResolvedValue(answer([{ organizationId: 'org-hub', user: { role }, apps: [] }]));

      await expect(service.hasManagingRole(USER_ID, APP_URN)).resolves.toBe(true);
      expect(portal.whoisApps).toHaveBeenCalledWith({ subject: SUBJECT, appIds: ['immich'], surface: 'hub', organizationId: 'org-hub' });
      expect(registration.getDeviceRegistrationInfo).toHaveBeenCalledTimes(1);
    });

    it('is false for a member, whatever their per-app grants', async () => {
      portal.whoisApps.mockResolvedValue(
        answer([{ organizationId: 'org-hub', user: { role: 'member' }, apps: [{ appId: 'immich', can: ['configure', 'install'] }] }]),
      );

      await expect(service.hasManagingRole(USER_ID, APP_URN)).resolves.toBe(false);
    });

    it("reads the role from this device's organization, not the first one listed", async () => {
      portal.whoisApps.mockResolvedValue(
        answer([
          { organizationId: 'org-other', user: { role: 'owner' }, apps: [] },
          { organizationId: 'org-hub', user: { role: 'member' }, apps: [] },
        ]),
      );

      await expect(service.hasManagingRole(USER_ID, APP_URN)).resolves.toBe(false);
    });

    it.each([
      ['an organization that names no role', () => portal.whoisApps.mockResolvedValue(answer([{ organizationId: 'org-hub', apps: [] }]))],
      ['WhoIs answering non-2xx', () => portal.whoisApps.mockResolvedValue(answer([], 503))],
      // The status decides, not whatever the body carries: a tie Portal would not settle is not knowing.
      [
        'WhoIs answering 409 ORGANIZATION_REQUIRED',
        () => portal.whoisApps.mockResolvedValue(answer([{ organizationId: 'org-hub', user: { role: 'owner' }, apps: [] }], 409)),
      ],
      ['no Portal configured', () => portal.whoisApps.mockResolvedValue(null)],
      ['WhoIs throwing', () => portal.whoisApps.mockRejectedValue(new Error('ECONNRESET'))],
      ['the linked-identity read failing', () => federatedIdentities.findByUserId.mockRejectedValue(new Error('db'))],
    ])('is false on %s — not knowing is not permission', async (_label, arrange) => {
      arrange();

      await expect(service.hasManagingRole(USER_ID, APP_URN)).resolves.toBe(false);
    });

    it('is false for an operator with no linked Portal subject, without asking the Portal', async () => {
      federatedIdentities.findByUserId.mockResolvedValue([] as never);

      await expect(service.hasManagingRole(USER_ID, APP_URN)).resolves.toBe(false);
      expect(portal.whoisApps).not.toHaveBeenCalled();
    });

    it('is false, not a 500, for an app urn that cannot be split', async () => {
      await expect(service.hasManagingRole(USER_ID, 'x:' as AppUrn)).resolves.toBe(false);
      expect(portal.whoisApps).not.toHaveBeenCalled();
    });
  });

  describe('isOrgManager — the role alone, for a decision no single app owns', () => {
    const answer = (organizations: unknown[], status = 200) => ({ status, body: { organizations } }) as never;

    it.each([
      ['owner', true],
      ['admin', true],
      ['member', false],
      // Not a Portal role today. Anything but owner or admin is not a manager, whatever it is called.
      ['viewer', false],
    ])('answers an organization %s with %s, asking about no app', async (role, expected) => {
      portal.whoisApps.mockResolvedValue(answer([{ organizationId: 'org-hub', user: { role }, apps: [] }]));

      await expect(service.isOrgManager(USER_ID)).resolves.toBe(expected);
      expect(portal.whoisApps).toHaveBeenCalledWith({ subject: SUBJECT, appIds: [], surface: 'hub', organizationId: 'org-hub' });
    });

    it('is false when the Portal predates role-only questions, and the log says why', async () => {
      portal.whoisApps.mockResolvedValue(answer([], 400));

      await expect(service.isOrgManager(USER_ID)).resolves.toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(`api_key_full_role_unverified userId=${USER_ID} status=400`);
    });

    it('is false on a 409 ORGANIZATION_REQUIRED, and the log says why', async () => {
      portal.whoisApps.mockResolvedValue(organizationRequired);

      await expect(service.isOrgManager(USER_ID)).resolves.toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(`api_key_full_role_unverified userId=${USER_ID} status=409`);
    });
  });

  /*
   * Both role reads share one early exit: with no organization of our own to name, there is no answer a role
   * could be read from, so the Portal is not asked. One table over both entry points, so neither loses a case.
   */
  describe.each([
    ['hasManagingRole', 'custom_domain', (whois: MarketplaceWhoIsService) => whois.hasManagingRole(USER_ID, APP_URN)],
    ['isOrgManager', 'api_key_full', (whois: MarketplaceWhoIsService) => whois.isOrgManager(USER_ID)],
  ] as const)('%s without an organization of our own', (_method, purpose, ask) => {
    it.each([
      ['cannot be read', () => registration.getDeviceRegistrationInfo.mockRejectedValue(new Error('disk'))],
      ['does not exist', () => registration.getDeviceRegistrationInfo.mockResolvedValue(undefined as never)],
    ])("is false without asking the Portal when this device's registration %s, and the log says why", async (_label, arrange) => {
      portal.whoisApps.mockResolvedValue({
        status: 200,
        body: { organizations: [{ organizationId: 'org-hub', user: { role: 'owner' }, apps: [] }] },
      });
      arrange();

      await expect(ask(service)).resolves.toBe(false);
      expect(portal.whoisApps).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(`${purpose}_role_unverified userId=${USER_ID} status=no-organization`);
    });
  });

  /*
   * Hub-wide changes (settings, keys, providers, updates, pool, app stores, registration, factory reset)
   * and the Hub's own log are an owner's or admin's. Asked of the Portal fresh, about no app.
   */
  describe('hubManageVerdict: who may change the whole Hub', () => {
    const roleAnswer = (role: string, status = 200) =>
      ({ status, body: { organizations: [{ organizationId: 'org-hub', version: 1, user: { role }, apps: [] }] } }) as never;
    const hostLocalReq = () => ({ user: { id: 1 }, hubPrincipal: 'host-local' }) as Request;

    it.each(['owner', 'admin'] as const)('lets an organization %s through, asking the Portal about no app', async (role) => {
      portal.whoisApps.mockResolvedValue(roleAnswer(role));

      await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('allowed');
      await expect(service.assertSessionMayManageHub(sessionReq())).resolves.toBeUndefined();
      expect(portal.whoisApps).toHaveBeenCalledWith({ subject: SUBJECT, appIds: [], surface: 'hub', organizationId: 'org-hub' });
    });

    it('refuses a member with 403', async () => {
      portal.whoisApps.mockResolvedValue(roleAnswer('member'));

      await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('refused');
      await expect(service.assertSessionMayManageHub(sessionReq())).rejects.toMatchObject({
        message: 'HUB_MANAGE_ROLE_REQUIRED',
        status: HttpStatus.FORBIDDEN,
      });
    });

    it('refuses someone the Portal lists in no organization of ours', async () => {
      portal.whoisApps.mockResolvedValue({ status: 200, body: { organizations: [] } } as never);

      await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('refused');
    });

    it('refuses with 503 and says why when the Portal cannot answer', async () => {
      portal.whoisApps.mockResolvedValue(roleAnswer('owner', 503));

      await expect(service.assertSessionMayManageHub(sessionReq())).rejects.toMatchObject({
        message: 'HUB_MANAGE_ROLE_UNVERIFIED',
        status: HttpStatus.SERVICE_UNAVAILABLE,
      });
      expect(logger.warn).toHaveBeenCalledWith(`hub_manage_role_unverified userId=${USER_ID} status=503`);
    });

    it('is unknown when the Portal cannot be reached', async () => {
      portal.whoisApps.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('unknown');
    });

    /*
     * One AI settings save is several guarded requests. An owner's or admin's yes is kept for a minute,
     * so a demotion in the Portal takes effect within one. A no or a failure is never kept.
     */
    describe('keeping a yes for a minute', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it('asks the Portal once a minute for an owner or admin, and a demotion counts after that', async () => {
        vi.useFakeTimers();
        portal.whoisApps.mockResolvedValue(roleAnswer('admin'));

        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('allowed');
        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('allowed');
        expect(portal.whoisApps).toHaveBeenCalledTimes(1);

        portal.whoisApps.mockResolvedValue(roleAnswer('member'));
        vi.advanceTimersByTime(60_001);

        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('refused');
        expect(portal.whoisApps).toHaveBeenCalledTimes(2);
      });

      it("never keeps a member's answer or a failure", async () => {
        portal.whoisApps
          .mockResolvedValueOnce(roleAnswer('member'))
          .mockResolvedValueOnce(roleAnswer('owner', 503))
          .mockRejectedValueOnce(new Error('ECONNREFUSED'))
          .mockResolvedValue(roleAnswer('member'));

        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('refused');
        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('unknown');
        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('unknown');
        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('refused');
        expect(portal.whoisApps).toHaveBeenCalledTimes(4);
      });

      it('keeps a yes for that person, Portal identity and organization only', async () => {
        portal.whoisApps.mockResolvedValue(roleAnswer('owner'));
        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('allowed');

        await service.hubManageVerdict(sessionReq(8));
        expect(portal.whoisApps).toHaveBeenCalledTimes(2);

        federatedIdentities.findByUserId.mockResolvedValue([{ subject: 'portal-user-2' }] as never);
        await service.hubManageVerdict(sessionReq());
        expect(portal.whoisApps).toHaveBeenCalledTimes(3);

        // Paired to another organization, where the Portal lists no role for this person.
        registration.getDeviceRegistrationInfo.mockResolvedValue({ id: 'org-other' } as never);
        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('refused');
        expect(portal.whoisApps).toHaveBeenCalledTimes(4);
      });

      it('refuses at once when the Hub is unpaired', async () => {
        portal.whoisApps.mockResolvedValue(roleAnswer('owner'));
        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('allowed');

        registration.getDeviceRegistrationInfo.mockResolvedValue(undefined as never);

        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('refused');
      });

      it('leaves the API key and custom app role reads fresh', async () => {
        portal.whoisApps.mockResolvedValue(roleAnswer('owner'));
        await service.hubManageVerdict(sessionReq());

        await expect(service.isOrgManager(USER_ID)).resolves.toBe(true);
        expect(portal.whoisApps).toHaveBeenCalledTimes(2);
      });
    });

    it('asks the Portal each time rather than trusting the role stored at sign-in', async () => {
      const storedOwner = { hubSessionId: 'sess-1', user: { id: USER_ID, orgRole: 'owner' }, hubPrincipal: 'session' } as unknown as Request;
      portal.whoisApps.mockResolvedValue(roleAnswer('member'));

      await expect(service.hubManageVerdict(storedOwner)).resolves.toBe('refused');
    });

    /*
     * The person who set the Hub up keeps it: the claiming operator passes whatever the Portal says
     * their role is, and the Portal is not asked.
     */
    describe('the operator who claimed the Hub', () => {
      const memberReq = (userId: number) =>
        ({ hubSessionId: `sess-${userId}`, user: { id: userId, orgRole: 'member' }, hubPrincipal: 'session' }) as unknown as Request;

      it('keeps Hub-wide writes as a member, and the Portal is not asked', async () => {
        users.getFirstOperator.mockResolvedValue({ id: USER_ID } as never);
        portal.whoisApps.mockResolvedValue(roleAnswer('member'));

        await expect(service.assertSessionMayManageHub(memberReq(USER_ID))).resolves.toBeUndefined();
        await expect(service.hubManageHint(memberReq(USER_ID))).resolves.toBe(true);
        expect(portal.whoisApps).not.toHaveBeenCalled();
      });

      it('keeps them while the Portal is down', async () => {
        users.getFirstOperator.mockResolvedValue({ id: USER_ID } as never);
        portal.whoisApps.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('allowed');
      });

      /*
       * The hourly membership sweep revokes the claimer too when the Portal removes them. They can't
       * sign in, so the routes never see them, but a key they created asks about them by id.
       */
      it('loses the pass once their access is revoked, and follows the Portal like anyone else', async () => {
        users.getFirstOperator.mockResolvedValue({ id: USER_ID, accessStatus: 'revoked' } as never);
        portal.whoisApps.mockResolvedValue(roleAnswer('member'));

        await expect(service.isClaimingOperator(USER_ID)).resolves.toBe(false);
        await expect(service.hubManageVerdictFor(USER_ID)).resolves.toBe('refused');
        expect(portal.whoisApps).toHaveBeenCalledTimes(1);
      });

      it('gives another member nothing: 403', async () => {
        users.getFirstOperator.mockResolvedValue({ id: 1 } as never);
        portal.whoisApps.mockResolvedValue(roleAnswer('member'));

        await expect(service.assertSessionMayManageHub(memberReq(USER_ID))).rejects.toMatchObject({
          message: 'HUB_MANAGE_ROLE_REQUIRED',
          status: HttpStatus.FORBIDDEN,
        });
        await expect(service.hubManageHint(memberReq(USER_ID))).resolves.toBe(false);
      });

      /*
       * A factory reset truncates the user table with RESTART IDENTITY and drops every session
       * (factory-reset.service.test.ts), and only a Hub with no operator can be claimed. So the next
       * claimer gets the first row, and the old claimer, signing in again, gets a new one.
       */
      it('moves to whoever claims the Hub after a factory reset, and the old claimer is a member like any other', async () => {
        let operators: Array<{ id: number }> = [{ id: 1 }];
        users.getFirstOperator.mockImplementation(async () => [...operators].sort((a, b) => a.id - b.id)[0] as never);
        portal.whoisApps.mockResolvedValue(roleAnswer('member'));
        const oldClaimer = 1;

        await expect(service.hubManageVerdict(memberReq(oldClaimer))).resolves.toBe('allowed');

        // The reset empties the table, someone else claims the Hub, and the old claimer signs in again.
        operators = [];
        const newClaimer = 1;
        operators.push({ id: newClaimer });
        const oldClaimerAgain = 2;
        operators.push({ id: oldClaimerAgain });

        await expect(service.hubManageVerdict(memberReq(newClaimer))).resolves.toBe('allowed');
        await expect(service.assertSessionMayManageHub(memberReq(oldClaimerAgain))).rejects.toMatchObject({
          message: 'HUB_MANAGE_ROLE_REQUIRED',
          status: HttpStatus.FORBIDDEN,
        });
        await expect(service.hubManageHint(memberReq(oldClaimerAgain))).resolves.toBe(false);
      });
    });

    describe('with no role to ask about', () => {
      it('lets the operator who claimed an unpaired Hub through, without asking the Portal', async () => {
        registration.getDeviceRegistrationInfo.mockResolvedValue(undefined as never);
        users.getFirstOperator.mockResolvedValue({ id: USER_ID } as never);

        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('allowed');
        expect(portal.whoisApps).not.toHaveBeenCalled();
      });

      it('refuses any other operator on an unpaired Hub', async () => {
        registration.getDeviceRegistrationInfo.mockResolvedValue(undefined as never);

        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('refused');
      });

      it('lets an operator with no linked Portal identity through only when they claimed the Hub', async () => {
        federatedIdentities.findByUserId.mockResolvedValue([] as never);

        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('refused');

        users.getFirstOperator.mockResolvedValue({ id: USER_ID } as never);
        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('allowed');
        expect(portal.whoisApps).not.toHaveBeenCalled();
      });

      it('refuses when the operator rows cannot be read', async () => {
        federatedIdentities.findByUserId.mockResolvedValue([] as never);
        users.getFirstOperator.mockRejectedValue(new Error('db down'));

        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('refused');
      });
    });

    it('lets the CLI and the host-local key through without asking the Portal', async () => {
      await expect(service.hubManageVerdict(cliReq())).resolves.toBe('allowed');
      await expect(service.hubManageVerdict(hostLocalReq())).resolves.toBe('allowed');
      expect(portal.whoisApps).not.toHaveBeenCalled();
    });

    it('refuses the Portal push and an unnamed principal, and the log names them', async () => {
      await expect(service.assertSessionMayManageHub(portalPushReq())).rejects.toMatchObject({ message: 'HUB_MANAGE_ROLE_REQUIRED' });
      await expect(service.hubManageVerdict(unknownPrincipalReq())).resolves.toBe('refused');
      expect(logger.warn).toHaveBeenCalledWith('hub_manage_refused principal=portal-device');
      expect(logger.warn).toHaveBeenCalledWith('hub_manage_refused principal=none');
      expect(portal.whoisApps).not.toHaveBeenCalled();
    });

    /* An MCP key asks about the person who created it, named by id, on each Hub-wide tool call. */
    describe('hubManageVerdictFor', () => {
      it.each([
        ['owner', 'allowed'],
        ['admin', 'allowed'],
        ['member', 'refused'],
      ] as const)('asks the Portal about an organization %s and answers %s', async (role, expected) => {
        portal.whoisApps.mockResolvedValue(roleAnswer(role));

        await expect(service.hubManageVerdictFor(USER_ID)).resolves.toBe(expected);
        expect(portal.whoisApps).toHaveBeenCalledWith({ subject: SUBJECT, appIds: [], surface: 'hub', organizationId: 'org-hub' });
      });

      it('is unknown when the Portal cannot be reached', async () => {
        portal.whoisApps.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(service.hubManageVerdictFor(USER_ID)).resolves.toBe('unknown');
      });

      it('lets the operator who claimed the Hub through without asking the Portal', async () => {
        users.getFirstOperator.mockResolvedValue({ id: USER_ID } as never);
        portal.whoisApps.mockResolvedValue(roleAnswer('member'));

        await expect(service.hubManageVerdictFor(USER_ID)).resolves.toBe('allowed');
        expect(portal.whoisApps).not.toHaveBeenCalled();
      });

      it("shares the routes' kept yes for the same person", async () => {
        portal.whoisApps.mockResolvedValue(roleAnswer('owner'));

        await expect(service.hubManageVerdict(sessionReq())).resolves.toBe('allowed');
        await expect(service.hubManageVerdictFor(USER_ID)).resolves.toBe('allowed');
        expect(portal.whoisApps).toHaveBeenCalledTimes(1);
      });
    });

    /*
     * The Settings key list and the MCP tools/list read the role the Hub stored for a key's creator, so
     * neither waits on the Portal. Only the calls ask it.
     */
    describe('storedHubManageVerdictFor', () => {
      const storedRole = (orgRole: 'owner' | 'admin' | 'member' | null) => users.getUserDtoById.mockResolvedValue({ id: USER_ID, orgRole } as never);

      it.each([
        ['owner', 'allowed'],
        ['admin', 'allowed'],
        ['member', 'refused'],
        [null, 'unknown'],
      ] as const)('answers a stored %s with %s without asking the Portal', async (role, expected) => {
        storedRole(role);

        await expect(service.storedHubManageVerdictFor(USER_ID)).resolves.toBe(expected);
        expect(users.getUserDtoById).toHaveBeenCalledWith(USER_ID);
        expect(portal.whoisApps).not.toHaveBeenCalled();
      });

      it('allows the operator who claimed the Hub whatever role is stored', async () => {
        storedRole('member');
        users.getFirstOperator.mockResolvedValue({ id: USER_ID } as never);

        await expect(service.storedHubManageVerdictFor(USER_ID)).resolves.toBe('allowed');
      });

      it('refuses a stored owner with no role the routes could read: unlinked, or on an unpaired Hub', async () => {
        storedRole('owner');
        federatedIdentities.findByUserId.mockResolvedValue([] as never);
        await expect(service.storedHubManageVerdictFor(USER_ID)).resolves.toBe('refused');

        federatedIdentities.findByUserId.mockResolvedValue([{ subject: SUBJECT }] as never);
        registration.getDeviceRegistrationInfo.mockResolvedValue(undefined as never);
        await expect(service.storedHubManageVerdictFor(USER_ID)).resolves.toBe('refused');
      });

      it("is unknown when the person's row, identity or this Hub's registration can't be read", async () => {
        users.getUserDtoById.mockRejectedValue(new Error('db down'));
        await expect(service.storedHubManageVerdictFor(USER_ID)).resolves.toBe('unknown');

        storedRole('owner');
        federatedIdentities.findByUserId.mockRejectedValue(new Error('db down'));
        await expect(service.storedHubManageVerdictFor(USER_ID)).resolves.toBe('unknown');

        federatedIdentities.findByUserId.mockResolvedValue([{ subject: SUBJECT }] as never);
        registration.getDeviceRegistrationInfo.mockRejectedValue(new Error('db down'));
        await expect(service.storedHubManageVerdictFor(USER_ID)).resolves.toBe('unknown');
      });

      it('refuses someone whose access was revoked, whatever role is still stored', async () => {
        users.getUserDtoById.mockResolvedValue({ id: USER_ID, orgRole: 'owner', accessStatus: 'revoked' } as never);
        await expect(service.storedHubManageVerdictFor(USER_ID)).resolves.toBe('refused');

        users.getFirstOperator.mockResolvedValue({ id: USER_ID, accessStatus: 'revoked' } as never);
        await expect(service.storedHubManageVerdictFor(USER_ID)).resolves.toBe('refused');
      });

      // A claimer the Portal calls a member is stored as one. A failed read of who claimed the Hub must
      // not turn that stored role into a refusal of every key they made.
      it('is unknown, not refused, when the operator rows cannot be read', async () => {
        storedRole('member');
        users.getFirstOperator.mockRejectedValue(new Error('db down'));

        await expect(service.storedHubManageVerdictFor(USER_ID)).resolves.toBe('unknown');
      });
    });

    /* The UI's question, answered from the role stored at sign-in, as for custom apps. */
    describe('hubManageHint', () => {
      const withStoredRole = (orgRole: 'owner' | 'admin' | 'member' | null) =>
        ({ hubSessionId: 'sess-1', user: { id: USER_ID, orgRole }, hubPrincipal: 'session' }) as unknown as Request;

      it.each([
        ['owner', true],
        ['admin', true],
        ['member', false],
      ] as const)('answers a stored %s with %s without asking the Portal', async (role, expected) => {
        await expect(service.hubManageHint(withStoredRole(role))).resolves.toBe(expected);
        expect(portal.whoisApps).not.toHaveBeenCalled();
      });

      it('asks the Portal when no role is stored', async () => {
        portal.whoisApps.mockResolvedValue(roleAnswer('admin'));

        await expect(service.hubManageHint(withStoredRole(null))).resolves.toBe(true);
        expect(portal.whoisApps).toHaveBeenCalledTimes(1);
      });

      it('answers as the routes do when there is no role to ask about, whatever role the row says', async () => {
        federatedIdentities.findByUserId.mockResolvedValue([] as never);

        await expect(service.hubManageHint(withStoredRole('owner'))).resolves.toBe(false);

        users.getFirstOperator.mockResolvedValue({ id: USER_ID } as never);
        await expect(service.hubManageHint(withStoredRole('member'))).resolves.toBe(true);
        expect(portal.whoisApps).not.toHaveBeenCalled();
      });

      it('offers nothing when the identity cannot be read', async () => {
        federatedIdentities.findByUserId.mockRejectedValue(new Error('db down'));

        await expect(service.hubManageHint(withStoredRole('owner'))).resolves.toBe(false);
      });

      it('offers the CLI everything and the Portal push nothing', async () => {
        await expect(service.hubManageHint(cliReq())).resolves.toBe(true);
        await expect(service.hubManageHint(portalPushReq())).resolves.toBe(false);
      });
    });
  });
});
