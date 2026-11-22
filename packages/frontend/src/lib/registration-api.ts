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

/** What the Hub answers a pairing call with when it needs this Hub's setup code. */
export const SETUP_CODE_REQUIRED = 'SETUP_CODE_REQUIRED';

const SETUP_CODE_HEADER = 'X-CI-Hub-Setup-Code';
const SETUP_CODE_STORAGE_KEY = 'ci-hub-setup-code';

/**
 * The setup code an unpaired Hub asks for before it pairs (see the backend's `SetupCodeService`):
 * from the link `cihub setup-code` prints (`?setup=…`), from the desktop app, or typed in. Kept for
 * this tab only, so a reload during pairing does not ask again; never written anywhere longer-lived.
 */
let setupCode: string | null = null;

export function setRegistrationSetupCode(code: string | null): void {
  setupCode = code?.trim() || null;
  try {
    if (setupCode) {
      sessionStorage.setItem(SETUP_CODE_STORAGE_KEY, setupCode);
    } else {
      sessionStorage.removeItem(SETUP_CODE_STORAGE_KEY);
    }
  } catch {
    // Storage blocked: the code still holds for this page.
  }
}

export function getRegistrationSetupCode(): string | null {
  if (setupCode) {
    return setupCode;
  }
  try {
    setupCode = sessionStorage.getItem(SETUP_CODE_STORAGE_KEY);
  } catch {
    setupCode = null;
  }
  return setupCode;
}

/**
 * Take the setup code from the link `cihub setup-code` prints (`…/device-registration?setup=ABCD-EFGH`),
 * and drop it from the address bar so it is not left in history or shown on screen.
 */
export function adoptSetupCodeFromUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const url = new URL(window.location.href);
  const code = url.searchParams.get('setup')?.trim();
  if (!code) {
    return null;
  }
  setRegistrationSetupCode(code);
  url.searchParams.delete('setup');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return code;
}

/**
 * The desktop app runs on the Hub's machine and reads the code from the Hub's data directory, so a
 * person pairing there is never asked for it. Null outside the desktop app or with no code on disk.
 */
export async function adoptSetupCodeFromDesktop(): Promise<string | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return null;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const code = (await invoke<string | null>('hub_setup_code'))?.trim();
    if (!code) {
      return null;
    }
    setRegistrationSetupCode(code);
    return code;
  } catch {
    return null;
  }
}

/** The header every pairing call sends the setup code in, when there is one. */
function setupCodeHeaders(): Record<string, string> | undefined {
  const code = getRegistrationSetupCode();
  return code ? { [SETUP_CODE_HEADER]: code } : undefined;
}

type PairDeviceResult = {
  success?: boolean;
  message?: string;
  /** The Portal's refusal code, such as `DEVICE_PROOF_REQUIRED`. Older Portals send none. */
  code?: string;
  /** With `DEVICE_MOVE_CONFIRMATION_REQUIRED`, the organization pairing would move this Hub into. */
  organizationName?: string;
  domain?: string;
  subdomain?: string;
};

export async function fetchDeviceRegistrationInfoResult() {
  return sdkResult(getDeviceId({ headers: setupCodeHeaders() } as Parameters<typeof getDeviceId>[0]));
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

/**
 * `confirmMove` is the person's yes to `DEVICE_MOVE_CONFIRMATION_REQUIRED`: move this Hub here from
 * the organization that holds it now.
 */
export async function pairWithCode(
  pairingCode: string,
  { confirmMove = false }: { confirmMove?: boolean } = {},
): Promise<{ ok: boolean; status: number; data: PairDeviceResult }> {
  const result = await sdkResult(
    pairDevice({
      body: { pairing_code: pairingCode, ...(confirmMove ? { confirm_move: true } : {}) },
      headers: setupCodeHeaders(),
    } as Parameters<typeof pairDevice>[0]),
  );
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
  const result = await sdkResult(prepareFreshSetup({ headers: setupCodeHeaders() } as Parameters<typeof prepareFreshSetup>[0]));
  return { ok: result.ok, data: (result.data ?? {}) as { success?: boolean; message?: string } };
}

export async function markRegistrationRestoreIntentDetailed(): Promise<{
  ok: boolean;
  data: { success?: boolean; message?: string };
}> {
  const result = await sdkResult(markRestoreIntent({ headers: setupCodeHeaders() } as Parameters<typeof markRestoreIntent>[0]));
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
