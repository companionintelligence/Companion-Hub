import { createHash, randomBytes, randomInt } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { ServingQuarantine } from '@/modules/inference/backends/serving-quarantine';
import type { PoolPairingPinState } from './hub-pool.types';

/** How long a minted PIN is good for. Long enough to walk to the other machine or read it over the phone. */
export const PAIRING_PIN_TTL_MS = 600_000;
/**
 * Wrong guesses a single PIN survives. The sixth destroys it, so the total exposure of one PIN is
 * 5/10^6 regardless of how many sources try — which is why there is no separate global rate limit:
 * the secret itself is the budget, and a global lockout would only hand an attacker a way to stop
 * the operator pairing at all.
 */
export const PAIRING_PIN_MAX_ATTEMPTS = 5;

/** The uniform failure. Wrong, expired, already used and none-outstanding are indistinguishable by design. */
const PIN_FAILURE_MESSAGE = 'Invalid or expired pairing PIN';

interface ActivePin {
  hash: string;
  salt: string;
  expiresAt: number;
  attempts: number;
}

/** Who is presenting a PIN, for the per-source cooldown. Both keys are claims; that is why they are layer 2, not layer 1. */
export interface PinAttemptSource {
  claimedFqdn?: string;
  ip?: string;
}

/**
 * The 6-digit PIN that authenticates a pairing request.
 *
 * WHAT IT BUYS, precisely: `POST /pair/request` is the module's only unauthenticated write. Without
 * a PIN it will create a `pending` row, and store a caller-supplied token as
 * `present_token_encrypted`, for anyone who can name a plausible FQDN *on this tailnet*.
 * `assertTailnetMember` refuses a name outside this node's MagicDNS suffix with no credential at all,
 * but a suffix is only a string: the device-membership check that would catch a fabricated one needs
 * a Tailscale Admin API credential that is optional, and the whole check degrades to a no-op when
 * this node has joined no tailnet, or when a configured Admin API is unreachable. With a PIN, a wrong
 * guess creates *nothing*: no pending slot, no planted outbound token, and no identity claim pinned.
 *
 * WHAT IT DOES NOT BUY: confidentiality (WireGuard and TLS already cover that), and it is not a
 * credential. 20 bits is only safe because of expiry, single use, a hard attempt ceiling and a
 * per-source cooldown — so it authenticates the pairing REQUEST and nothing that outlives it. The
 * pinned key does everything after.
 *
 * RATE LIMITING reuses `ServingQuarantine` — the module's existing strike-then-exponential-backoff
 * limiter, with its own constants (2 strikes, 60s doubling to 15 min) — rather than adding another
 * hand-rolled one. Keyed independently on the claimed FQDN and on the source IP: trivially dodged
 * by varying the claimed name, which is exactly why it is the second layer and the per-PIN ceiling
 * is the first.
 *
 * The IP key is present only when the Hub can honestly identify the caller — see
 * `callerSourceIp`. Behind Traefik or the Cloudflare tunnel, with `HUB_TRUST_PROXY` unset,
 * `request.ip` is the proxy rather than the caller, so keying on it would produce ONE bucket shared
 * by every caller on earth. That is not a stricter limit, it is a different one: a global lockout,
 * which would let anyone who can reach the tunnel stop the operator pairing at all — precisely the
 * failure this class's "no separate global rate limit" note exists to avoid. In that configuration
 * the cooldown therefore runs on the claimed FQDN alone, and the per-PIN attempt ceiling above —
 * which is source-independent by construction — remains the real bound on exposure.
 */
@Injectable()
export class HubPoolPairingPinService {
  private active: ActivePin | null = null;
  /**
   * Test seam, not a constructor parameter: Nest resolves constructor arguments by type and cannot
   * inject a bare function, so a defaulted `now` parameter would fail at bootstrap. The quarantine
   * below reads it through a closure, so {@link withClock} moves both.
   */
  private now: () => number = () => Date.now();
  private readonly cooldown = new ServingQuarantine(() => this.now());

  constructor(private readonly logger: LoggerService) {}

  /** Install a fake clock. Every window in here is minutes long and none of it is worth waiting out in a test. */
  withClock(now: () => number): this {
    this.now = now;
    return this;
  }

  /**
   * Mint a PIN, replacing any outstanding one.
   *
   * Exactly one PIN is live at a time: two would double the guess surface for no operator benefit,
   * and "which of the two codes on my screen is current" is not a question anyone should have.
   *
   * `randomInt` rather than `randomBytes(n) % 1e6`, which is modulo-biased. Held only in memory —
   * a restart cancels an in-flight PIN, which is correct, because the operator is standing at the
   * screen. Hashed with a random salt so a heap dump does not hand over the digits; sha256 rather
   * than argon2 (which this repo does have, for user passwords) because 20 bits cannot survive
   * offline cracking under any KDF, the defence is the attempt ceiling, and this runs on a request
   * path.
   */
  mint(): { pin: string; expiresAt: string } {
    if (this.active) {
      this.logger.info('[HubPool] replacing the outstanding pairing PIN with a newly minted one');
    }
    const pin = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const expiresAt = this.now() + PAIRING_PIN_TTL_MS;
    this.active = { hash: hashPin(salt, pin), salt, expiresAt, attempts: 0 };
    return { pin, expiresAt: new Date(expiresAt).toISOString() };
  }

  cancel(): void {
    if (this.active) {
      this.logger.info('[HubPool] outstanding pairing PIN cancelled by the operator');
    }
    this.active = null;
  }

  /** Whether a PIN is outstanding, and until when. Never the digits — those are returned exactly once, by {@link mint}. */
  state(): PoolPairingPinState {
    this.sweep();
    return { active: this.active !== null, expiresAt: this.active ? new Date(this.active.expiresAt).toISOString() : null };
  }

  /** Drop an expired PIN. Only reclaims memory: {@link consume} enforces expiry itself, so sweep lag is harmless. */
  sweep(): void {
    if (this.active && this.now() >= this.active.expiresAt) {
      this.logger.info('[HubPool] pairing PIN expired unused');
      this.active = null;
    }
  }

  /**
   * Verify and consume a PIN, or throw.
   *
   * Single use: a correct PIN is destroyed on the first success, so someone who shoulder-surfs it —
   * or sees it in a support screenshot — cannot pair a second, unwanted node inside the window.
   *
   * Every failure path returns the SAME 401 with the same message. Telling a caller whether a PIN
   * is even outstanding is an oracle that makes the 10^6 space searchable in two steps. The 429
   * from the cooldown is deliberately distinguishable: it is about the caller, not the secret.
   */
  consume(pin: string, source: PinAttemptSource = {}): void {
    const keys = sourceKeys(source);
    const cooling = keys.find((key) => this.cooldown.isWithheld(key));
    if (cooling) {
      // 429, not the uniform 401: this one is about the caller, not about the secret, and an
      // operator whose own retry is being refused needs to be able to tell the two apart.
      throw new HttpException('Too many failed pairing attempts from this source; try again shortly', HttpStatus.TOO_MANY_REQUESTS);
    }

    this.sweep();
    const active = this.active;
    if (!active) {
      this.recordFailure(keys, 'no pairing PIN outstanding');
      throw new UnauthorizedException(PIN_FAILURE_MESSAGE);
    }

    // Counted before the comparison, so a caller cannot get a free guess by racing.
    active.attempts += 1;
    if (hashPin(active.salt, pin) !== active.hash) {
      if (active.attempts >= PAIRING_PIN_MAX_ATTEMPTS) {
        this.logger.warn(`[HubPool] destroying the outstanding pairing PIN after ${active.attempts} failed attempts`);
        this.active = null;
      }
      this.recordFailure(keys, 'wrong pairing PIN');
      throw new UnauthorizedException(PIN_FAILURE_MESSAGE);
    }

    this.active = null;
    for (const key of keys) {
      this.cooldown.recordSuccess(key);
    }
  }

  private recordFailure(keys: string[], reason: string): void {
    for (const key of keys) {
      const decision = this.cooldown.recordFailure(key, reason);
      if (decision.withheld) {
        this.logger.warn(`[HubPool] pairing attempts from ${key} refused for ${Math.round(decision.forMs / 1000)}s: ${reason}`);
      }
    }
  }
}

function hashPin(salt: string, pin: string): string {
  return createHash('sha256').update(`${salt}:${pin}`).digest('hex');
}

function sourceKeys(source: PinAttemptSource): string[] {
  const keys: string[] = [];
  if (source.claimedFqdn) keys.push(`fqdn:${source.claimedFqdn}`);
  if (source.ip) keys.push(`ip:${source.ip}`);
  return keys;
}
