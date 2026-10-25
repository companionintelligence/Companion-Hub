import type { RehydrateStatusDto } from '@/api-client/types.gen';
import type { RegistrationDriftChoice } from '@/lib/registration-state-drift';
import type { TFunction } from 'i18next';

export type RestoreStatus = RehydrateStatusDto;
export type RestoreSummary = NonNullable<RehydrateStatusDto['summary']>;
export type RestoreFailure = RestoreSummary['notRestored'][number];

/** App statuses with an operation under way, so a summary showing them is read again shortly. */
const SETTLING_STATUSES = new Set(['installing', 'starting', 'restarting', 'updating', 'restoring', 'resetting']);

/**
 * Whether a sign-in opens the restore page before anything else.
 *
 * ⚠ THE HUB DECIDES, NOT THIS BROWSER. The Hub restores a device's apps right after pairing, with
 * nobody signed in. The page used to open only in the browser that had stored the "Restore existing
 * device" choice, so a sign-in from any other browser, the CLI, the desktop app or after a restart got
 * the setup wizard on a Hub that already had its apps. `noticePending` is the Hub's own record that a
 * restore ran and nobody who manages the Hub has seen it yet. The stored choice still counts for the
 * tab that made it while that restore has not finished.
 */
export function opensRestorePage(status: RestoreStatus | null, driftChoice: RegistrationDriftChoice | null, seenInThisTab = false): boolean {
  if (!status) {
    return false;
  }
  if (status.noticePending && !seenInThisTab) {
    return true;
  }
  return driftChoice === 'restore' && !status.completed;
}

const RESTORE_SEEN_KEY = 'ci-hub-restore-notice-seen';
/** What a tab keeps for a restore it left while it was still under way, with no summary yet. */
const SEEN_UNDER_WAY = 'under-way';

const seenMarker = (summary: RestoreSummary | null | undefined) => summary?.completedAt || SEEN_UNDER_WAY;

/**
 * Remembers in this tab that its person has seen this restore, for when the Hub could not record it.
 * The notice would otherwise send every page of this tab back to the restore page.
 *
 * ⚠ IT NAMES THE RESTORE THAT WAS SEEN. A plain "seen" outlived it: a tab (the desktop app's window
 * above all) that paired again later skipped the next restore's notice too, and its person got the
 * setup wizard on a Hub that had its apps back.
 */
export function rememberRestoreSeen(summary: RestoreSummary | null | undefined): void {
  try {
    sessionStorage.setItem(RESTORE_SEEN_KEY, seenMarker(summary));
  } catch {
    // Without storage the Hub's own record is all there is.
  }
}

/** Whether this tab's person has seen the restore `status` describes. Its summary, once it has one, is new to them. */
export function restoreSeenInThisTab(status: RestoreStatus | null): boolean {
  try {
    const seen = sessionStorage.getItem(RESTORE_SEEN_KEY);
    return seen !== null && seen === seenMarker(status?.summary);
  } catch {
    return false;
  }
}

/**
 * Where a sign-in that has not finished setup goes. While a pairing's apps check has not yet decided
 * whether the Hub restores apps, the setup wizard would offer to install apps that are about to come
 * back on their own, so the restore page waits for the answer first.
 */
export function setupRoute(status: RestoreStatus | null): '/restore-apps' | '/onboarding' {
  return status?.checking ? '/restore-apps' : '/onboarding';
}

/** An app status with an operation still under way. */
export function isSettlingStatus(status: string): boolean {
  return SETTLING_STATUSES.has(status);
}

/** The summary still has apps on their way up, so it is worth reading again. */
export function summaryIsSettling(summary: RestoreSummary | null | undefined): boolean {
  return Boolean(summary?.restored.some((app) => isSettlingStatus(app.status)));
}

/** A queued install that failed afterwards, or whose row never appeared, did not bring the app back. */
const FAILED_INSTALL_STATUSES = new Set(['install_failed', 'missing']);

/**
 * The summary as the page shows it. The Hub lists every app whose install it queued under `restored`,
 * with the status the app has now. An install that failed after it was queued (an image that could not
 * be pulled, say) has not brought the app back, so it is listed with the apps that were not restored.
 */
export function splitRestoreSummary(summary: RestoreSummary): { restored: RestoreSummary['restored']; notRestored: RestoreFailure[] } {
  const failedInstalls = summary.restored.filter((app) => FAILED_INSTALL_STATUSES.has(app.status));
  return {
    restored: summary.restored.filter((app) => !FAILED_INSTALL_STATUSES.has(app.status)),
    notRestored: [
      ...summary.notRestored,
      ...failedInstalls.map((app) => ({ name: app.name, urn: app.urn, reason: 'RESTORE_APPS_REASON_INSTALL_FAILED', code: 'failed' as const })),
    ],
  };
}

/**
 * Why an app was not restored, in words. The Hub records the message key an install was refused with
 * and its values, because the key alone (`APP_INSTALL_FORM_ERROR_INVALID`) told nobody anything.
 */
export function describeRestoreFailure(
  t: TFunction,
  exists: (key: string) => boolean,
  failure: Pick<RestoreFailure, 'reason' | 'code' | 'params'>,
): string {
  if (failure.reason === 'APP_INSTALL_FORM_ERROR_INVALID') {
    const fields = failure.params?.fields?.trim();
    return fields ? t('RESTORE_APPS_REASON_SETTINGS_REQUIRED', { fields }) : t('RESTORE_APPS_REASON_SETTINGS_REQUIRED_UNNAMED');
  }
  if (failure.reason === 'APP_ACTION_GRANT_DENIED' || failure.code === 'refused') {
    return t('APP_ACTION_GRANT_DENIED', { action: 'install' });
  }
  if (failure.code === 'unlisted') {
    return t('RESTORE_APPS_REASON_UNLISTED');
  }
  // An exposed port the restore tried to put back: the expose form's own refusal says what is wrong but not what to do next.
  if (failure.reason === 'PORT_EXPOSE_PORT_UNREACHABLE' && failure.params?.port) {
    return t('RESTORE_APPS_REASON_PORT_UNREACHABLE', { port: failure.params.port });
  }
  if (exists(failure.reason)) {
    return t(failure.reason, failure.params ?? {});
  }
  return failure.reason;
}

/** The store apps made on this Hub live in ("Expose a port", "Create a custom app"). No App Store page lists them. */
const USER_APPS_STORE = '_user';

/** The App Store page an app that was not restored can be installed from, when the Hub knows which listing it is. */
export function storePathFor(urn: string | undefined): string | null {
  const separator = urn?.indexOf(':') ?? -1;
  if (!urn || separator <= 0 || separator === urn.length - 1 || urn.slice(separator + 1) === USER_APPS_STORE) {
    return null;
  }
  return `/store/${encodeURIComponent(urn.slice(separator + 1))}/${encodeURIComponent(urn.slice(0, separator))}`;
}
