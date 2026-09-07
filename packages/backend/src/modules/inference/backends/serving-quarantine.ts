/**
 * Per-model memory of "this engine says it has the model, but could not actually serve it".
 *
 * Reachability and serving-capability are different questions and only the first one is cheap.
 * `GET /api/tags` (and every other inventory endpoint) answers "is it on disk", which is what the
 * Hub needs for install badges and pull decisions — but a node can list a model and fail *every*
 * request for it. Observed on the fleet: core-4 answered `/api/tags` 200 with `gemma3:1b` while
 * every `/api/generate` came back HTTP 500 `model failed to load, this may be due to resource
 * limitations or an internal error`. Nothing short of attempting a load distinguishes that node
 * from a healthy one, and attempting a load on every health poll would pull every listed model
 * into VRAM on a 30-second cadence — so the evidence has to come from the requests that were going
 * to run anyway, and be remembered.
 *
 * The policy, and what each constant is buying:
 *
 * - {@link QUARANTINE_STRIKES} observations before anything is withheld. A single 5xx is not
 *   evidence of incapacity — a one-off OOM under concurrency looks identical — and the cost of
 *   over-reacting is a model that vanishes from routing while it was fine. A node that genuinely
 *   cannot load the model fails every request, so it reaches the threshold immediately anyway.
 * - {@link STRIKE_WINDOW_MS} forgets strikes that stop arriving. Two failures an hour apart are
 *   two blips, not a pattern.
 * - {@link BASE_QUARANTINE_MS} doubling to {@link MAX_QUARANTINE_MS} is the decay. Withholding is
 *   never permanent: the entry simply expires, the model is offered again, and the next request is
 *   the re-probe. A node that has really broken pays one failed request per (doubling) window
 *   instead of every request; a node whose blip is over is back immediately.
 *
 * Anything that proves the model *can* be served — a completed request, or the engine reporting it
 * resident — clears the entry outright, including the backoff. Recovery must not have to wait out
 * a penalty earned before the operator fixed the box.
 */

/** Consecutive observed serving failures before a model is withheld from routing. */
export const QUARANTINE_STRIKES = 2;
/** Strikes stop counting toward the threshold once the last one is this old. */
export const STRIKE_WINDOW_MS = 5 * 60_000;
/** How long the first quarantine withholds the model. */
export const BASE_QUARANTINE_MS = 60_000;
/** Ceiling on the doubling, so a node that comes back is re-probed at least this often. */
export const MAX_QUARANTINE_MS = 15 * 60_000;

interface QuarantineEntry {
  strikes: number;
  lastStrikeAt: number;
  /** Epoch ms until which the model is withheld; 0 while the entry is only accumulating strikes. */
  withheldUntil: number;
  /** Quarantines served without an intervening success — the exponent behind the backoff. */
  rounds: number;
  reason: string;
}

/** Result of {@link ServingQuarantine.recordFailure}, so the caller can log the transition once rather than on every strike. */
export interface QuarantineDecision {
  /** True only on the observation that flipped the model from offered to withheld. */
  withheld: boolean;
  /** How long the model is withheld for, in ms; 0 when this observation only added a strike. */
  forMs: number;
  strikes: number;
}

export class ServingQuarantine {
  private readonly entries = new Map<string, QuarantineEntry>();

  /**
   * Injected in tests — everything here is time-based and none of it is worth a real 15-minute
   * wait. The default reads `Date.now` through the global on every call rather than capturing the
   * function once, so a fake clock installed after construction still moves this class.
   */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Record that a request for `modelId` failed in a way that suggests this engine cannot serve it.
   *
   * `weight` is how many strikes the observation is worth: an ordinary failed request is 1, while
   * a failed *explicit load* is decisive on its own — `loadModel` asks the engine to do nothing but
   * load the model, so a server-side rejection there is the direct answer, not a hint.
   */
  recordFailure(modelId: string, reason: string, weight = 1): QuarantineDecision {
    const now = this.now();
    const existing = this.entries.get(modelId);
    // A strike older than the window is a blip we have already forgotten; `rounds` survives it,
    // because the backoff tracks how often this model has needed re-probing, not how recently.
    const withinWindow = existing !== undefined && now - existing.lastStrikeAt <= STRIKE_WINDOW_MS;
    const strikes = (withinWindow ? existing.strikes : 0) + weight;
    const rounds = existing?.rounds ?? 0;
    const withheldUntil = existing?.withheldUntil ?? 0;
    // A model that has been withheld once has spent its benefit of the doubt: the request that
    // re-probes it once the quarantine expires *is* the test, so one failure settles it.
    const threshold = rounds > 0 ? 1 : QUARANTINE_STRIKES;

    if (withheldUntil > now || strikes < threshold) {
      // Not enough evidence yet, or already withheld — a direct `loadModel` can still reach a model
      // routing is refusing to offer, and it must not extend the sentence it is re-probing.
      this.entries.set(modelId, { strikes, lastStrikeAt: now, withheldUntil, rounds, reason });
      return { withheld: false, forMs: 0, strikes };
    }

    // 2^rounds, capped: 60s, 2m, 4m, 8m, 15m, 15m…
    const forMs = Math.min(BASE_QUARANTINE_MS * 2 ** rounds, MAX_QUARANTINE_MS);
    this.entries.set(modelId, { strikes: 0, lastStrikeAt: now, withheldUntil: now + forMs, rounds: rounds + 1, reason });
    return { withheld: true, forMs, strikes };
  }

  /**
   * Record proof that `modelId` can be served — a completed request, or the engine reporting it
   * resident. Clears the strikes and the backoff alike; returns true when something was actually
   * cleared, so the caller can log a recovery rather than a no-op.
   */
  recordSuccess(modelId: string): boolean {
    return this.entries.delete(modelId);
  }

  /**
   * Whether `modelId` is currently withheld.
   *
   * An expired entry is not withheld but is kept: it still knows how many rounds this model has
   * been through, which is what makes the re-probe decisive. {@link prune} is what eventually
   * forgets it.
   */
  isWithheld(modelId: string): boolean {
    this.prune();
    const entry = this.entries.get(modelId);
    return entry !== undefined && entry.withheldUntil > this.now();
  }

  /** Every currently withheld model id. */
  list(): string[] {
    this.prune();
    const now = this.now();
    const withheld: string[] = [];
    for (const [modelId, entry] of this.entries) {
      if (entry.withheldUntil > now) {
        withheld.push(modelId);
      }
    }
    return withheld;
  }

  /** Why `modelId` was withheld, for a log line; undefined when it is not withheld. */
  reasonFor(modelId: string): string | undefined {
    return this.isWithheld(modelId) ? this.entries.get(modelId)?.reason : undefined;
  }

  /** True when nothing is being tracked at all — the check that keeps the extra probe off the common path. */
  isEmpty(): boolean {
    this.prune();
    return this.entries.size === 0;
  }

  /**
   * Forget entries that are neither withheld nor still inside their strike window. Such an entry
   * describes a model that has been on offer, unpunished, for {@link STRIKE_WINDOW_MS} — which is
   * the definition of no longer having evidence against it. Dropping it also takes the map, and the
   * `/api/ps` probe {@link isEmpty} gates, back to nothing on a node that had one bad afternoon.
   */
  private prune(): void {
    const now = this.now();
    for (const [modelId, entry] of this.entries) {
      if (entry.withheldUntil <= now && now - entry.lastStrikeAt > STRIKE_WINDOW_MS) {
        this.entries.delete(modelId);
      }
    }
  }
}
