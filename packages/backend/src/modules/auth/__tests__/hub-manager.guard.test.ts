import { GUARDS_METADATA } from '@nestjs/common/constants';
import { HttpStatus, type ExecutionContext } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { TranslatableError } from '@/common/error/translatable-error';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';

vi.mock('@/modules/app-lifecycle/app-lifecycle.service', () => ({ AppLifecycleService: class AppLifecycleService {} }));
vi.mock('@/modules/app-lifecycle/ai-app-inference-refresh.service', () => ({
  AiAppInferenceRefreshService: class AiAppInferenceRefreshService {},
  changedInferenceEnvSettings: () => [],
}));

import { AppController } from '@/app.controller';
import { SSEController } from '@/core/sse/sse.controller';
import { ApiKeyAdminController } from '@/modules/api-keys/api-key-admin.controller';
import { HubPoolController } from '@/modules/hub-pool/hub-pool.controller';
import { InferenceController } from '@/modules/inference/inference.controller';
import { MarketplaceController } from '@/modules/marketplace/marketplace.controller';
import { McpAdminController } from '@/modules/mcp/mcp-admin.controller';
import { NetworkController } from '@/modules/network/network.controller';
import { RegistrationController } from '@/modules/registration/registration.controller';
import { SystemUpdateController } from '@/modules/system-update/system-update.controller';
import { FactoryResetController } from '@/modules/system/factory-reset.controller';
import { SystemController } from '@/modules/system/system.controller';
import { TailscaleController } from '@/modules/tailscale/tailscale.controller';
import { AuthGuard } from '../auth.guard';
import { HubManagerGuard } from '../hub-manager.guard';
import { HubSessionGuard } from '../hub-session.guard';

const contextFor = (request: Partial<Request>) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

const moduleRefWith = (whois: Pick<MarketplaceWhoIsService, 'assertSessionMayManageHub'> | null) =>
  ({
    get: vi.fn((token: unknown) => {
      if (token !== MarketplaceWhoIsService || whois === null) {
        throw new Error('not provided');
      }
      return whois;
    }),
  }) as unknown as ModuleRef;

describe('HubManagerGuard', () => {
  it('lets a request through when the WhoIs service allows it', async () => {
    const whois = { assertSessionMayManageHub: vi.fn(async () => undefined) };
    const request = { hubPrincipal: 'session', user: { id: 7 } } as Partial<Request>;

    await expect(new HubManagerGuard(moduleRefWith(whois)).canActivate(contextFor(request))).resolves.toBe(true);
    expect(whois.assertSessionMayManageHub).toHaveBeenCalledWith(request);
  });

  it("passes the service's refusal on", async () => {
    const refusal = new TranslatableError('HUB_MANAGE_ROLE_REQUIRED', {}, HttpStatus.FORBIDDEN);
    const whois = { assertSessionMayManageHub: vi.fn(async () => Promise.reject(refusal)) };

    await expect(new HubManagerGuard(moduleRefWith(whois)).canActivate(contextFor({}))).rejects.toBe(refusal);
  });

  it('refuses when the WhoIs service cannot be resolved', async () => {
    const attempt = new HubManagerGuard(moduleRefWith(null)).canActivate(contextFor({ hubPrincipal: 'session', user: { id: 7 } as never }));

    await expect(attempt).rejects.toMatchObject({ message: 'HUB_MANAGE_ROLE_REQUIRED', status: HttpStatus.FORBIDDEN });
  });
});

/** The guards a handler carries, its class's first. */
function guardsOn(controller: { prototype: object }, method: string): unknown[] {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  if (typeof handler !== 'function') {
    throw new Error(`${method} is not a handler`);
  }
  return [...(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])];
}

/*
 * Every route that changes what applies to the whole Hub, or reads the Hub's own log. A member is
 * view-only across the Hub, so each one takes an owner or admin (`HubManagerGuard`).
 */
const HUB_WIDE_ROUTES: Array<[string, { prototype: object }, string[]]> = [
  ['PATCH /user-settings, PATCH /acknowledge-welcome', AppController, ['updateUserSettings', 'acknowledgeWelcome']],
  [
    'inference preferences, cloud providers, models, hardware, ROCm and Ollama',
    InferenceController,
    [
      'updatePreferences',
      'rescanHardware',
      'updateRocmInstallState',
      'startPullModel',
      'pullModel',
      'loadModel',
      'unloadModel',
      'pinModel',
      'unpinModel',
      'setCloudProvider',
      'removeCloudProvider',
      'installOllama',
    ],
  ],
  [
    'Hub Pool settings, pins, pairing and peers',
    HubPoolController,
    [
      'updatePoolSettings',
      'upsertPoolPin',
      'deletePoolPin',
      'probePeerAddress',
      'pairPeer',
      'mintPairingPin',
      'cancelPairingPin',
      'upgradePeer',
      'rotateIdentity',
      'approvePeer',
      'rejectPeer',
      'enablePeer',
      'disablePeer',
      'removePeer',
    ],
  ],
  ['app stores', MarketplaceController, ['pullAppStores', 'createAppStore', 'updateAppStore', 'deleteAppStore']],
  ['Docker network repair', NetworkController, ['repairOrphans']],
  ['Tailscale', TailscaleController, ['syncExposure', 'startAuth', 'connectWithAuthKey', 'disconnect']],
  ['registration reset and tunnel reconnect', RegistrationController, ['resetRegistration', 'reconnectTunnel']],
  ['Hub update and auto-updates', SystemUpdateController, ['performUpdate', 'setAutoUpdates']],
  ['factory reset', FactoryResetController, ['factoryReset']],
  ['API keys', ApiKeyAdminController, ['createKey', 'updateKey', 'revokeKey']],
  ['the MCP tool runner', McpAdminController, ['callTool']],
  ["the Hub's own log", SystemController, ['downloadHubLogs']],
  ["the Hub's own log stream", SSEController, ['hubLogsEvents']],
];

describe('routes that take an owner or admin', () => {
  describe.each(HUB_WIDE_ROUTES)('%s', (_label, controller, methods) => {
    it.each(methods)('%s carries HubManagerGuard', (method) => {
      expect(guardsOn(controller, method)).toContain(HubManagerGuard);
    });
  });

  /* What a member still uses: reading the Hub, and their own account. */
  it.each([
    [AppController, 'appContext'],
    [AppController, 'hubAccess'],
    [AppController, 'updateAdvancedMode'],
    [AppController, 'completeOnboarding'],
    [InferenceController, 'getPreferences'],
    [InferenceController, 'getCloudProviders'],
    [SSEController, 'appEvents'],
    [SSEController, 'appLogsEvents'],
    [SystemUpdateController, 'checkForUpdates'],
    [ApiKeyAdminController, 'listKeys'],
  ] as const)('%O.%s stays open to anyone signed in', (controller, method) => {
    expect(guardsOn(controller, method)).not.toContain(HubManagerGuard);
  });

  /*
   * The removal check only reports the check-in that the unauthenticated GET /registration/status
   * already sends. A role check there would fail once the Portal deletes the device, which is what
   * the check watches for.
   */
  it('keeps the removal check to a signed-in person, without the role check', () => {
    const guards = guardsOn(RegistrationController, 'checkForRemoval');

    expect(guards).toEqual(expect.arrayContaining([AuthGuard, HubSessionGuard]));
    expect(guards).not.toContain(HubManagerGuard);
  });
});
