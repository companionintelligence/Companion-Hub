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
   * Hash of the one-time code the consuming request presented (null for the
   * deny path, which carries none). A later request with a DIFFERENT code is
   * not a replay — the user went back to the consent page and granted again,
   * and CI-Server issued a fresh single-use code — so it re-opens the attempt.
   */
  codeHash: string | null;
  /**
   * The redirect the consuming attempt actually resolved to, so a replay
   * repeats the real outcome instead of assuming success. Initialized to
   * `next` (the safe landing for a failed, deferred, or still-in-flight
   * attempt) and upgraded via {@link PendingConnectStore.recordOutcome} once
   * the attempt resolves to something else (the finishing interstitial).
   */
  redirect: string;
}

/**
 * `consumed` — this request owns the attempt and should run the exchange
 * (first consume of a live state, or a fresh consent grant on a consumed one).
 * `replayed` — the same request happened before: don't re-exchange, just send
 * the browser to the recorded `redirect`. `foreign` — the state exists but is
 * bound to a different Hub user; nothing is consumed and nothing about the
 * attempt is disclosed. `unknown` — never issued, or expired.
 */
export type ConsumeResult =
  | { outcome: 'consumed'; appUrn: AppUrn; next: string; userId: string; redirect: string }
  | { outcome: 'replayed'; appUrn: AppUrn; next: string; userId: string; redirect: string }
  | { outcome: 'foreign' }
  | { outcome: 'unknown' };

/**
 * In-memory store of in-flight connect attempts, keyed by a random `state`
 * nonce. This is the login-CSRF / code-injection guard for the cross-origin
 * hop: the Hub only accepts a callback whose `state` matches an attempt it
 * started, bound to the exact app URN AND the initiating user — a request from
 * any other user is `foreign` and leaves the attempt untouched, so it can
 * neither learn the destination nor burn the initiator's flow.
 *
 * Kept in memory deliberately — an attempt lives for a single browser round
 * trip (minutes). If the Hub restarts mid-flow the user simply retries; nothing
 * durable is lost (the durable credential is only written after a successful
 * exchange).
 *
 * A consumed entry leaves a tombstone recording the presented code (hashed)
 * and how the attempt resolved. A replay of the same code repeats the original
 * redirect — never a second exchange, and never a fabricated success for an
 * attempt that actually failed. A request with a DIFFERENT code re-opens the
 * attempt: the user denied (or hit an error) and then granted consent again
 * from the same consent page, and that fresh grant must be honored, not
 * swallowed as a replay.
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
   * Resolve a `state` nonce for the given user, optionally presenting the hash
   * of the one-time code the request carries.
   *
   * The first resolve of a live state by its initiating user consumes it
   * (`consumed`) and leaves a tombstone. Resolving again within
   * {@link TOMBSTONE_TTL_MS} with the SAME code (or none) reports `replayed`
   * with the recorded outcome; with a DIFFERENT code it re-opens the attempt as
   * `consumed` — a fresh consent grant carries a fresh single-use code. A
   * request from another user (or with no user at all — fail closed) is
   * `foreign` and consumes nothing. An expired pending entry is dropped WITHOUT
   * a tombstone — its flow never completed, so a later callback must read as
   * invalid, not as a replay of a success.
   */
  consume(state: string | undefined, userId: string, codeHash?: string): ConsumeResult {
    this.prune();

    if (!state) {
      return { outcome: 'unknown' };
    }

    if (!userId) {
      return { outcome: 'foreign' };
    }

    const entry = this.entries.get(state);

    if (entry) {
      if (entry.userId !== userId) {
        return { outcome: 'foreign' };
      }

      this.entries.delete(state);
      this.evictOldestIfFull(this.tombstones, MAX_TOMBSTONES);
      this.tombstones.set(state, {
        ...entry,
        codeHash: codeHash ?? null,
        redirect: entry.next,
        expiresAt: Date.now() + TOMBSTONE_TTL_MS,
      });

      return { outcome: 'consumed', appUrn: entry.appUrn, next: entry.next, userId: entry.userId, redirect: entry.next };
    }

    const tombstone = this.tombstones.get(state);

    if (tombstone) {
      if (tombstone.userId !== userId) {
        return { outcome: 'foreign' };
      }

      if (codeHash && codeHash !== tombstone.codeHash) {
        // A fresh single-use code on a consumed state: the user granted consent
        // again (deny → back → allow, or retry after a failed exchange). Re-open
        // the attempt so the new grant is exchanged rather than swallowed.
        tombstone.codeHash = codeHash;
        tombstone.redirect = tombstone.next;
        tombstone.expiresAt = Date.now() + TOMBSTONE_TTL_MS;

        return { outcome: 'consumed', appUrn: tombstone.appUrn, next: tombstone.next, userId: tombstone.userId, redirect: tombstone.next };
      }

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
   * repeat that exact redirect. A no-op if the tombstone has expired or been
   * evicted — the replay then falls back to the default (the app URL), which
   * is always a safe landing.
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
