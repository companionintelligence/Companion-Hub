import { checkDnsAvailability as checkDnsAvailabilitySdk, getDiagnostics2, repair as repairPublicWebSdk } from '@/api-client/sdk.gen';
import type { CheckDnsAvailabilityResponse } from '@/api-client/types.gen';
import { sdkResult } from '@/lib/sdk-unwrap';

/**
 * Minimal Response shape for legacy DNS check callers.
 *
 * `json()` is typed from the API contract rather than `any`, so a form that keys
 * on a field the Hub does not send fails to compile instead of never firing. The
 * forms' `zone_unreachable` branch never fired while the Hub dropped Portal's
 * `reason`, and nothing flagged it.
 */
export type DnsAvailabilityResponse = Pick<Response, 'ok' | 'status'> & { json: () => Promise<CheckDnsAvailabilityResponse> };

function asResponse(result: { ok: boolean; status: number; data?: CheckDnsAvailabilityResponse }): DnsAvailabilityResponse {
  return {
    ok: result.ok,
    status: result.status,
    // Callers read the body only when `ok`, which is when the client parsed one.
    json: async () => result.data as CheckDnsAvailabilityResponse,
  };
}

export async function fetchDnsAvailability(subdomain: string, options?: { domain?: string; appUrn?: string }) {
  const result = await sdkResult(
    checkDnsAvailabilitySdk({
      query: {
        subdomain,
        domain: options?.domain ?? '',
        appUrn: options?.appUrn ?? '',
      },
    } as Parameters<typeof checkDnsAvailabilitySdk>[0]),
  );
  return asResponse(result);
}

export type PublicWebDiagnosticsApp = {
  appUrn: string;
  envMismatch: boolean;
  computedPublicUrl: string;
  /**
   * The app's display name, as the Hub's report carries it. A surface that names
   * the app should prefer the installed-apps list and fall back to this, so it
   * never has to print a URN while that list is still loading.
   */
  appName?: string;
  /** The app's lifecycle status, as the Hub's report saw it. */
  status?: string;
  /**
   * The backend's verdict. `envMismatch` alone is NOT one: a freshly bound custom
   * domain deliberately leaves the env behind until the user takes the restart it
   * was asked for, and reporting that window as damage tells the operator a
   * healthy app is broken. Only `'repair'` is drift that needs acting on.
   */
  action?: 'ok' | 'repair';
  pendingRestart?: boolean;
  /** The custom hostname Companion Portal has wired for this app, when it has one. */
  customDomain?: string | null;
  /**
   * A bound custom domain is dark because this app still answers on its platform
   * hostname. Narrower than `pendingRestart`, which any settings change raises —
   * only this one justifies telling a customer their domain does not work.
   */
  awaitingCustomDomainRestart?: boolean;
  /** The app restarts on its own when a domain is connected, so nobody needs to be asked. */
  autoRestartOnDomainChange?: boolean;
};

/**
 * The one key every surface reads this report under, so a lifecycle event can
 * refresh all of them at once. A hand-written literal in each component would be
 * invisible to `invalidateAppQueries`, and the banner would keep asserting a dark
 * domain after the restart that cleared it.
 */
export const PUBLIC_WEB_DIAGNOSTICS_QUERY_KEY = ['public-web-diagnostics'] as const;

/**
 * A restart is only work worth asking for while the app is RUNNING.
 *
 * - Stopped or missing: `repair()` rewrites the env and returns success without
 *   starting anything (it gates the restart on the app's status), so a "Restart now"
 *   there dismisses the warning while the customer's domain stays dark. Nothing is
 *   owed anyway — `start-app-command` regenerates the env on the way up.
 * - Starting, restarting, updating, resetting, restoring: the remedy is already in
 *   flight and will clear the flag itself.
 * - Installing or uninstalling: the env is mid-flight, or the app is being deleted.
 */
export function restartCanApply(status: string | undefined): boolean {
  return status === 'running';
}

/**
 * The domain this app is keeping dark until it restarts, or `null` when there is
 * nothing to say. Defined once so the banner, its click guard and the tile badge
 * cannot drift into acting on three different sets of apps.
 */
export function customDomainAwaitingRestart(entry: PublicWebDiagnosticsApp | undefined): string | null {
  if (!entry?.awaitingCustomDomainRestart || !entry.customDomain) return null;
  return restartCanApply(entry.status) ? entry.customDomain : null;
}

export async function fetchPublicWebDiagnostics(): Promise<{ apps: PublicWebDiagnosticsApp[] } | null> {
  const result = await sdkResult(getDiagnostics2());
  if (!result.ok) return null;
  return (result.data ?? { apps: [] }) as { apps: PublicWebDiagnosticsApp[] };
}

/**
 * The report for a `useQuery`, where `null` must NOT be an answer.
 *
 * TanStack treats a resolved `null` as success, so a transient 401 or 500 would be
 * cached as "nothing is wrong" for the whole `staleTime`, with `retry: false` set
 * app-wide — a surface whose only job is to say a customer's domain is dark would
 * go quiet on exactly the failure it should survive. Throwing keeps the query in
 * error and leaves the last good `data` on screen.
 */
export async function queryPublicWebDiagnostics(): Promise<{ apps: PublicWebDiagnosticsApp[] }> {
  const report = await fetchPublicWebDiagnostics();
  if (!report) throw new Error('APP_PUBLIC_WEB_REPAIR_ERROR');
  return report;
}

export type PublicWebRepairResult = {
  appUrn: string;
  success: boolean;
  message?: string;
  repairedHostname?: string;
};

/**
 * Re-apply an app's Public Web routing from its stored config. The Hub rewrites the
 * app env, restarts the app when it is running and re-syncs Cloudflare — the same
 * work `cihub public-web repair --app <name>` does, so a drifted app can be fixed
 * without editing (and re-saving) its configuration.
 */
export async function repairPublicWebRouting(appUrn: string): Promise<PublicWebRepairResult[]> {
  const result = await sdkResult(repairPublicWebSdk({ body: { appUrns: [appUrn] } }));
  if (!result.ok) {
    /*
     * The generated client RESOLVES on a non-2xx unless `throwOnError` is passed, so
     * the response interceptor's TranslatableError arrives as `result.error` rather
     * than as a rejection. Rethrow it: a denied grant has to keep reading "You are
     * not allowed to configure this app", not the generic fallback below, which is
     * for transport faults that carry no error of their own. The fallback is an i18n
     * key, not prose — callers hand it to `formatApiError`, which translates it.
     */
    throw result.error instanceof Error ? result.error : new Error('APP_PUBLIC_WEB_REPAIR_ERROR');
  }
  return (result.data as { results?: PublicWebRepairResult[] } | undefined)?.results ?? [];
}
