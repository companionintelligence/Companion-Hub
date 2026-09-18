/**
 * `GET /api/apps/:urn` is on the `qa:read` key's list so an install journey can poll for `running`.
 * The same payload carries `app.config` — the install form, with whatever admin passwords and provider
 * keys a manifest asked for — and a leaked test key must not become a way to read every app's secrets.
 */
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import type { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import type { AppRuntimeMonitorService } from '../app-runtime-monitor.service';
import type { AppsReadService } from '../apps-read.service';
import type { AppsService } from '../apps.service';
import { AppsController } from '../apps.controller';

const APP_URN = 'open-webui:ci-marketplace';

function controllerServing(config: Record<string, unknown>) {
  const read = mock<AppsReadService>();
  read.getApp.mockResolvedValue({
    app: { id: 3, status: 'running', config, version: 1, port: 8080 },
    info: { id: 'open-webui', urn: APP_URN, name: 'Open WebUI' },
    metadata: {},
    allocatedPort: 8080,
    appDataHostPath: null,
  } as never);
  const whois = mock<MarketplaceWhoIsService>();
  whois.assertSessionAction.mockResolvedValue(undefined);
  return new AppsController(read, mock<AppsService>(), mock<AppRuntimeMonitorService>(), mock<ModuleRef>(), whois);
}

describe('AppsController.getApp for a qa:read key', () => {
  const secrets = { WEBUI_ADMIN_PASSWORD: 'hunter2', OPENAI_API_KEY: 'sk-live-abc' };

  it('returns the status a test polls for, without the install form', async () => {
    const result = await controllerServing(secrets).getApp(APP_URN, { hubPrincipal: 'qa-read' } as Request);

    expect(result.app).toMatchObject({ status: 'running' });
    expect(result.app?.config).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('sk-live-abc');
  });

  it('still returns the config to an operator, whose settings dialog is built from it', async () => {
    const result = await controllerServing(secrets).getApp(APP_URN, { hubPrincipal: 'session', user: { id: 1 } } as Request);

    expect(result.app?.config).toEqual(secrets);
  });
});
