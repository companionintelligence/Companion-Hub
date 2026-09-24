import { checkDnsAvailability as checkDnsAvailabilitySdk, getDiagnostics2, repair as repairPublicWebSdk } from '@/api-client/sdk.gen';
import { sdkResult } from '@/lib/sdk-unwrap';

/** Minimal Response shape for legacy DNS check callers. */
function asResponse(result: { ok: boolean; status: number; data?: unknown }): Pick<Response, 'ok' | 'status' | 'json'> {
  return {
    ok: result.ok,
    status: result.status,
    json: async () => result.data,
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
};

export async function fetchPublicWebDiagnostics(): Promise<{ apps: PublicWebDiagnosticsApp[] } | null> {
  const result = await sdkResult(getDiagnostics2());
  if (!result.ok) return null;
  return (result.data ?? { apps: [] }) as { apps: PublicWebDiagnosticsApp[] };
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
