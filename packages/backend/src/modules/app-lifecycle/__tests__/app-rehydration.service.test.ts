import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import type { AppUrn } from '@ci-hub/common/types';
import { AppLifecycleService } from '../app-lifecycle.service';
import { AppRehydrationService } from '../app-rehydration.service';
import type { RehydrationPlanItem } from '../app-rehydration';

/*
 * Rehydrate reinstalls every app the Portal lists for this device, and it used to
 * call `installApp` with no gate at all — the org-role check lived only in the
 * HTTP install route (CI-Hub#1397). It now installs AS the person who asked, so
 * an app they may not install is skipped and reported rather than installed.
 */
describe('AppRehydrationService — installs as the actor that asked', () => {
  const OPERATOR: LifecycleActor = { kind: 'operator', userId: 7 };
  const appUrn = 'immich:ci-marketplace' as AppUrn;
  const installItem = { action: 'install', appUrn, form: { port: 8080 }, portalApp: { name: 'Immich' } } as unknown as RehydrationPlanItem;

  let lifecycle: MockProxy<AppLifecycleService>;
  let service: AppRehydrationService;
  const runItem = (queued: string[], skipped: Array<{ name: string; reason: string }>) =>
    (service as any).executePlanItem(installItem, queued, [], skipped, OPERATOR) as Promise<void>;

  beforeEach(() => {
    lifecycle = mock<AppLifecycleService>();
    const deps = Array.from({ length: 10 }, () => mock<object>()) as unknown[];
    deps[8] = lifecycle;
    service = new (AppRehydrationService as unknown as new (...args: unknown[]) => AppRehydrationService)(...deps);
  });

  it('hands the lifecycle service the actor, so the service can gate the install', async () => {
    lifecycle.installApp.mockResolvedValue({ requestId: 'r' } as never);
    const queued: string[] = [];

    await runItem(queued, []);

    expect(lifecycle.installApp).toHaveBeenCalledWith({ appUrn, form: { port: 8080 }, actor: OPERATOR });
    expect(queued).toEqual([appUrn]);
  });

  it('skips and reports an app the actor may not install, and carries on', async () => {
    lifecycle.installApp.mockRejectedValue(new Error('APP_ACTION_GRANT_DENIED'));
    const queued: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    await runItem(queued, skipped);

    expect(queued).toEqual([]);
    expect(skipped).toEqual([{ name: 'Immich', reason: 'APP_ACTION_GRANT_DENIED' }]);
  });
});
