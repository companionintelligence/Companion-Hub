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

  const sessionReq = (userId = USER_ID): Request => ({ hubSessionId: 'sess-1', user: { id: userId } }) as Request;

  /**
   * A Portal push: the device-key bearer arm, which names itself so the grant
   * exemption is a decision rather than the absence of a session.
   */
  const portalPushReq = (userId = USER_ID): Request => ({ user: { id: userId }, hubPrincipal: 'portal-device' }) as Request;

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

  it('gives an unlinked operator the compiled member actions and logs once', async () => {
    federatedIdentities.findByUserId.mockResolvedValue([]);

    await expect(service.has(USER_ID, APP_URN, 'view')).resolves.toBe(true);
    await expect(service.has(USER_ID, APP_URN, 'install')).resolves.toBe(true);
    expect(portal.whoisApps).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(`whois_skipped_unlinked_operator userId=${USER_ID}`);
    expect(DEFAULT_MEMBER_ACTIONS).toContain('view');
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

  it('inherits default member actions when Portal URL is not configured', async () => {
    portal.whoisApps.mockResolvedValue(null);

    await expect(service.has(USER_ID, APP_URN, 'install')).resolves.toBe(true);
    await expect(service.has(USER_ID, APP_URN, 'view')).resolves.toBe(true);
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

  it('no-ops assertSessionAction without a Hub session (Portal-push)', async () => {
    await expect(service.assertSessionAction(portalPushReq(), APP_URN, 'install')).resolves.toBeUndefined();
    expect(portal.whoisApps).not.toHaveBeenCalled();
    expect(federatedIdentities.findByUserId).not.toHaveBeenCalled();
  });

  it('refuses an action from a caller with no recognised principal', async () => {
    /*
     * ⚠ THE EXEMPTION USED TO BE INFERRED FROM A MISSING SESSION, which is true
     * of the Portal-device bearer, of the CLI JWT, and of any authentication arm
     * added later that forgets to set one — so it widened silently every time
     * the middleware grew. A request that reaches a gated route with no
     * principal is a bug, and the safe reading of a bug is a refusal.
     */
    await expect(service.assertSessionAction(unknownPrincipalReq(), APP_URN, 'install')).rejects.toMatchObject({
      status: 403,
    });
    expect(portal.whoisApps).not.toHaveBeenCalled();
  });

  it('sweeps nothing for a caller with no recognised principal', async () => {
    const swept = await service.filterSessionByAction(unknownPrincipalReq(), [APP_URN], 'install');

    expect(swept).toEqual([]);
  });

  it('still shows list rows to an unrecognised principal, because reads fail open', async () => {
    // `filterSessionByView`'s own contract: hiding a row from a READ is how an
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
