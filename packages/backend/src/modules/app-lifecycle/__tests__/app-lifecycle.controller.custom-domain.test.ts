import type { Request } from 'express';
import { HttpStatus } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { TranslatableError } from '@/common/error/translatable-error';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AppLifecycleController } from '../app-lifecycle.controller';
import { AppLifecycleService } from '../app-lifecycle.service';
import { AppRehydrationService } from '../app-rehydration.service';
import { HubAccessService } from '../hub-access.service';

/*
 * R2-HUBDOMAINS-1: which custom domain an app serves is the organization's call,
 * so a save that CHANGES it also needs an owner or admin — on top of, not
 * instead of, the per-app verb. What counts as a change is the service's to say
 * (`authorizeCustomDomainChange`); the route says who is asking.
 */
describe('AppLifecycleController — custom-domain changes take an owner or admin', () => {
  const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;
  const appUrn = 'comfyui:ci-marketplace';

  let lifecycle: MockProxy<AppLifecycleService>;
  let whois: MockProxy<MarketplaceWhoIsService>;
  let controller: AppLifecycleController;

  /** The service found a change: run the check the route handed it. */
  const aChange = () => lifecycle.authorizeCustomDomainChange.mockImplementation(async (_urn, _form, authorize) => authorize());

  beforeEach(() => {
    lifecycle = mock<AppLifecycleService>();
    whois = mock<MarketplaceWhoIsService>();
    lifecycle.installApp.mockResolvedValue({ requestId: 'r' } as never);
    lifecycle.updateAppConfig.mockResolvedValue({ requestId: 'r' } as never);
    controller = new AppLifecycleController(lifecycle, mock<AppRehydrationService>(), mock<HubAccessService>(), whois);
  });

  it.each([
    ['install', 'install', (body: never) => controller.installApp(appUrn, body, req)],
    ['update-config', 'configure', (body: never) => controller.updateAppConfig(appUrn, body, req)],
  ])('%s asks for the role, naming the %s verb, when the service finds a change', async (_route, verb, call) => {
    aChange();
    const body = { customDomain: 'other.acme.com' } as never;

    await call(body);

    expect(lifecycle.authorizeCustomDomainChange).toHaveBeenCalledWith(appUrn, body, expect.any(Function));
    expect(whois.assertCustomDomainAuthority).toHaveBeenCalledWith(req, appUrn, verb);
  });

  it('does not ask when the service finds no change', async () => {
    lifecycle.authorizeCustomDomainChange.mockResolvedValue(undefined);

    await controller.updateAppConfig(appUrn, { customDomain: 'shop.acme.com', port: 8080 } as never, req);

    expect(whois.assertCustomDomainAuthority).not.toHaveBeenCalled();
    expect(lifecycle.updateAppConfig).toHaveBeenCalled();
  });

  it('asks only once the per-app verb has admitted the caller', async () => {
    whois.assertSessionAction.mockRejectedValue(new TranslatableError('APP_ACTION_GRANT_DENIED', { action: 'configure' }, HttpStatus.FORBIDDEN));

    await expect(controller.updateAppConfig(appUrn, { customDomain: '' } as never, req)).rejects.toThrow('APP_ACTION_GRANT_DENIED');
    expect(lifecycle.authorizeCustomDomainChange).not.toHaveBeenCalled();
  });

  it.each([
    ['install', (body: never) => controller.installApp(appUrn, body, req), () => lifecycle.installApp],
    ['update-config', (body: never) => controller.updateAppConfig(appUrn, body, req), () => lifecycle.updateAppConfig],
  ])('a refused %s never reaches the service', async (_label, call, serviceCall) => {
    aChange();
    whois.assertCustomDomainAuthority.mockRejectedValue(new TranslatableError('CUSTOM_DOMAIN_ROLE_REQUIRED', {}, HttpStatus.FORBIDDEN));

    await expect(call({ customDomain: '' } as never)).rejects.toThrow('CUSTOM_DOMAIN_ROLE_REQUIRED');
    expect(serviceCall()).not.toHaveBeenCalled();
  });
});
