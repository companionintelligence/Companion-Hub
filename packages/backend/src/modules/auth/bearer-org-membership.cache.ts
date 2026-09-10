import { Injectable } from '@nestjs/common';

/** How long a Portal org-membership verdict is reused for a Bearer subject (CI-Hub#1333). */
const TTL_MS = 60_000;
/** Bound on remembered verdicts so a stream of distinct Portal subjects cannot grow the map forever. */
const MAX_ENTRIES = 1_000;

/**
 * Portal org-membership verdicts for Traefik forward-auth Bearer subjects.
 *
 * A provider rather than a field on `AuthController` for one reason that matters: `FactoryReset`
 * unbinds this appliance from its organisation, and it revokes cached authority by clearing the
 * stores it can reach. A private Map on a controller is not one of them, so a subject cached as
 * allowed seconds before the reset would keep passing forward-auth until its TTL ran out, on an
 * appliance that no longer belongs to the org that vouched for them.
 *
 * In memory rather than `CacheService` because this is read on every forwarded app request and
 * `CacheService` is synchronous SQLite — the same reason `ForwardAuthSecretResolver` keeps its own
 * Map — and because a verdict about a live Portal membership should not outlive the process that
 * learned it.
 */
@Injectable()
export class BearerOrgMembershipCache {
  private readonly verdicts = new Map<string, { allowed: boolean; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<'member' | 'not-member' | 'unknown'>>();

  /** The remembered verdict for a subject, or `undefined` when there is none or it has expired. */
  get(subject: string): boolean | undefined {
    const remembered = this.verdicts.get(subject);
    if (!remembered) {
      return undefined;
    }
    if (remembered.expiresAt <= Date.now()) {
      this.verdicts.delete(subject);
      return undefined;
    }
    return remembered.allowed;
  }

  /**
   * Remember a settled verdict. Only ever called for `member` / `not-member`: "could not tell" must
   * not be written down, or one Portal wobble becomes a lockout for the whole TTL.
   */
  set(subject: string, allowed: boolean): void {
    // Read the clock HERE, not before the lookup that produced this verdict: a Portal round trip can
    // take its full 10s timeout, and a TTL measured from before it would arrive already spent.
    const now = Date.now();

    if (this.verdicts.size >= MAX_ENTRIES && !this.verdicts.has(subject)) {
      for (const [key, entry] of this.verdicts) {
        if (entry.expiresAt <= now) {
          this.verdicts.delete(key);
        }
      }
      // Still full of live entries: drop the oldest insertion rather than growing without bound.
      const oldest = this.verdicts.keys().next();
      if (this.verdicts.size >= MAX_ENTRIES && !oldest.done) {
        this.verdicts.delete(oldest.value);
      }
    }

    this.verdicts.set(subject, { allowed, expiresAt: now + TTL_MS });
  }

  /**
   * Run `lookup` for this subject, or join the one already running for it.
   *
   * The verdict cache only helps AFTER the first answer comes back, so a cold-start burst from one
   * machine client would otherwise fan out into one Portal round trip per in-flight request —
   * exactly the traffic the cache exists to prevent. Bounded like the verdict map: during a Portal
   * stall every entry is pinned for the full timeout, so an unbounded map here would be the growth
   * `MAX_ENTRIES` prevents on the other one. Over the cap, callers run their own lookup rather than
   * joining — correct, just not deduplicated.
   */
  async coalesce(subject: string, lookup: () => Promise<'member' | 'not-member' | 'unknown'>): Promise<'member' | 'not-member' | 'unknown'> {
    const existing = this.inFlight.get(subject);
    if (existing) {
      return existing;
    }
    if (this.inFlight.size >= MAX_ENTRIES) {
      return lookup();
    }

    const pending = lookup().finally(() => {
      this.inFlight.delete(subject);
    });
    this.inFlight.set(subject, pending);
    return pending;
  }

  /**
   * Drop every remembered verdict. Called by factory reset, where the appliance is being unbound
   * from the organisation these verdicts were granted against — in-flight lookups are left alone
   * because they resolve against `AuthService`, which reads the (now absent) registration row.
   */
  clear(): void {
    this.verdicts.clear();
  }
}
