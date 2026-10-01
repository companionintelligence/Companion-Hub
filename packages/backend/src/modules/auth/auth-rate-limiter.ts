import { isIPv6 } from 'node:net';
import { TranslatableError } from '@/common/error/translatable-error';
import { HttpStatus, Injectable } from '@nestjs/common';

/**
 * What each guarded route allows per client address, per window.
 *
 * `failures` scopes count only attempts that did not succeed: a guess is what brute force needs, a
 * correct password is not one. That also keeps the limit out of the way of a test suite or a script
 * that signs in repeatedly from one address. `attempts` scopes count every request, for routes where
 * the request itself is the cost (it creates an account or sends an email) and success proves nothing.
 *
 * Both are counted the same way, when the request is ADMITTED. A `failures` scope that waited for the
 * outcome counted a request only after its argon2 hash had been checked, so a burst of parallel guesses
 * all passed the check before any of them had been counted: 300 simultaneous wrong logins were all
 * admitted against a limit of 10. Admitting reserves the slot at once, and a success hands its own
 * slot back.
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
 * the real client behind Traefik and the tunnel, not the proxy's own. Where a caller reaches the Hub
 * through a hop the Hub does not vouch for (a Docker Desktop port mapping, an operator's own proxy
 * without `HUB_TRUST_PROXY`), every caller shares the proxy's address and therefore one budget.
 */
@Injectable()
export class AuthRateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** The clock. A field rather than a constructor argument so Nest has nothing to inject; tests replace it. */
  public now: () => number = Date.now;

  /**
   * Throw 429 if `clientKey` has used up `scope`; otherwise reserve a slot for this request.
   *
   * @returns a function that gives the slot back, for a request that turned out to be a success. It
   * gives back only this request's own slot: a success does not wipe the failures of other requests
   * from the same address, or one correct login would reset the budget for guessing at the others.
   * It does nothing in an `attempts` scope.
   */
  public admit(scope: AuthRateScope, clientKey: string): () => void {
    const { mode, limit, windowMs } = SCOPES[scope];
    const key = `${scope}:${clientKey}`;
    const recent = this.recent(key, windowMs);

    if (recent.length >= limit) {
      const oldest = recent[0] ?? this.now();
      const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - this.now()) / 1000));
      throw new TranslatableError('AUTH_ERROR_RATE_LIMITED', { retryAfter: String(retryAfter) }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const at = this.now();
    this.record(key, recent, at);

    if (mode !== 'failures') {
      return () => undefined;
    }

    // Once only: two slots taken in the same millisecond look alike, so a second call would give back another request's.
    let refunded = false;

    return () => {
      if (!refunded) {
        refunded = true;
        this.refund(key, at);
      }
    };
  }

  private recent(key: string, windowMs: number): number[] {
    const cutoff = this.now() - windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length === 0) {
      this.hits.delete(key);
    }

    return recent;
  }

  private refund(key: string, at: number): void {
    const hits = this.hits.get(key);
    const index = hits?.indexOf(at) ?? -1;

    if (!hits || index === -1) {
      return;
    }

    const remaining = hits.filter((_, position) => position !== index);

    if (remaining.length === 0) {
      this.hits.delete(key);
    } else {
      this.hits.set(key, remaining);
    }
  }

  private record(key: string, recent: number[], at: number): void {
    this.hits.set(key, [...recent, at]);

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

/**
 * The key an address is limited under: the address itself, except that an IPv6 client is limited as
 * its whole /64. A host is routinely given a /64 (that is what a home connection or a cloud VM gets),
 * so keying on the full address would hand anyone with one billions of fresh budgets. An IPv4-mapped
 * IPv6 address is the IPv4 address it wraps.
 */
export function authClientKey(request: { ip?: string; socket?: { remoteAddress?: string } }): string {
  const address = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
  const unwrapped = address.replace(/^::ffff:/i, '');

  return ipv6Prefix64(unwrapped) ?? unwrapped;
}

function ipv6Prefix64(address: string): string | undefined {
  const bare = address.split('%')[0] ?? address;

  if (!isIPv6(bare)) {
    return undefined;
  }

  const [head = '', tail = ''] = bare.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = bare.includes('::') && tail ? tail.split(':') : [];
  // A dotted IPv4 tail stands for two groups.
  const tailGroups = tailParts.reduce((total, part) => total + (part.includes('.') ? 2 : 1), 0);
  const zeros = bare.includes('::') ? Math.max(0, 8 - headParts.length - tailGroups) : 0;
  const groups = [...headParts, ...Array<string>(zeros).fill('0'), ...tailParts]
    .slice(0, 4)
    .map((group) => Number.parseInt(group || '0', 16).toString(16));

  return `${groups.join(':')}::/64`;
}
