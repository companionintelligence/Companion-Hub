import { type AppFailurePhase, ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import type { ModuleRef } from '@nestjs/core';
import {
  type AppCommandFailureResult,
  AppLifecycleError,
  translateDockerNetworkOverlapError,
  translateKvmInstallMessage,
  translateRocmKfdInstallMessage,
} from './app-lifecycle-errors';

/**
 * Turns a thrown lifecycle error into the structured failure result the queue replies with,
 * translating the known host-capability failures (ROCm /dev/kfd, KVM, Docker subnet overlap) into
 * actionable messages and reporting the rest to Sentry.
 */
export async function reportAndTranslateAppError(moduleRef: ModuleRef, err: unknown, appId: string, event: string): Promise<AppCommandFailureResult> {
  if (err instanceof AppLifecycleError) {
    reportCommandFailure(moduleRef, appId, event, err.errorDetail ?? err.message, err.errorCode);
    return {
      success: false,
      message: err.message,
      errorCode: err.errorCode,
      errorDetail: err.errorDetail,
      settingsPath: err.settingsPath,
    };
  }

  if (err instanceof Error) {
    const overlapTranslated = translateDockerNetworkOverlapError(err);
    if (overlapTranslated) {
      reportCommandFailure(moduleRef, appId, event, overlapTranslated.errorDetail ?? overlapTranslated.message, overlapTranslated.errorCode);
      return {
        success: false,
        message: overlapTranslated.message,
        errorCode: overlapTranslated.errorCode,
        errorDetail: overlapTranslated.errorDetail,
      };
    }

    const translated = translateRocmKfdInstallMessage(err.message) ?? translateKvmInstallMessage(err.message);
    if (translated) {
      reportCommandFailure(moduleRef, appId, event, translated.errorDetail ?? translated.message, translated.errorCode);
      return {
        success: false,
        message: translated.message,
        errorCode: translated.errorCode,
        errorDetail: translated.errorDetail,
        settingsPath: translated.settingsPath,
      };
    }

    reportCommandFailure(moduleRef, appId, event, err.message);
    return { success: false, message: err.message };
  }

  const message = `An error occurred: ${String(err)}`;
  reportCommandFailure(moduleRef, appId, event, message);
  return { success: false, message };
}

/**
 * Reports to Sentry synchronously, inside the queue worker, before the result round-trips back
 * to AppLifecycleService's settleCommandOutcome (which also reports, with errorCode, once the
 * RPC reply arrives). ErrorReportingService debounces per `${phase}:${appUrn}` for 30s, so
 * whichever call lands first is what Sentry actually receives — this one, here, usually wins the
 * race since it runs before the round-trip. errorCode must therefore be threaded through HERE
 * too, not only on the settleCommandOutcome side, or a classified failure can still surface in
 * Sentry as unclassified depending on timing.
 */
function reportCommandFailure(moduleRef: ModuleRef, appId: string, event: string, message: string, errorCode?: string): void {
  const errorReportingService = moduleRef.get(ErrorReportingService, { strict: false });
  const phase = mapEventToFailurePhase(event);
  if (!phase) {
    return;
  }

  errorReportingService?.reportAppFailure({
    appUrn: appId,
    phase,
    message,
    errorCode,
  });
}

function mapEventToFailurePhase(event: string): AppFailurePhase | null {
  switch (event) {
    case 'install':
      return 'install';
    case 'start':
      return 'start';
    case 'stop':
      return 'stop';
    case 'restart':
      return 'restart';
    case 'uninstall':
      return 'uninstall';
    case 'reset':
      return 'reset';
    case 'backup':
      return 'backup';
    case 'restore':
      return 'restore';
    case 'update_error':
    case 'generate_env_error':
      return 'update';
    default:
      return null;
  }
}
