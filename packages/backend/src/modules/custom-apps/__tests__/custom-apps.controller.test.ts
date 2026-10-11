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
