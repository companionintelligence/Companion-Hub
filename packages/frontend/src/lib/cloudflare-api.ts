import { checkDnsAvailability as checkDnsAvailabilitySdk, getDiagnostics2 } from '@/api-client/sdk.gen';
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
};

export async function fetchPublicWebDiagnostics(): Promise<{ apps: PublicWebDiagnosticsApp[] } | null> {
  const result = await sdkResult(getDiagnostics2());
  if (!result.ok) return null;
  return (result.data ?? { apps: [] }) as { apps: PublicWebDiagnosticsApp[] };
}
