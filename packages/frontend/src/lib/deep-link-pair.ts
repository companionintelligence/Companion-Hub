const PENDING_PAIRING_CODE_KEY = 'ci-hub.pending-pairing-code';

export function normalizePairingCode(code: string): string | null {
  const normalized = code.trim().toUpperCase();
  if (normalized.length !== 6 || !/^[A-Z0-9]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export function stashPendingPairingCode(code: string) {
  const normalized = normalizePairingCode(code);
  if (!normalized) {
    return;
  }
  sessionStorage.setItem(PENDING_PAIRING_CODE_KEY, normalized);
}

export function takeStashedPairingCode(): string | null {
  const raw = sessionStorage.getItem(PENDING_PAIRING_CODE_KEY);
  if (!raw) {
    return null;
  }
  sessionStorage.removeItem(PENDING_PAIRING_CODE_KEY);
  return normalizePairingCode(raw);
}

export async function takePendingPairingCodeFromDesktop(): Promise<string | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return null;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const code = await invoke<string | null>('consume_pending_pairing_code');
    return code ? normalizePairingCode(code) : null;
  } catch {
    return null;
  }
}

export async function resolvePendingPairingCode(): Promise<string | null> {
  return (await takePendingPairingCodeFromDesktop()) ?? takeStashedPairingCode();
}

/**
 * Forget a pairing code the registration screen has used, wherever its link left a copy.
 *
 * One link leaves several: the desktop shell parks it as well as emitting it, both listeners stash
 * what they hear, and Linux and Windows deliver each link twice. A copy left behind was submitted
 * again the next time registration opened in this session, and Portal refuses a code once used.
 */
export async function forgetPendingPairingCode(code: string): Promise<void> {
  const normalized = normalizePairingCode(code);
  if (!normalized) {
    return;
  }

  if (normalizePairingCode(sessionStorage.getItem(PENDING_PAIRING_CODE_KEY) ?? '') === normalized) {
    sessionStorage.removeItem(PENDING_PAIRING_CODE_KEY);
  }

  const parked = await takePendingPairingCodeFromDesktop();
  if (parked && parked !== normalized) {
    // A link with a different code arrived meanwhile: keep it for the next attempt.
    stashPendingPairingCode(parked);
  }
}
