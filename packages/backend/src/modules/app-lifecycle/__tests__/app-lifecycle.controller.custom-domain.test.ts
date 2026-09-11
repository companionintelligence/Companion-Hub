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
 * instead of, the per-app verb. A save that leaves it alone does not.
 */
describe('AppLifecycleController — custom-domain changes take an owner or admin', () => {
  const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;
  const appUrn = 'comfyui:ci-marketplace';
  const serving = { intent: 'shop.acme.com', bound: 'shop.acme.com', takeover: false };

  let lifecycle: MockProxy<AppLifecycleService>;
  let whois: MockProxy<MarketplaceWhoIsService>;
  let controller: AppLifecycleController;

  beforeEach(() => {
    lifecycle = mock<AppLifecycleService>();
    whois = mock<MarketplaceWhoIsService>();
    lifecycle.installApp.mockResolvedValue({ requestId: 'r' } as never);
    lifecycle.updateAppConfig.mockResolvedValue({ requestId: 'r' } as never);
    controller = new AppLifecycleController(lifecycle, mock<AppRehydrationService>(), mock<HubAccessService>(), whois);
  });

  it('asks for the role when a save moves the app to another domain', async () => {
    lifecycle.customDomainState.mockResolvedValue(serving);

    await controller.updateAppConfig(appUrn, { customDomain: 'other.acme.com' } as never, req);

    expect(whois.assertCustomDomainAuthority).toHaveBeenCalledWith(req, appUrn);
  });

  it('does not ask when the dialog re-submits the domain the app already serves', async () => {
    lifecycle.customDomainState.mockResolvedValue(serving);

    await controller.updateAppConfig(appUrn, { customDomain: 'shop.acme.com', port: 8080 } as never, req);

    expect(whois.assertCustomDomainAuthority).not.toHaveBeenCalled();
    expect(lifecycle.updateAppConfig).toHaveBeenCalled();
  });

  it('asks on an install that picks a domain', async () => {
    lifecycle.customDomainState.mockResolvedValue(null);

    await controller.installApp(appUrn, { customDomain: 'shop.acme.com' } as never, req);

    expect(whois.assertCustomDomainAuthority).toHaveBeenCalledWith(req, appUrn);
  });

  it.each([
    ['install', (body: never) => controller.installApp(appUrn, body, req), () => lifecycle.installApp],
    ['update-config', (body: never) => controller.updateAppConfig(appUrn, body, req), () => lifecycle.updateAppConfig],
  ])('a refused %s never reaches the service', async (_label, call, serviceCall) => {
    lifecycle.customDomainState.mockResolvedValue(serving);
    whois.assertCustomDomainAuthority.mockRejectedValue(new TranslatableError('CUSTOM_DOMAIN_ROLE_REQUIRED', {}, HttpStatus.FORBIDDEN));

    await expect(call({ customDomain: '' } as never)).rejects.toThrow('CUSTOM_DOMAIN_ROLE_REQUIRED');
    expect(serviceCall()).not.toHaveBeenCalled();
  });
});
