import { TranslatableError } from '@/common/error/translatable-error';
import { HttpStatus, Injectable } from '@nestjs/common';

/**
 * What each guarded route allows per client address, per window.
 *
 * `failures` scopes count only attempts that did not succeed and are forgotten on success: a
 * guess is what brute force needs, a correct password is not one. That also keeps the limit out of
 * the way of a test suite or a script that signs in repeatedly from one address. `attempts` scopes
 * count every request, for routes where the request itself is the cost (it creates an account or
 * sends an email) and success proves nothing.
 */
const SCOPES = {
  login: { mode: 'failures', limit: 10, windowMs: 60_000 },
  totp: { mode: 'failures', limit: 10, windowMs: 60_000 },
  passwordResetVerify: { mode: 'failures', limit: 10, windowMs: 60_000 },
  register: { mode: 'attempts', limit: 5, windowMs: 60_000 },
  passwordResetRequest: { mode: 'attempts', limit: 5, windowMs: 60_000 },
} as const;

export type AuthRateScope = keyof typeof SCOPES;

/** Bound on tracked addresses, so a client rotating through IPv6 space cannot grow the table without limit. */
const MAX_TRACKED_KEYS = 10_000;

/**
 * An in-memory limiter for the unauthenticated auth routes.
 *
 * ⚠ KEYED BY CLIENT ADDRESS, NEVER BY ACCOUNT. Keying by email would let anyone who knows the
 * operator's address lock the operator out by failing a few times on purpose.
 *
 * The address is whatever Express resolved through the Hub's trusted-proxy configuration, so it is
 * the real client behind Traefik and the tunnel, not the proxy's own.
 */
@Injectable()
export class AuthRateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** The clock. A field rather than a constructor argument so Nest has nothing to inject; tests replace it. */
  public now: () => number = Date.now;

  /** Throw 429 if `clientKey` has used up `scope`. For `attempts` scopes this also counts the request. */
  public assertAllowed(scope: AuthRateScope, clientKey: string): void {
    const { mode, limit, windowMs } = SCOPES[scope];
    const key = `${scope}:${clientKey}`;
    const recent = this.recent(key, windowMs);

    if (recent.length >= limit) {
      const oldest = recent[0] ?? this.now();
      const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - this.now()) / 1000));
      throw new TranslatableError('AUTH_ERROR_RATE_LIMITED', { retryAfter: String(retryAfter) }, HttpStatus.TOO_MANY_REQUESTS);
    }

    if (mode === 'attempts') {
      this.record(key, recent);
    }
  }

  /** Count a failed attempt. A no-op for `attempts` scopes, which {@link assertAllowed} already counted. */
  public recordFailure(scope: AuthRateScope, clientKey: string): void {
    const { mode, windowMs } = SCOPES[scope];

    if (mode !== 'failures') {
      return;
    }

    const key = `${scope}:${clientKey}`;
    this.record(key, this.recent(key, windowMs));
  }

  /** Forget the failures of a client that just got it right. */
  public recordSuccess(scope: AuthRateScope, clientKey: string): void {
    if (SCOPES[scope].mode === 'failures') {
      this.hits.delete(`${scope}:${clientKey}`);
    }
  }

  private recent(key: string, windowMs: number): number[] {
    const cutoff = this.now() - windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length === 0) {
      this.hits.delete(key);
    }

    return recent;
  }

  private record(key: string, recent: number[]): void {
    this.hits.set(key, [...recent, this.now()]);

    if (this.hits.size > MAX_TRACKED_KEYS) {
      this.sweep();
    }
  }

  private sweep(): void {
    const longest = Math.max(...Object.values(SCOPES).map((scope) => scope.windowMs));
    const cutoff = this.now() - longest;

    for (const [key, times] of this.hits) {
      if ((times[times.length - 1] ?? 0) <= cutoff) {
        this.hits.delete(key);
      }
    }

    // Everything is live and the table is still over the cap: drop the oldest entries first.
    for (const key of this.hits.keys()) {
      if (this.hits.size <= MAX_TRACKED_KEYS) {
        break;
      }
      this.hits.delete(key);
    }
  }
}
