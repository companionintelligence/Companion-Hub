import type { Request } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { TranslatableError } from '@/common/error/translatable-error';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { CustomAppController } from '../custom-apps.controller';
import { CustomAppService } from '../custom-apps.service';
import { PortExposeService } from '../port-expose.service';

/*
 * Changing a custom app takes an organization owner or admin, which `MarketplaceWhoIsService` decides
 * for `configure` on a `_user` app. These routes rewrite the app's docker-compose.json, logo and
 * notes, so each asks that question for this request before the service writes anything.
 */
describe('CustomAppController: a change to a custom app asks for configure first', () => {
  const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;
  const appUrn = 'my-compose:_user';
  const config = { schemaVersion: 2, services: [{ name: 'web', image: 'nginx', isMain: true }] } as never;
  const image = { buffer: Buffer.from('jpg'), mimetype: 'image/jpeg' };

  let customApps: MockProxy<CustomAppService>;
  let whois: MockProxy<MarketplaceWhoIsService>;
  let controller: CustomAppController;

  beforeEach(() => {
    customApps = mock<CustomAppService>();
    whois = mock<MarketplaceWhoIsService>();
    controller = new CustomAppController(customApps, mock<PortExposeService>(), whois);
  });

  const routes = [
    ['updateCustomApp', (c: CustomAppController) => c.updateCustomApp(appUrn, { config } as never, req)],
    ['uploadAppImage', (c: CustomAppController) => c.uploadAppImage(appUrn, req, image)],
    ['updateAppMetadata', (c: CustomAppController) => c.updateAppMetadata(appUrn, { data: '# Notes' } as never, req)],
  ] as const;

  it.each(routes)('%s asserts configure on the app for this request', async (method, route) => {
    await route(controller);

    expect(whois.assertSessionAction).toHaveBeenCalledWith(req, appUrn, 'configure');
    expect(customApps[method]).toHaveBeenCalledTimes(1);
  });

  it.each(routes)('%s writes nothing when the grant is refused', async (method, route) => {
    whois.assertSessionAction.mockRejectedValue(new TranslatableError('APP_ACTION_GRANT_DENIED', { action: 'configure' }, 403));

    await expect(route(controller)).rejects.toMatchObject({ message: 'APP_ACTION_GRANT_DENIED' });
    expect(customApps[method]).not.toHaveBeenCalled();
  });
});

/*
 * Creating a custom app takes an organization owner or admin too. The route asks before the service
 * writes a file, and the UI reads what the session may do from `GET /custom-apps/access`.
 */
describe('CustomAppController: creating a custom app, and what the session may do', () => {
  const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;
  const body = { name: 'Whoami Check', config: { schemaVersion: 2, services: [{ name: 'web', image: 'traefik/whoami', isMain: true }] } } as never;

  let customApps: MockProxy<CustomAppService>;
  let whois: MockProxy<MarketplaceWhoIsService>;
  let controller: CustomAppController;

  beforeEach(() => {
    customApps = mock<CustomAppService>();
    customApps.createCustomApp.mockResolvedValue({ appUrn: 'whoami-check:_user', appName: 'whoami-check', storeId: '_user' } as never);
    whois = mock<MarketplaceWhoIsService>();
    controller = new CustomAppController(customApps, mock<PortExposeService>(), whois);
  });

  it('asks whether this session may create one before anything is written', async () => {
    await controller.createCustomApp(body, req);

    expect(whois.assertSessionMayCreateCustomApp).toHaveBeenCalledWith(req);
    expect(customApps.createCustomApp).toHaveBeenCalledWith(body);
  });

  it('writes nothing when the session may not', async () => {
    whois.assertSessionMayCreateCustomApp.mockRejectedValue(new TranslatableError('CUSTOM_APP_CREATE_ROLE_REQUIRED', {}, 403));

    await expect(controller.createCustomApp(body, req)).rejects.toMatchObject({ message: 'CUSTOM_APP_CREATE_ROLE_REQUIRED' });
    expect(customApps.createCustomApp).not.toHaveBeenCalled();
  });

  it('answers the access question from the stored role, which the grant service reads without the Portal', async () => {
    whois.customAppActionsHint.mockResolvedValue(['view']);

    await expect(controller.getCustomAppAccess(req)).resolves.toEqual({ actions: ['view'] });
    expect(whois.customAppActionsHint).toHaveBeenCalledWith(req);
    expect(whois.customAppActions).not.toHaveBeenCalled();
  });
});
