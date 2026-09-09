import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { CloudflareModule } from '../../cloudflare/cloudflare.module';
import { TunnelHealthService } from '../../cloudflare/tunnel-health.service';
import { RegistrationModule } from '../registration.module';

/**
 * Guards the one failure mode the check-in's tunnel-health field has no runtime error for.
 *
 * `RegistrationService` injects `TunnelHealthService` with `@Optional()`, which is deliberate —
 * a Hub whose Cloudflare module never came up must still check in. The cost of that choice is
 * that breaking the wiring is silent: Nest injects `undefined`, `buildCheckInPayload` omits the
 * field because omission is what "no reading" means, and Portal's fleet report quietly loses
 * tunnel health forever with nothing in the logs. Asserting the module graph is how that stays
 * visible, so dropping the export or the import fails here instead of in production.
 */
describe('check-in tunnel-health wiring', () => {
  /** Unwraps Nest's `forwardRef()` wrapper so both import styles compare equal. */
  const resolveModuleRef = (entry: unknown): unknown =>
    typeof entry === 'object' && entry !== null && 'forwardRef' in entry ? (entry as { forwardRef: () => unknown }).forwardRef() : entry;

  it('exports TunnelHealthService from CloudflareModule', () => {
    const exports = (Reflect.getMetadata('exports', CloudflareModule) ?? []) as unknown[];

    expect(exports).toContain(TunnelHealthService);
  });

  it('imports CloudflareModule into RegistrationModule, so the optional injection actually resolves', () => {
    const imports = ((Reflect.getMetadata('imports', RegistrationModule) ?? []) as unknown[]).map(resolveModuleRef);

    expect(imports).toContain(CloudflareModule);
  });
});
