import { describe, it, expect, beforeEach } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { mock } from 'vitest-mock-extended';
import type { Request } from 'express';
import type { AppUrn } from '@ci-hub/common/types';
import { TranslatableError } from '@/common/error/translatable-error';
import { DatabaseService } from '@/core/database/database.service';
import { LoggerService } from '@/core/logger/logger.service';
import { EVERY_ADDRESS_FAILED, axiosEveryAddressFailed } from '@/tests/utils/network-failures';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { PortalClientService } from '../portal-client.service';
import { MarketplaceWhoIsService } from '../marketplace-whois.service';
import { DEFAULT_MEMBER_ACTIONS } from '../hub-actions';

const APP_URN = 'immich:ci-marketplace' as AppUrn;
const SUBJECT = 'portal-user-1';
const USER_ID = 7;

describe('MarketplaceWhoIsService', () => {
  let portal: ReturnType<typeof mock<PortalClientService>>;
  let database: ReturnType<typeof mock<DatabaseService>>;
  let logger: ReturnType<typeof mock<LoggerService>>;
  let federatedIdentities: ReturnType<typeof mock<FederatedIdentityRepository>>;
  let registration: ReturnType<typeof mock<RegistrationService>>;
  let service: MarketplaceWhoIsService;
  let cacheRows: Array<{
    subject: string;
    appId: string;
    canJson: string;
    version: number;
    cachedAt: string;
  }>;
  let portExposeRows: Array<{ appName: string; config: { kind?: string } | null }>;

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
    cacheRows = [];
    portExposeRows = [];

    database.db = {
      select: () => ({
        from: (table: object) => ({
          where: () => {
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

    service = new MarketplaceWhoIsService(portal, database, logger, federatedIdentities, registration);
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

  it('does not exempt a custom app in _user that is not a port expose', async () => {
    portExposeRows = [{ appName: 'my-compose', config: { kind: 'custom' } }];
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: { organizations: [{ organizationId: 'org-hub', version: 1, apps: [] }] },
    });

    await expect(service.assertSessionAction(sessionReq(), 'my-compose:_user' as AppUrn, 'view')).rejects.toMatchObject({
      message: 'APP_ACTION_GRANT_DENIED',
    });
    expect(portal.whoisApps).toHaveBeenCalledWith(expect.objectContaining({ appIds: ['my-compose'] }));
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
});
