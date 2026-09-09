import { describe, it, expect, beforeEach } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { mock } from 'vitest-mock-extended';
import type { Request } from 'express';
import type { AppUrn } from '@ci-hub/common/types';
import { TranslatableError } from '@/common/error/translatable-error';
import { DatabaseService } from '@/core/database/database.service';
import { LoggerService } from '@/core/logger/logger.service';
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

    database.db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => cacheRows,
          }),
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

  it('does not send organizationId on device WhoIs', async () => {
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [{ organizationId: 'org-hub', version: 1, apps: [{ appId: 'immich', can: ['view'] }] }],
      },
    });

    await service.has(USER_ID, APP_URN, 'view');

    expect(portal.whoisApps).toHaveBeenCalledWith({
      subject: SUBJECT,
      appIds: ['immich'],
      surface: 'hub',
    });
    expect(portal.whoisApps.mock.calls[0]?.[0]).not.toHaveProperty('organizationId');
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

  it("refuses when this device's own organization cannot be read", async () => {
    // The registration read failing used to be swallowed into `null` and fall
    // through to the same arbitrary pick — so a transient failure to learn our
    // own identity silently widened every grant on the appliance.
    registration.getDeviceRegistrationInfo.mockRejectedValue(new Error('db down'));
    portal.whoisApps.mockResolvedValue({
      status: 200,
      body: {
        organizations: [{ organizationId: 'org-hub', version: 1, apps: [{ appId: 'immich', can: ['install'] }] }],
      },
    });

    await expect(service.has(USER_ID, APP_URN, 'install')).resolves.toBe(false);
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

  it('fails open on list when Portal is unreachable and there is no fresh cache', async () => {
    portal.whoisApps.mockRejectedValue(new Error('ECONNREFUSED'));
    const items = [{ urn: APP_URN }, { urn: 'plex:ci-marketplace' as AppUrn }];

    const visible = await service.filterSessionByView(sessionReq(), items, (item) => item.urn, 'hub');

    expect(visible).toEqual(items);
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

  it('refuses a sweep from a caller with no recognised principal', () => {
    // `updateAllApps` and friends act on every installed app, so the sweep gets the
    // same answer the named routes do rather than `operatorMay`'s fail-open.
    expect(() => service.sweepOperatorUserId(unknownPrincipalReq(), 'update')).toThrowError(TranslatableError);
  });

  it('resolves the sweep operator for a Hub session', () => {
    expect(service.sweepOperatorUserId(sessionReq(), 'update')).toBe(USER_ID);
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
});
