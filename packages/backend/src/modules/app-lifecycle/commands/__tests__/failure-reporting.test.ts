import { type AppFailureContext, ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import {
  AppLifecycleError,
  KVM_MISSING_CODE,
  KVM_MISSING_DETAIL,
  KVM_MISSING_USER_MESSAGE,
  NETWORK_OVERLAP_CODE,
  NETWORK_OVERLAP_USER_MESSAGE,
  ROCM_KFD_MISSING_CODE,
  ROCM_KFD_MISSING_DETAIL,
  ROCM_KFD_MISSING_SETTINGS_PATH,
  ROCM_KFD_MISSING_USER_MESSAGE,
} from '../app-lifecycle-errors';
import { reportAndTranslateAppError } from '../failure-reporting';

type ModuleRefLookup = { token: unknown; options: unknown };

type Harness = {
  moduleRef: ModuleRef;
  /** Every context handed to ErrorReportingService.reportAppFailure, in call order. */
  reported: AppFailureContext[];
  /** Every message passed to LoggerService.warn, in call order. */
  warnings: string[];
  lookups: ModuleRefLookup[];
};

/**
 * Records what the reporting side effect actually received.
 *
 * `serviceAvailable: false` models a worker context that never wired in the core error-reporting
 * module. Nest's `ModuleRef.get` THROWS `UnknownElementException` for an unregistered token — see
 * @nestjs/core/injector/instance-links-host.js — so this option makes the lookup throw rather than
 * resolve to undefined. An earlier version of this harness returned undefined, which no Nest
 * container can actually produce, and so asserted tolerance for a state that never occurs while the
 * real unregistered case went uncovered.
 *
 * `reporterThrows` models a reporting transport that blows up mid-call. `loggerUnavailable` models
 * the same unregistered-token throw for the fallback logger, so the warning path cannot itself
 * become the escape hatch.
 */
function createHarness(options: { serviceAvailable?: boolean; reporterThrows?: Error; loggerUnavailable?: boolean } = {}): Harness {
  const reported: AppFailureContext[] = [];
  const warnings: string[] = [];
  const lookups: ModuleRefLookup[] = [];
  const service = {
    reportAppFailure: (context: AppFailureContext): void => {
      if (options.reporterThrows) {
        throw options.reporterThrows;
      }
      reported.push(context);
    },
  };

  const logger = {
    warn: (...message: unknown[]): void => {
      warnings.push(message.map(String).join(' '));
    },
  };

  const moduleRef = {
    get: (token: unknown, getOptions?: unknown): unknown => {
      lookups.push({ token, options: getOptions });
      if (token === LoggerService) {
        if (options.loggerUnavailable) {
          throw new Error('Nest could not find LoggerService element');
        }
        return logger;
      }
      if (options.serviceAvailable === false) {
        throw new Error('Nest could not find ErrorReportingService element');
      }
      return service;
    },
  } as unknown as ModuleRef;

  return { moduleRef, reported, warnings, lookups };
}

const DOCKER_OVERLAP_MESSAGE = 'Error response from daemon: invalid pool request: Pool overlaps with other one on this address space 10.128.10.0/24';

const ROCM_DEVICE_MESSAGE =
  'Error response from daemon: error gathering device information while adding custom device "/dev/dri": no such file or directory';

const KVM_DEVICE_MESSAGE =
  'Error response from daemon: error gathering device information while adding custom device "/dev/kvm": no such file or directory';

describe('reportAndTranslateAppError — result translation', () => {
  it('passes an AppLifecycleError message, code, detail and settings path straight through', async () => {
    const { moduleRef } = createHarness();
    // Every value here is deliberately unlike the ROCm/KVM/overlap constants: a branch that
    // answered with a canned translator payload instead of reading the thrown error would have
    // to invent these four strings to pass.
    const err = new AppLifecycleError('custom ui text', {
      code: 'custom_code',
      detail: 'custom detail for support',
      settingsPath: '/settings?tab=custom',
    });

    const result = await reportAndTranslateAppError(moduleRef, err, 'urn:store:custom', 'install');

    expect(result).toEqual({
      success: false,
      message: 'custom ui text',
      errorCode: 'custom_code',
      errorDetail: 'custom detail for support',
      settingsPath: '/settings?tab=custom',
    });
  });

  it('keeps an AppLifecycleError verbatim even when its message would match a translator', async () => {
    const { moduleRef } = createHarness();
    // Already-classified errors are re-raised by inner layers; re-running them through the
    // string translators would overwrite a precise code with the generic ROCm one.
    const err = new AppLifecycleError(ROCM_DEVICE_MESSAGE, { code: 'preflight_rocm_probe_failed', detail: 'probe stderr' });

    const result = await reportAndTranslateAppError(moduleRef, err, 'urn:store:comfyui', 'install');

    expect(result).toEqual({
      success: false,
      message: ROCM_DEVICE_MESSAGE,
      errorCode: 'preflight_rocm_probe_failed',
      errorDetail: 'probe stderr',
      settingsPath: undefined,
    });
  });

  it('translates a Docker subnet overlap error into the retry guidance instead of the daemon text', async () => {
    const { moduleRef } = createHarness();

    const result = await reportAndTranslateAppError(moduleRef, new Error(DOCKER_OVERLAP_MESSAGE), 'urn:store:immich', 'start');

    expect(result.message).toBe(NETWORK_OVERLAP_USER_MESSAGE);
    expect(result.errorCode).toBe(NETWORK_OVERLAP_CODE);
    // The CIDR is recovered from the daemon text so support can see which range collided.
    expect(result.errorDetail).toContain('10.128.10.0/24');
    // The overlap branch has nothing for the user to configure; only ROCm offers a settings deep link.
    expect(result.settingsPath).toBeUndefined();
  });

  it('translates a missing ROCm passthrough device error, including the settings deep link', async () => {
    const { moduleRef } = createHarness();

    const result = await reportAndTranslateAppError(moduleRef, new Error(ROCM_DEVICE_MESSAGE), 'urn:store:comfyui', 'install');

    expect(result).toEqual({
      success: false,
      message: ROCM_KFD_MISSING_USER_MESSAGE,
      errorCode: ROCM_KFD_MISSING_CODE,
      errorDetail: ROCM_KFD_MISSING_DETAIL,
      settingsPath: ROCM_KFD_MISSING_SETTINGS_PATH,
    });
  });

  it('translates a missing /dev/kvm device error', async () => {
    const { moduleRef } = createHarness();

    const result = await reportAndTranslateAppError(moduleRef, new Error(KVM_DEVICE_MESSAGE), 'urn:store:windows', 'install');

    expect(result).toEqual({
      success: false,
      message: KVM_MISSING_USER_MESSAGE,
      errorCode: KVM_MISSING_CODE,
      errorDetail: KVM_MISSING_DETAIL,
      settingsPath: undefined,
    });
  });

  it('prefers the ROCm translation when a message names both device families', async () => {
    const { moduleRef } = createHarness();
    // `translateRocmKfdInstallMessage(...) ?? translateKvmInstallMessage(...)` — the order is
    // load-bearing, so a compose that passes through both GPU and KVM devices must not be
    // reported as a virtualization problem when ROCm is what is actually missing.
    const bothDevices = 'error gathering device information while adding custom device "/dev/kfd" (also needs /dev/kvm): no such file or directory';

    const result = await reportAndTranslateAppError(moduleRef, new Error(bothDevices), 'urn:store:hunyuan3d', 'install');

    expect(result.errorCode).toBe(ROCM_KFD_MISSING_CODE);
  });

  it('falls through to the raw message for an unrecognized Error', async () => {
    const { moduleRef } = createHarness();

    const result = await reportAndTranslateAppError(moduleRef, new Error('compose exited with code 1'), 'urn:store:immich', 'start');

    expect(result).toEqual({ success: false, message: 'compose exited with code 1' });
    // No classification exists, so nothing may be invented for the frontend to key i18n off.
    expect(result.errorCode).toBeUndefined();
    expect(result.errorDetail).toBeUndefined();
  });

  it('wraps a non-Error throwable in the generic message', async () => {
    const { moduleRef } = createHarness();

    const fromString = await reportAndTranslateAppError(moduleRef, 'docker socket vanished', 'urn:store:immich', 'stop');
    const fromObject = await reportAndTranslateAppError(moduleRef, { code: 137 }, 'urn:store:immich', 'stop');

    expect(fromString).toEqual({ success: false, message: 'An error occurred: docker socket vanished' });
    expect(fromObject).toEqual({ success: false, message: 'An error occurred: [object Object]' });
  });
});

describe('reportAndTranslateAppError — error reporting side effect', () => {
  it('resolves ErrorReportingService non-strictly so a worker-scoped module can still find it', async () => {
    const { moduleRef, lookups } = createHarness();

    await reportAndTranslateAppError(moduleRef, new Error('boom'), 'urn:store:immich', 'start');

    expect(lookups).toEqual([{ token: ErrorReportingService, options: { strict: false } }]);
  });

  it('threads the structured errorCode into the report, not just into the returned result', async () => {
    const { moduleRef, reported } = createHarness();

    await reportAndTranslateAppError(moduleRef, new Error(ROCM_DEVICE_MESSAGE), 'urn:store:comfyui', 'install');

    // Sentry classification keys off errorCode; dropping it here surfaces the failure as
    // unclassified whenever this call wins the 30s debounce race against settleCommandOutcome.
    expect(reported).toEqual([
      {
        appUrn: 'urn:store:comfyui',
        phase: 'install',
        message: ROCM_KFD_MISSING_DETAIL,
        errorCode: ROCM_KFD_MISSING_CODE,
      },
    ]);
  });

  it('reports the subnet overlap with its CIDR detail and classification code', async () => {
    const { moduleRef, reported } = createHarness();

    const result = await reportAndTranslateAppError(moduleRef, new Error(DOCKER_OVERLAP_MESSAGE), 'urn:store:immich', 'start');

    expect(reported).toEqual([
      {
        appUrn: 'urn:store:immich',
        phase: 'start',
        // The support-facing detail, not NETWORK_OVERLAP_USER_MESSAGE: Sentry needs the range
        // that actually collided to tell a one-off recovery from a genuinely exhausted pool.
        message: result.errorDetail,
        errorCode: NETWORK_OVERLAP_CODE,
      },
    ]);
    expect(reported[0]?.message).toContain('10.128.10.0/24');
  });

  it('reports the long detail rather than the short user-facing message when a detail exists', async () => {
    const { moduleRef, reported } = createHarness();
    const err = new AppLifecycleError('short message for the UI', { code: 'custom_code', detail: 'long detail for support' });

    await reportAndTranslateAppError(moduleRef, err, 'urn:store:custom', 'restore');

    expect(reported[0]?.message).toBe('long detail for support');
    expect(reported[0]?.errorCode).toBe('custom_code');
  });

  it('reports the message when an AppLifecycleError carries no detail', async () => {
    const { moduleRef, reported } = createHarness();
    const err = new AppLifecycleError('nothing more to say');

    await reportAndTranslateAppError(moduleRef, err, 'urn:store:custom', 'backup');

    expect(reported[0]?.message).toBe('nothing more to say');
    expect(reported[0]?.errorCode).toBeUndefined();
  });

  it('reports the generic wrapper text for a non-Error throwable', async () => {
    const { moduleRef, reported } = createHarness();

    await reportAndTranslateAppError(moduleRef, 'docker socket vanished', 'urn:store:immich', 'stop');

    expect(reported[0]?.message).toBe('An error occurred: docker socket vanished');
  });

  it.each([
    ['install', 'install'],
    ['start', 'start'],
    ['stop', 'stop'],
    ['restart', 'restart'],
    ['uninstall', 'uninstall'],
    ['reset', 'reset'],
    ['backup', 'backup'],
    ['restore', 'restore'],
    ['update_error', 'update'],
    ['generate_env_error', 'update'],
  ])('maps the %s event to the %s failure phase', async (event, phase) => {
    const { moduleRef, reported } = createHarness();

    await reportAndTranslateAppError(moduleRef, new Error('boom'), 'urn:store:immich', event);

    expect(reported).toHaveLength(1);
    expect(reported[0]?.phase).toBe(phase);
  });

  it.each([
    // 'update' is deliberately absent from the map — only the *_error variants report, so a
    // successful-path event name must not manufacture an update failure in Sentry.
    'update',
    // Valid AppFailurePhase values that no lifecycle command emits as an event name.
    'post_start',
    'crash',
    '',
    'Install',
    'some_unknown_event',
  ])('does not report an unmapped %s event', async (event) => {
    const { moduleRef, reported } = createHarness();

    const result = await reportAndTranslateAppError(moduleRef, new Error(ROCM_DEVICE_MESSAGE), 'urn:store:comfyui', event);

    expect(reported).toEqual([]);
    // Suppressing the report must not suppress the translation the caller replies with.
    expect(result.errorCode).toBe(ROCM_KFD_MISSING_CODE);
  });

  it('swallows a throwing reporter, keeps the translated result intact, and logs a warning', async () => {
    const { moduleRef, warnings } = createHarness({ reporterThrows: new Error('sentry transport down') });

    // This used to assert the opposite — the throw escaping — to pin the unguarded call as a known
    // hazard. reportAppFailure is now wrapped: the classified result is the queue's only channel
    // for the real failure, so a broken telemetry transport must not destroy it. The dropped report
    // is downgraded to a warning, which is the whole trade being made.
    const result = await reportAndTranslateAppError(moduleRef, new Error(ROCM_DEVICE_MESSAGE), 'urn:store:comfyui', 'install');

    expect(result).toEqual({
      success: false,
      message: ROCM_KFD_MISSING_USER_MESSAGE,
      errorCode: ROCM_KFD_MISSING_CODE,
      errorDetail: ROCM_KFD_MISSING_DETAIL,
      settingsPath: ROCM_KFD_MISSING_SETTINGS_PATH,
    });
    expect(warnings).toHaveLength(1);
    // The warning has to carry the transport error and the app it was reporting on, or a silently
    // blinded Sentry pipeline looks identical to one that simply had nothing to report.
    expect(warnings[0]).toContain('sentry transport down');
    expect(warnings[0]).toContain('urn:store:comfyui');
  });

  it('still returns the translated result when the reporter throws and no logger is registered', async () => {
    const { moduleRef } = createHarness({ reporterThrows: new Error('sentry transport down'), loggerUnavailable: true });

    // The fallback warning must not reintroduce the hazard it exists to report: in a worker module
    // without the core logger, resolving LoggerService throws, and that exception has to stay
    // inside the swallow too.
    const result = await reportAndTranslateAppError(moduleRef, new Error(DOCKER_OVERLAP_MESSAGE), 'urn:store:immich', 'start');

    expect(result.errorCode).toBe(NETWORK_OVERLAP_CODE);
  });

  // Previously this asserted tolerance for `moduleRef.get` returning undefined, a state Nest cannot
  // produce; the unregistered case actually throws, and used to destroy the classified result.
  it('still returns a translated result when resolving ErrorReportingService throws', async () => {
    const { moduleRef } = createHarness({ serviceAvailable: false });

    const result = await reportAndTranslateAppError(moduleRef, new Error(DOCKER_OVERLAP_MESSAGE), 'urn:store:immich', 'start');

    expect(result.errorCode).toBe(NETWORK_OVERLAP_CODE);
  });
});
