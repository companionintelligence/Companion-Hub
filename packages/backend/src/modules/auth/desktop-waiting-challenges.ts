import crypto from 'node:crypto';

/** How long a challenge stays open. The desktop shell answers within its 5 s request timeout. */
export const DESKTOP_WAITING_CHALLENGE_TTL_MS = 60_000;

/** How many challenges may be open at once. The oldest goes first, so asking for many grants nothing. */
export const DESKTOP_WAITING_CHALLENGE_CAP = 32;

/**
 * The nonces handed out by `POST /api/auth/portal/desktop-waiting/challenge`, which the desktop
 * shell signs to set the desktop sign-in flag. Each can be taken once, whether or not the proof
 * that came with it was right, so a proof can't be replayed and doesn't depend on any clock but
 * this process's own. Kept in memory: a Hub restart drops them, and the shell asks again a minute later.
 */
export class DesktopWaitingChallenges {
  /** Insertion order is issue order, which is what the cap drops by. */
  private readonly open = new Map<string, number>();

  /** The clock. A field rather than a constructor argument, as in AuthRateLimiter; tests replace it. */
  public now: () => number = Date.now;

  public issue(): string {
    this.dropExpired();
    for (const oldest of this.open.keys()) {
      if (this.open.size < DESKTOP_WAITING_CHALLENGE_CAP) {
        break;
      }
      this.open.delete(oldest);
    }

    const nonce = crypto.randomBytes(32).toString('hex');
    this.open.set(nonce, this.now());
    return nonce;
  }

  /** Whether `nonce` was open and still live. It is closed afterwards either way. */
  public take(nonce: unknown): nonce is string {
    if (typeof nonce !== 'string') {
      return false;
    }
    const issuedAt = this.open.get(nonce);
    this.open.delete(nonce);
    return issuedAt !== undefined && this.now() - issuedAt <= DESKTOP_WAITING_CHALLENGE_TTL_MS;
  }

  private dropExpired(): void {
    for (const [nonce, issuedAt] of this.open) {
      if (this.now() - issuedAt > DESKTOP_WAITING_CHALLENGE_TTL_MS) {
        this.open.delete(nonce);
      }
    }
  }
}
