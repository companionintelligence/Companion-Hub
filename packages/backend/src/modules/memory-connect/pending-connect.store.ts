import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';

/** How long a started connect flow may take before its state nonce expires. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Hard cap on concurrent in-flight attempts. A started flow only lives for one
 * browser round trip, so this is far above any legitimate concurrent-connect
 * count on a single-owner appliance; it bounds both memory and the O(n) prune
 * scan if `create()` is ever called in a tight loop.
 */
const MAX_PENDING = 1000;

/**
 * How long a consumed `state` is remembered. The window only needs to cover a
 * browser replaying the callback URL it just visited (refresh after an aborted
 * navigation, back button) — minutes, not the flow's full TTL.
 */
const TOMBSTONE_TTL_MS = 2 * 60 * 1000;

/** Bound on remembered consumed states; sized like MAX_PENDING, same rationale. */
const MAX_TOMBSTONES = 500;

interface PendingEntry {
  appUrn: AppUrn;
  /** Where to send the browser after the connection is applied. */
  next: string;
  /** Hub user who initiated the flow; the callback must be the same user. */
  userId: string;
  expiresAt: number;
}

/**
 * `consumed` — first (and authoritative) consume of a live state: the caller
 * should run the exchange. `replayed` — the state was already consumed within
 * the tombstone window: the flow's outcome already happened, the caller must
 * NOT re-exchange, only route the browser somewhere sensible. `unknown` — never
 * issued, or expired before completion.
 */
export type ConsumeResult =
  | { outcome: 'consumed'; appUrn: AppUrn; next: string; userId: string }
  | { outcome: 'replayed'; appUrn: AppUrn; next: string; userId: string }
  | { outcome: 'unknown' };

/**
 * In-memory store of in-flight connect attempts, keyed by a random `state`
 * nonce. This is the login-CSRF / code-injection guard for the cross-origin
 * hop: the Hub only accepts a callback whose `state` matches an attempt it
 * started, and binds it to the exact app URN.
 *
 * Kept in memory deliberately — an attempt lives for a single browser round
 * trip (minutes). If the Hub restarts mid-flow the user simply retries; nothing
 * durable is lost (the durable credential is only written after a successful
 * exchange).
 *
 * A consumed entry leaves a short-lived tombstone so a benign replay of the
 * callback URL (the browser refreshing after `ERR_NETWORK_CHANGED` aborted the
 * navigation mid-restart, or the back button) is distinguishable from a forged
 * or expired state — the exchange itself stays single-use.
 */
@Injectable()
export class PendingConnectStore {
  private readonly entries = new Map<string, PendingEntry>();
  private readonly tombstones = new Map<string, PendingEntry>();

  /**
   * Start an attempt for `appUrn` (initiated by Hub user `userId`) and return the
   * opaque `state` nonce to carry through CI-Server and back.
   */
  create(appUrn: AppUrn, next: string, userId: string): string {
    this.prune();

    // Bound the map under a flood: after pruning expired entries, if still at the
    // cap, evict the oldest (insertion order) — an in-flight attempt that hasn't
    // completed by then is almost certainly abandoned; a real user just retries.
    if (this.entries.size >= MAX_PENDING) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }

    const state = randomBytes(32).toString('hex');
    this.entries.set(state, { appUrn, next, userId, expiresAt: Date.now() + PENDING_TTL_MS });

    return state;
  }

  /**
   * Consume a `state` nonce. The first consume of a live, unexpired state wins
   * (`consumed`) and leaves a tombstone; consuming again within
   * {@link TOMBSTONE_TTL_MS} reports `replayed` with the same bound attempt (and
   * keeps the tombstone, so repeated refreshes keep resolving). An expired
   * pending entry is dropped WITHOUT a tombstone — its flow never completed, so
   * a later callback must read as invalid, not as a replay of a success.
   */
  consume(state: string): ConsumeResult {
    this.prune();

    const entry = this.entries.get(state);

    if (entry) {
      this.entries.delete(state);

      if (entry.expiresAt < Date.now()) {
        return { outcome: 'unknown' };
      }

      if (this.tombstones.size >= MAX_TOMBSTONES) {
        const oldest = this.tombstones.keys().next().value;
        if (oldest !== undefined) {
          this.tombstones.delete(oldest);
        }
      }

      this.tombstones.set(state, { ...entry, expiresAt: Date.now() + TOMBSTONE_TTL_MS });

      return { outcome: 'consumed', appUrn: entry.appUrn, next: entry.next, userId: entry.userId };
    }

    const tombstone = this.tombstones.get(state);

    if (tombstone && tombstone.expiresAt >= Date.now()) {
      return { outcome: 'replayed', appUrn: tombstone.appUrn, next: tombstone.next, userId: tombstone.userId };
    }

    return { outcome: 'unknown' };
  }

  /** Drop expired entries and tombstones so an abandoned flow never leaks memory. */
  private prune(): void {
    const now = Date.now();

    for (const [state, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(state);
      }
    }

    for (const [state, entry] of this.tombstones) {
      if (entry.expiresAt < now) {
        this.tombstones.delete(state);
      }
    }
  }
}
