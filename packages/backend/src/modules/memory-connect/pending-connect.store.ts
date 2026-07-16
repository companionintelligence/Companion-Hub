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
 * How long a consumed `state` is remembered. Sized to PENDING_TTL_MS — it must
 * at least cover the restart window the finishing interstitial itself budgets
 * (3 minutes of polling, plus a user coming back to a stale tab), and a longer
 * window costs nothing: a replay is redirect-only (never a second exchange),
 * user-checked, and the map is bounded by MAX_TOMBSTONES.
 */
const TOMBSTONE_TTL_MS = PENDING_TTL_MS;

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

interface TombstoneEntry extends PendingEntry {
  /**
   * The redirect the first (authoritative) attempt actually resolved to, so a
   * replay repeats the real outcome instead of assuming success. Initialized
   * to `next` (the safe landing for a failed, deferred, or still-in-flight
   * attempt) and upgraded via {@link PendingConnectStore.recordOutcome} once
   * the attempt resolves to something else (the finishing interstitial).
   */
  redirect: string;
}

/**
 * `consumed` — first (and authoritative) consume of a live state: the caller
 * should run the exchange. `replayed` — the state was already consumed within
 * the tombstone window: the flow's outcome already happened, the caller must
 * NOT re-exchange, only send the browser to the recorded `redirect`. `unknown`
 * — never issued, or expired before completion.
 */
export type ConsumeResult =
  | { outcome: 'consumed'; appUrn: AppUrn; next: string; userId: string }
  | { outcome: 'replayed'; appUrn: AppUrn; next: string; userId: string; redirect: string }
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
 * A consumed entry leaves a tombstone recording how the attempt resolved, so a
 * benign replay of the callback URL (the browser refreshing after
 * `ERR_NETWORK_CHANGED` aborted the navigation mid-restart, or the back
 * button) repeats the original redirect — never a second exchange, and never a
 * fabricated success for an attempt that actually failed.
 */
@Injectable()
export class PendingConnectStore {
  private readonly entries = new Map<string, PendingEntry>();
  private readonly tombstones = new Map<string, TombstoneEntry>();

  /**
   * Start an attempt for `appUrn` (initiated by Hub user `userId`) and return the
   * opaque `state` nonce to carry through CI-Server and back.
   */
  create(appUrn: AppUrn, next: string, userId: string): string {
    this.prune();

    // Bound the map under a flood: after pruning expired entries, if still at the
    // cap, evict the oldest (insertion order) — an in-flight attempt that hasn't
    // completed by then is almost certainly abandoned; a real user just retries.
    this.evictOldestIfFull(this.entries, MAX_PENDING);

    const state = randomBytes(32).toString('hex');
    this.entries.set(state, { appUrn, next, userId, expiresAt: Date.now() + PENDING_TTL_MS });

    return state;
  }

  /**
   * Consume a `state` nonce. The first consume of a live, unexpired state wins
   * (`consumed`) and leaves a tombstone; consuming again within
   * {@link TOMBSTONE_TTL_MS} reports `replayed` with the recorded outcome (and
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

      this.evictOldestIfFull(this.tombstones, MAX_TOMBSTONES);
      this.tombstones.set(state, { ...entry, redirect: entry.next, expiresAt: Date.now() + TOMBSTONE_TTL_MS });

      return { outcome: 'consumed', appUrn: entry.appUrn, next: entry.next, userId: entry.userId };
    }

    const tombstone = this.tombstones.get(state);

    if (tombstone && tombstone.expiresAt >= Date.now()) {
      return {
        outcome: 'replayed',
        appUrn: tombstone.appUrn,
        next: tombstone.next,
        userId: tombstone.userId,
        redirect: tombstone.redirect,
      };
    }

    return { outcome: 'unknown' };
  }

  /**
   * Record where the consumed attempt actually sent the browser, so replays
   * repeat that exact redirect. Only called when the outcome differs from the
   * default (`next`) — today, the finishing interstitial once a restart was
   * scheduled. A no-op if the tombstone has expired or been evicted.
   */
  recordOutcome(state: string, redirect: string): void {
    const tombstone = this.tombstones.get(state);

    if (tombstone) {
      tombstone.redirect = redirect;
    }
  }

  /** Drop the oldest (insertion-order) key when `map` is at capacity. */
  private evictOldestIfFull<T>(map: Map<string, T>, max: number): void {
    if (map.size < max) {
      return;
    }

    const oldest = map.keys().next().value;

    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }

  /** Drop expired entries and tombstones so an abandoned flow never leaks memory. */
  private prune(): void {
    const now = Date.now();

    this.sweepExpired(this.entries, now);
    this.sweepExpired(this.tombstones, now);
  }

  private sweepExpired<T extends { expiresAt: number }>(map: Map<string, T>, now: number): void {
    for (const [state, entry] of map) {
      if (entry.expiresAt < now) {
        map.delete(state);
      }
    }
  }
}
