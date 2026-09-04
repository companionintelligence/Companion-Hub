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
    // An i18n key, not prose: callers hand this to `formatApiError`, which translates
    // it. A 4xx never reaches here — the client's response interceptor throws its own
    // TranslatableError first, so a denied grant keeps its own message.
    throw new Error('APP_PUBLIC_WEB_REPAIR_ERROR');
  }
  return ((result.data ?? {}) as { results?: PublicWebRepairResult[] }).results ?? [];
}
