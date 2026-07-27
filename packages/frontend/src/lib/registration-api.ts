import {
  getDeviceId,
  getStateDrift,
  getStatus,
  markRestoreIntent,
  pairDevice,
  prepareFreshSetup,
  probeDomain,
  resetRegistration,
} from '@/api-client/sdk.gen';
import { apiFetch } from '@/lib/api-fetch';
import type { RegistrationStatus } from '@/lib/registration-status';
import type { RegistrationStateDrift } from '@/lib/registration-state-drift';
import { sdkResult, unwrapSdkOrNull } from '@/lib/sdk-unwrap';

type PairDeviceResult = {
  success?: boolean;
  message?: string;
  domain?: string;
  subdomain?: string;
};

export async function fetchDeviceRegistrationInfoResult() {
  return sdkResult(getDeviceId());
}

export async function fetchRegistrationStatus(): Promise<RegistrationStatus | null> {
  const status = await unwrapSdkOrNull(getStatus());
  return status as RegistrationStatus | null;
}

export async function fetchRegistrationStateDrift(): Promise<RegistrationStateDrift | null> {
  return unwrapSdkOrNull(getStateDrift()) as Promise<RegistrationStateDrift | null>;
}

export async function probeRegistrationDomain(url: string): Promise<{ ready: boolean } | null> {
  return unwrapSdkOrNull(probeDomain({ query: { url } } as Parameters<typeof probeDomain>[0])) as Promise<{ ready: boolean } | null>;
}

export async function pairWithCode(pairingCode: string): Promise<{ ok: boolean; status: number; data: PairDeviceResult }> {
  const result = await sdkResult(pairDevice({ body: { pairing_code: pairingCode } } as Parameters<typeof pairDevice>[0]));
  return {
    ok: result.ok,
    status: result.status,
    data: (result.data ?? {}) as PairDeviceResult,
  };
}

export async function prepareFreshRegistrationDetailed(): Promise<{
  ok: boolean;
  data: { success?: boolean; message?: string };
}> {
  const result = await sdkResult(prepareFreshSetup());
  return { ok: result.ok, data: (result.data ?? {}) as { success?: boolean; message?: string } };
}

export async function markRegistrationRestoreIntentDetailed(): Promise<{
  ok: boolean;
  data: { success?: boolean; message?: string };
}> {
  const result = await sdkResult(markRestoreIntent());
  return { ok: result.ok, data: (result.data ?? {}) as { success?: boolean; message?: string } };
}

export async function fetchRegistrationStatusResult() {
  return sdkResult(getStatus());
}

type ReconnectTunnelResult = { recovered: boolean; action?: 're_pair' | 'restart'; reason: string };

/**
 * Ask the Hub to restore public/remote access for a registered but
 * tunnel-degraded device by recovering the stored tunnel credentials. Returns a
 * structured outcome so the UI can route correctly (recovered / restart / re_pair)
 * instead of dead-ending on the pairing screen (which rejects registered devices).
 * Not part of the generated SDK, so it uses the raw apiFetch helper.
 */
export async function reconnectTunnel(): Promise<ReconnectTunnelResult> {
  try {
    const res = await apiFetch('/api/registration/reconnect-tunnel', { method: 'POST' });
    if (!res.ok) {
      return { recovered: false, reason: `http_${res.status}` };
    }
    return (await res.json()) as ReconnectTunnelResult;
  } catch (error) {
    return { recovered: false, reason: error instanceof Error ? error.message : 'request_failed' };
  }
}

/** Reset local registration so a registered device can be re-paired (POST /registration/reset). */
export async function resetRegistrationForRePair(): Promise<{ ok: boolean }> {
  const result = await sdkResult(resetRegistration());
  return { ok: result.ok };
}
