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

interface PendingEntry {
  appUrn: AppUrn;
  /** Where to send the browser after the connection is applied. */
  next: string;
  expiresAt: number;
}

/**
 * In-memory store of in-flight connect attempts, keyed by a random `state`
 * nonce. This is the login-CSRF / code-injection guard for the cross-origin
 * hop: the Hub only accepts a callback whose `state` matches an attempt it
 * started, and binds it to the exact app URN.
 *
 * Kept in memory deliberately — an attempt lives for a single browser round
 * trip (minutes). If the Hub restarts mid-flow the user simply retries; nothing
 * durable is lost (the durable credential is only written after a successful
 * exchange). Entries are single-use.
 */
@Injectable()
export class PendingConnectStore {
  private readonly entries = new Map<string, PendingEntry>();

  /**
   * Start an attempt for `appUrn` and return the opaque `state` nonce to carry
   * through CI-Server and back.
   */
  create(appUrn: AppUrn, next: string): string {
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
    this.entries.set(state, { appUrn, next, expiresAt: Date.now() + PENDING_TTL_MS });

    return state;
  }

  /**
   * Consume a `state` nonce exactly once. Returns the bound attempt, or null if
   * the nonce is unknown or expired.
   */
  consume(state: string): { appUrn: AppUrn; next: string } | null {
    this.prune();

    const entry = this.entries.get(state);

    if (!entry) {
      return null;
    }

    this.entries.delete(state);

    if (entry.expiresAt < Date.now()) {
      return null;
    }

    return { appUrn: entry.appUrn, next: entry.next };
  }

  /** Drop expired entries so an abandoned flow never leaks memory. */
  private prune(): void {
    const now = Date.now();

    for (const [state, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(state);
      }
    }
  }
}
