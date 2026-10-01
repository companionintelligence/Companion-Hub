/**
 * `GET /api/apps/guest` has no guard: it feeds the guest dashboard to anyone who can reach the
 * Hub. The row it serves carries `config` — the install form, with whatever admin passwords and
 * provider keys a manifest asked for — and none of it belongs in a response to an anonymous caller.
 */
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import type { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import type { AppRuntimeMonitorService } from '../app-runtime-monitor.service';
import type { AppsReadService } from '../apps-read.service';
import type { AppsService } from '../apps.service';
import { AppsController } from '../apps.controller';

const secrets = { WEBUI_ADMIN_PASSWORD: 'hunter2', OPENAI_API_KEY: 'sk-live-abc' };

function controllerServingGuestApps(overrides: Record<string, unknown> = {}) {
  const read = mock<AppsReadService>();
  read.getGuestDashboardApps.mockResolvedValue([
    {
      app: {
        // The repository loads the row `with: { appStore: true }`; a store URL can carry a token.
        appStore: { id: 1, slug: 'private-store', url: 'https://ghp_privatetoken@github.com/org/private-store.git' },
        subnet: '172.20.0.0/24',
        appName: 'open-webui',
        id: 3,
        status: 'running',
        version: 1,
        port: 8080,
        exposed: true,
        openPort: true,
        exposedLocal: true,
        domain: 'open-webui.example.test',
        isVisibleOnGuestDashboard: true,
        config: secrets,
        customDomainIntent: 'not-yet-published.example.test',
        ...overrides,
      },
      info: { id: 'open-webui', urn: 'open-webui:ci-marketplace', name: 'Open WebUI' },
      metadata: {},
    },
  ] as never);

  return new AppsController(read, mock<AppsService>(), mock<AppRuntimeMonitorService>(), mock<ModuleRef>(), mock<MarketplaceWhoIsService>());
}

describe('AppsController.getGuestApps', () => {
  it('serves the tile data the guest dashboard renders', async () => {
    const result = await controllerServingGuestApps().getGuestApps();

    expect(result.installed).toHaveLength(1);
    expect(result.installed[0]?.app).toMatchObject({ id: 3, status: 'running', domain: 'open-webui.example.test' });
  });

  it('does not include the install form, whatever the row holds', async () => {
    const result = await controllerServingGuestApps().getGuestApps();

    expect(result.installed[0]?.app).not.toHaveProperty('config');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('sk-live-abc');
  });

  it('still withholds a custom domain that is not yet public', async () => {
    const result = await controllerServingGuestApps().getGuestApps();

    expect(JSON.stringify(result)).not.toContain('not-yet-published');
  });

  it('does not include the store the row was loaded with, nor columns the schema does not list', async () => {
    const result = await controllerServingGuestApps().getGuestApps();

    expect(result.installed[0]?.app).not.toHaveProperty('appStore');
    expect(result.installed[0]?.app).not.toHaveProperty('subnet');
    expect(JSON.stringify(result)).not.toContain('ghp_privatetoken');
  });

  it('still withholds all of it when one row no longer validates and the parse would fall back to its raw input', async () => {
    const result = await controllerServingGuestApps({ status: 'a-status-that-does-not-exist', pendingRestart: 'not-a-boolean' }).getGuestApps();

    const body = JSON.stringify(result);
    expect(result.installed).toHaveLength(1);
    expect(body).not.toContain('ghp_privatetoken');
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('sk-live-abc');
    expect(body).not.toContain('not-yet-published');
    expect(body).not.toContain('172.20.0.0');
  });
});
