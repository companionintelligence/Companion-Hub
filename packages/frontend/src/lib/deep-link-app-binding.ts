/**
 * Binding a Hub sign-in's one-time code to this app.
 *
 * A native sign-in ends with the Hub handing a one-time code back over a
 * `cihub://auth?token=` link. Such a link can be opened by any web page, and on
 * Android another app can register the scheme, so the code alone must not be
 * enough to sign in. Before opening the sign-in, the app makes a secret, keeps
 * it here, and sends only its SHA-256 to the Hub (`app_challenge`). The Hub then
 * redeems the code only for a caller that presents the secret, and this app only
 * redeems a code while it has one waiting: a link nobody here asked for is
 * dropped.
 *
 * Kept in localStorage, not memory: on a phone the system browser often
 * cold-starts the app on the way back, and the secret has to survive that.
 */
const STORAGE_KEY = 'ci-hub.portal-deep-link-verifier';

/** Longer than the Hub keeps a sign-in open (state, then code), so a slow sign-in still lands. */
const VERIFIER_TTL_MS = 30 * 60 * 1000;

interface StoredVerifier {
  verifier: string;
  createdAt: number;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function appChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));

  return base64url(new Uint8Array(digest));
}

/** `startUrl` with a fresh `app_challenge`; the secret behind it is kept for the exchange. */
export async function bindSignInToThisApp(startUrl: string, now: number = Date.now()): Promise<string> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const record: StoredVerifier = { verifier, createdAt: now };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // No storage: the sign-in can still start, but its code will be dropped on the way back.
  }

  const url = new URL(startUrl);
  url.searchParams.set('app_challenge', await appChallengeFor(verifier));

  return url.toString();
}

/** The secret of the sign-in this app started, or null when none is waiting (or it is too old). */
export function pendingAppVerifier(now: number = Date.now()): string | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<StoredVerifier> | null;
    if (typeof parsed?.verifier !== 'string' || typeof parsed.createdAt !== 'number') {
      return null;
    }

    return now - parsed.createdAt <= VERIFIER_TTL_MS ? parsed.verifier : null;
  } catch {
    return null;
  }
}

/** Forget the secret once its code is answered, so it cannot redeem another. */
export function clearAppVerifier(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
