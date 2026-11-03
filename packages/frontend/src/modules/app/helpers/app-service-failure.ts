import type { AppServiceFailure } from '@ci-hub/common/schemas';
import type { TFunction } from 'i18next';

/** "summary-service keeps restarting (exit 126): <last log line>", in the person's language. */
export function appServiceFailureText(t: TFunction, failure: AppServiceFailure): string {
  if (failure.kind === 'none_running' || !failure.service) {
    return t('APP_ERROR_SERVICE_NONE_RUNNING');
  }

  const service = failure.others ? t('APP_ERROR_SERVICE_AND_MORE', { service: failure.service, others: failure.others }) : failure.service;
  const hasCode = failure.exitCode !== undefined;
  const reason =
    failure.kind === 'restarting'
      ? t(hasCode ? 'APP_ERROR_SERVICE_KEEPS_RESTARTING_CODE' : 'APP_ERROR_SERVICE_KEEPS_RESTARTING', { service, exitCode: failure.exitCode })
      : t(hasCode ? 'APP_ERROR_SERVICE_EXITED_CODE' : 'APP_ERROR_SERVICE_EXITED', { service, exitCode: failure.exitCode });

  return failure.logLine ? t('APP_ERROR_SERVICE_WITH_LOG_LINE', { reason, logLine: failure.logLine }) : reason;
}
