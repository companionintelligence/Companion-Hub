import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DatabaseService } from '@/core/database/database.service';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { FederatedIdentityRepository } from '@/modules/auth/federated-identity.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { UserRepository } from '@/modules/user/user.repository';
import { MemoryConnectController } from '../memory-connect.controller';
import { MemoryConsentUnreachableException } from '../memory-connect.service';

/**
 * Connecting and disconnecting Memory both restart the app, so both take the app's `restart` grant,
 * asked of the Portal the way the restart route asks it. The real WhoIs service runs here; only the
 * Portal's answer is a stand-in.
 */
describe('MemoryConnectController per-app grants', () => {
  const APP = 'ci-openclaw:ci-marketplace';
  // Person 7 holds OpenClaw's restart grant; person 8 may only look at it.
  const GRANTS: Record<string, string[]> = { 'portal-7': ['view', 'start', 'stop', 'restart'], 'portal-8': ['view'] };

  let service: { startConnect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; handleCallback: ReturnType<typeof vi.fn> };
  let controller: MemoryConnectController;

  const session = (userId: number) => ({ hubPrincipal: 'session', user: { id: userId }, headers: { host: 'hub.example.com' } }) as unknown as Request;
  const response = () => ({ redirect: vi.fn() }) as unknown as Response & { redirect: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    const portal = mock<PortalClientService>();
    portal.whoisApps.mockImplementation(async ({ subject, appIds }) => ({
      status: 200,
      body: {
        organizations: [
          { organizationId: 'org-hub', version: 1, user: { role: 'member' }, apps: appIds.map((appId) => ({ appId, can: GRANTS[subject] ?? [] })) },
        ],
      },
    }));
    const federatedIdentities = mock<FederatedIdentityRepository>();
    federatedIdentities.findByUserId.mockImplementation(async (userId) => [{ subject: `portal-${userId}` }] as never);
    const registration = mock<RegistrationService>();
    registration.getDeviceRegistrationInfo.mockResolvedValue({ id: 'org-hub' } as never);
    // An empty WhoIs cache, so every answer comes from the Portal stand-in above.
    const database = mock<DatabaseService>();
    database.db = {
      select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve([]), { limit: () => Promise.resolve([]) }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
    } as unknown as DatabaseService['db'];
    const whois = new MarketplaceWhoIsService(portal, database, mock<LoggerService>(), federatedIdentities, registration, mock<UserRepository>());

    service = {
      startConnect: vi.fn().mockResolvedValue('https://memory.example.org/api/connect?app=ci-openclaw%3Aci-marketplace&state=s'),
      disconnect: vi.fn().mockResolvedValue(undefined),
      // Like the real one: the grant is asked for the app the flow started for, before any exchange.
      handleCallback: vi.fn(async (_code: string, _state: string, _userId: string, mayConnect: (appUrn: string) => Promise<boolean>) =>
        (await mayConnect(APP)) ? { next: '/memory-connect/finishing' } : { next: '/?memoryConnect=denied', error: true },
      ),
    };
    controller = new MemoryConnectController(
      service as never,
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
      mock<UserRepository>() as never,
      { getAppEnv: vi.fn() } as never,
      new EnvUtils(),
      whois,
    );
  });

  it('sends a person without the restart grant back to the Hub instead of to CI Memory', async () => {
    const { url } = await controller.start({ app: APP }, session(8));

    expect(service.startConnect).not.toHaveBeenCalled();
    expect(url).toBe('/?memoryConnect=denied');
  });

  it('starts the connect for a person with the restart grant', async () => {
    const { url } = await controller.start({ app: APP }, session(7));

    expect(service.startConnect).toHaveBeenCalledWith(APP, undefined, '7', { host: 'hub.example.com' });
    expect(url).toBe('https://memory.example.org/api/connect?app=ci-openclaw%3Aci-marketplace&state=s');
  });

  it("lands on the Hub with its own marker when CI Memory's consent page has no address this browser can open", async () => {
    service.startConnect.mockRejectedValueOnce(new MemoryConsentUnreachableException());

    const { url } = await controller.start({ app: APP }, session(7));

    expect(url).toBe('/?memoryConnect=local_only');
  });

  it('refuses Disconnect with APP_ACTION_GRANT_DENIED to a person without the restart grant', async () => {
    await expect(controller.disconnect(APP, session(8), {})).rejects.toMatchObject({ status: 403, message: 'APP_ACTION_GRANT_DENIED' });

    expect(service.disconnect).not.toHaveBeenCalled();
  });

  it('lets a person with the restart grant disconnect, leaving whose connection it is to the service', async () => {
    await expect(controller.disconnect(APP, session(7), {})).resolves.toEqual({ ok: true });

    expect(service.disconnect).toHaveBeenCalledWith(APP, '7');
  });

  // The grant can be taken away while the person is on CI Memory's consent page.
  it('asks for the restart grant again at the callback and sends a refused person to the Hub', async () => {
    const { url } = await controller.callback({ code: 'the-code', state: 'state' }, session(8));

    expect(service.handleCallback).toHaveBeenCalledWith('the-code', 'state', '8', expect.any(Function));
    expect(url).toBe('/?memoryConnect=denied');
  });

  it('lets the callback finish for a person who still holds the restart grant', async () => {
    const { url } = await controller.callback({ code: 'the-code', state: 'state' }, session(7));

    expect(url).toBe('/memory-connect/finishing');
  });

  /*
   * The links themselves decide nothing: a navigation carries no header and the Hub's cookie is no
   * credential (it reaches every app on the Hub's host). They hand the browser to the Hub page,
   * which asks the POST routes above with its own session token.
   */
  it('hands the start and callback navigations to the Hub page, carrying their parameters', () => {
    const start = response();
    controller.startNavigation(APP, 'https://ci-openclaw.example.org/', start);
    const startUrl = new URL(start.redirect.mock.calls[0]?.[0], 'https://hub.example.com');
    expect(startUrl.pathname).toBe('/memory-connect/continue');
    expect(Object.fromEntries(startUrl.searchParams)).toEqual({ step: 'start', app: APP, next: 'https://ci-openclaw.example.org/' });

    const callback = response();
    controller.callbackNavigation('the-code', 'the-state', undefined, callback);
    const callbackUrl = new URL(callback.redirect.mock.calls[0]?.[0], 'https://hub.example.com');
    expect(Object.fromEntries(callbackUrl.searchParams)).toEqual({ step: 'callback', code: 'the-code', state: 'the-state' });
    expect(service.startConnect).not.toHaveBeenCalled();
    expect(service.handleCallback).not.toHaveBeenCalled();
  });
});
