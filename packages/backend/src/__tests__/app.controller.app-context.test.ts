import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

vi.mock('@/modules/app-lifecycle/app-lifecycle.service', () => ({ AppLifecycleService: class AppLifecycleService {} }));

import type { Request } from 'express';
import { AppController } from '../app.controller';
import type { AppService } from '../app.service';
import type { AppsReadService } from '../modules/apps/apps-read.service';
import type { CloudflareClientService } from '../modules/cloudflare/cloudflare-client.service';
import type { TailscaleService, TailscaleStatus } from '../modules/tailscale/tailscale.service';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { RegistrationService } from '@/modules/registration/registration.service';

/** A host Tailscale client that is signed in, with HTTPS certificates on for the tailnet. */
const CONNECTED: TailscaleStatus = {
  installed: true,
  connected: true,
  version: '1.102.3',
  hostname: 'laptop',
  nodeFqdn: 'laptop.tailxyz.ts.net',
  tailnet: 'tailxyz.ts.net',
  ip: '100.64.0.17',
  supportsServices: true,
  httpsAvailable: true,
  backendState: 'Running',
  authUrl: null,
};

describe('GET /api/app-context — whether Private VPN is offered', () => {
  const savedEnv = {
    PRIVATE_VPN_USER_DISABLED: process.env.PRIVATE_VPN_USER_DISABLED,
    TAILSCALE_SERVE_USER_DISABLED: process.env.TAILSCALE_SERVE_USER_DISABLED,
  };
  let controller: AppController;

  beforeEach(() => {
    delete process.env.PRIVATE_VPN_USER_DISABLED;
    delete process.env.TAILSCALE_SERVE_USER_DISABLED;

    const configuration = mock<ConfigurationService>();
    configuration.getConfig.mockReturnValue({ userSettings: {}, isProduction: true, rootFolderHost: '/opt/ci-hub', architecture: 'amd64' } as never);
    const appService = mock<AppService>();
    appService.getVersion.mockResolvedValue({ current: '1.0.0', latest: '1.0.0', body: '', releases: [] } as never);
    const registrationService = mock<RegistrationService>();
    registrationService.getDeviceRegistrationInfo.mockResolvedValue(null as never);
    const tailscaleService = mock<TailscaleService>();
    tailscaleService.getStatus.mockResolvedValue(CONNECTED);
    const appsReadService = mock<AppsReadService>();
    appsReadService.peekUpdatesAvailableCached.mockReturnValue(0);
    const cloudflareClientService = mock<CloudflareClientService>();
    cloudflareClientService.getTunnelToken.mockReturnValue(null as never);

    // Only the collaborators this route reads matter; the rest are inert stand-ins.
    const unused = () => mock<never>();
    controller = new AppController(
      appService,
      unused(),
      configuration,
      appsReadService,
      unused(),
      registrationService,
      cloudflareClientService,
      tailscaleService,
      unused(),
      unused(),
      unused(),
    );
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const appContext = () => controller.appContext({ user: { id: 1 } } as unknown as Request);

  it('offers Private VPN on a Hub whose tailnet is connected', async () => {
    await expect(appContext()).resolves.toMatchObject({ tailscaleAvailable: true, tailscaleNodeFqdn: 'laptop.tailxyz.ts.net' });
  });

  it('still offers it with PRIVATE_VPN_USER_DISABLED=true, which only keeps the sidecar off (CI-Hub#1757)', async () => {
    process.env.PRIVATE_VPN_USER_DISABLED = 'true';

    await expect(appContext()).resolves.toMatchObject({ tailscaleAvailable: true });
  });

  it('stops offering it when TAILSCALE_SERVE_USER_DISABLED=true, since the Hub then publishes no app', async () => {
    process.env.TAILSCALE_SERVE_USER_DISABLED = 'true';

    await expect(appContext()).resolves.toMatchObject({ tailscaleAvailable: false, tailscaleNodeFqdn: null });
  });
});
