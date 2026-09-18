/**
 * Who may read the pool's observability routes, and — the part that matters more — who may not.
 *
 * Two holes this closes, both measured on the fleet on 2026-09-17:
 * - core-2 is registered but unclaimed, and its only on-node credential is a CLI JWT. Every route
 *   answered that JWT 409, so which node served a pooled request could not be measured there at all.
 * - Fleet QA read the routing log with the Portal device key: grant-exempt operator authority that can
 *   also pair peers and uninstall apps, held by Portal as well as the host. A test needs a GET.
 *
 * Every admission below is paired with the refusal next to it, because the failure this file exists
 * to prevent is the admission quietly getting wider.
 */
import { HttpStatus, RequestMethod } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslatableError } from '@/common/error/translatable-error';
import { HubPoolController } from '@/modules/hub-pool/hub-pool.controller';
import { AppsController } from '@/modules/apps/apps.controller';
import { OBSERVABILITY_READ_METADATA, ObservabilityRead, ObservabilityReadGuard, type ObservabilityReadOptions } from '../observability-read.guard';

class Routes {
  @ObservabilityRead({ unclaimedCli: true })
  poolStatus() {}

  @ObservabilityRead()
  appStatus() {}

  pins() {}
}

const contextFor = (handler: () => void, request: Partial<Request>) =>
  ({
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ method: 'GET', url: '/api/inference/pool/status', body: {}, ...request }) }),
  }) as unknown as ExecutionContext;

const refusalOf = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((err) => err)) as TranslatableError;
  const response = error.getResponse() as { message?: string };
  return { status: error.getStatus(), key: response.message };
};

describe('ObservabilityReadGuard', () => {
  let guard: ObservabilityReadGuard;

  beforeEach(() => {
    guard = new ObservabilityReadGuard({ debug: vi.fn() } as never, new Reflector());
  });

  describe('a qa:read key', () => {
    it.each(['GET', 'HEAD'])('reads a marked route over %s', async (method) => {
      await expect(guard.canActivate(contextFor(Routes.prototype.appStatus, { hubPrincipal: 'qa-read', method }))).resolves.toBe(true);
    });

    it('is refused a write, even on a marked route', async () => {
      const refusal = await refusalOf(guard.canActivate(contextFor(Routes.prototype.poolStatus, { hubPrincipal: 'qa-read', method: 'POST' })));

      expect(refusal).toEqual({ status: HttpStatus.FORBIDDEN, key: 'AUTH_ERROR_QA_READ_KEY_ROUTE_NOT_ALLOWED' });
    });

    it('is refused with 403, not 401, on a route nobody marked', async () => {
      const refusal = await refusalOf(guard.canActivate(contextFor(Routes.prototype.pins, { hubPrincipal: 'qa-read' })));

      expect(refusal).toEqual({ status: HttpStatus.FORBIDDEN, key: 'AUTH_ERROR_QA_READ_KEY_ROUTE_NOT_ALLOWED' });
    });
  });

  describe('the CLI JWT on an unclaimed Hub', () => {
    const unclaimedCli: Partial<Request> = { hubPrincipal: 'cli', hubUnclaimed: true };

    it('reads a route that opted in', async () => {
      await expect(guard.canActivate(contextFor(Routes.prototype.poolStatus, unclaimedCli))).resolves.toBe(true);
    });

    it('still gets 409 on a marked route that did not opt in', async () => {
      const refusal = await refusalOf(guard.canActivate(contextFor(Routes.prototype.appStatus, unclaimedCli)));

      expect(refusal).toEqual({ status: HttpStatus.CONFLICT, key: 'AUTH_ERROR_HUB_NOT_CLAIMED' });
    });

    it('still gets 409 on a write to a route that opted in', async () => {
      const refusal = await refusalOf(guard.canActivate(contextFor(Routes.prototype.poolStatus, { ...unclaimedCli, method: 'POST' })));

      expect(refusal.status).toBe(HttpStatus.CONFLICT);
    });

    /** Portal holds the device key too. On a Hub nobody has claimed, a cloud-held credential reads nothing. */
    it('does not extend to the Portal device key', async () => {
      const refusal = await refusalOf(
        guard.canActivate(contextFor(Routes.prototype.poolStatus, { hubPrincipal: 'portal-device', hubUnclaimed: true })),
      );

      expect(refusal).toEqual({ status: HttpStatus.CONFLICT, key: 'AUTH_ERROR_HUB_NOT_CLAIMED' });
    });
  });

  describe('everything AuthGuard already decided', () => {
    it('admits an operator on marked and unmarked routes alike', async () => {
      const operator = { user: { id: 1 } as never, hubPrincipal: 'session' as const };

      await expect(guard.canActivate(contextFor(Routes.prototype.poolStatus, operator))).resolves.toBe(true);
      await expect(guard.canActivate(contextFor(Routes.prototype.pins, { ...operator, method: 'POST' }))).resolves.toBe(true);
    });

    it('admits the CLI JWT on a claimed Hub exactly as before — it has a user there', async () => {
      await expect(guard.canActivate(contextFor(Routes.prototype.pins, { user: { id: 1 } as never, hubPrincipal: 'cli' }))).resolves.toBe(true);
    });

    it('answers an anonymous caller 401 on a marked route', async () => {
      const refusal = await refusalOf(guard.canActivate(contextFor(Routes.prototype.poolStatus, {})));

      expect(refusal).toEqual({ status: HttpStatus.UNAUTHORIZED, key: 'SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN' });
    });
  });

  /**
   * The allow-list is the set of handlers carrying the marker, so the set is pinned here. Adding a
   * handler to it — or letting a non-GET one in — has to change this test, which is the review point.
   * `inference-env` (O6) and lifecycle `jobs` (O5) are named in the fleet QA plan but do not exist on
   * this branch; whoever adds them adds them here.
   */
  it('is carried by exactly the reads a test needs, every one of them a GET', () => {
    const reflector = new Reflector();
    const marked: Record<string, ObservabilityReadOptions> = {};
    for (const controller of [HubPoolController, AppsController]) {
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as unknown as Record<string, () => void>)[name] as () => void;
        const options = typeof handler === 'function' ? reflector.get<ObservabilityReadOptions>(OBSERVABILITY_READ_METADATA, handler) : undefined;
        if (options) {
          expect(Reflect.getMetadata(METHOD_METADATA, handler), `${controller.name}.${name}`).toBe(RequestMethod.GET);
          marked[`${controller.name}.${name}`] = options;
        }
      }
    }

    expect(marked).toEqual({
      'HubPoolController.poolStatus': { unclaimedCli: true },
      'HubPoolController.getPoolRoutingLog': { unclaimedCli: true },
      'AppsController.getApp': {},
      'AppsController.getInstallQueue': {},
    });
  });
});
