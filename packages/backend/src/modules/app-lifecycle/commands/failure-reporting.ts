import { type AppFailurePhase, ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import { LoggerService } from '@/core/logger/logger.service';
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
  const phase = mapEventToFailurePhase(event);
  if (!phase) {
    return;
  }

  try {
    // Resolution is inside the try, not above it. ModuleRef.get throws UnknownElementException for
    // an unregistered token — `strict: false` widens the search, it does not make the lookup
    // optional and it never yields undefined. Resolving outside would leave the more likely half of
    // this hazard open: a worker context that never wired in the core error-reporting module would
    // throw here and destroy the classified result exactly as a transport failure used to.
    const errorReportingService = moduleRef.get(ErrorReportingService, { strict: false });
    errorReportingService?.reportAppFailure({
      appUrn: appId,
      phase,
      message,
      errorCode,
    });
  } catch (reportErr) {
    // Telemetry must never change control flow here. The classified AppCommandFailureResult the
    // caller is about to return is the queue's only channel for reporting the real failure, so
    // letting a reporting-transport exception escape would replace an actionable, translated
    // failure with a raw Sentry error and strand the caller. Losing the report is the cheaper loss.
    warnDroppedFailureReport(moduleRef, appId, phase, reportErr);
  }
}

/**
 * Best-effort note that a failure report was dropped. The logger is optional for the same reason
 * ErrorReportingService is (worker contexts that never wired in the core module), and resolving it
 * must not throw either — an exception from this path would leak straight back out of the swallow
 * above and re-create the hazard it exists to contain.
 */
function warnDroppedFailureReport(moduleRef: ModuleRef, appId: string, phase: AppFailurePhase, reportErr: unknown): void {
  try {
    const logger = moduleRef.get(LoggerService, { strict: false });
    logger?.warn(`Failed to report ${phase} failure for ${appId} to error reporting: ${reportErr}`);
  } catch {
    // No logger to complain to; the real failure still travels back in the returned result.
  }
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
