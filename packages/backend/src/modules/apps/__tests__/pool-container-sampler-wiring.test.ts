import { describe, expect, it } from 'vitest';
import { POOL_CONTAINER_SAMPLER } from '@/common/helpers/hub-pool';
import { AppRuntimeMonitorService } from '../app-runtime-monitor.service';
import { AppsModule } from '../apps.module';

/**
 * The Hub pool reaches this sampler through `ModuleRef.get(POOL_CONTAINER_SAMPLER, { strict: false })`
 * rather than through a Nest import, so nothing about that lookup is checked by the type system: if
 * this provider is ever dropped, the pool resolves nothing, omits the key on every capabilities
 * response, and looks exactly like a fleet whose operators all opted out. That failure is silent and
 * permanent, which is why it gets a test of its own.
 */
describe('POOL_CONTAINER_SAMPLER wiring', () => {
  const providers = (Reflect.getMetadata('providers', AppsModule) ?? []) as unknown[];
  const exports_ = (Reflect.getMetadata('exports', AppsModule) ?? []) as unknown[];

  it('is provided by AppsModule, bound to the runtime monitor that holds the sample', () => {
    expect(providers).toContainEqual({ provide: POOL_CONTAINER_SAMPLER, useExisting: AppRuntimeMonitorService });
  });

  it('is exported, so the binding is reachable from outside AppsModule', () => {
    expect(exports_).toContain(POOL_CONTAINER_SAMPLER);
  });

  it('is satisfied by the monitor actually implementing the accessor', () => {
    // `useExisting` is not type-checked against the interface, so this is the other half of the
    // contract: the class Nest hands the pool has to have the method the pool calls.
    expect(typeof AppRuntimeMonitorService.prototype.containerRollup).toBe('function');
  });
});
