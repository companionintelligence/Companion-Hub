import {
  ABSOLUTE_RESTART_ALARM,
  EXTERNAL_RESTART_ALARM,
  RESTART_ALARM_ESCALATION_STEP,
  RESTART_ALARM_REPEAT_MS,
  RESTART_ALARM_WINDOW_MS,
} from '@/common/helpers/inference-supervision';

/** What one tick observed about one container. */
export interface RestartSighting {
  name: string;
  image: string;
  /** dockerd's own `RestartCount`, which survives Hub restarts because dockerd owns it. */
  restartCount: number;
  restartPolicy: string | null;
  state: string;
}

export interface RestartLoopDecision {
  /** Which rule fired. See the class comment for why both exist. */
  kind: 'absolute' | 'rate';
  restartCount: number;
  /** Restarts accumulated since this watcher first saw the container; `null` on the first sighting. */
  restartsSinceFirstSeen: number | null;
  message: string;
}

interface WatchEntry {
  /** `RestartCount` when the current measurement window opened. */
  baselineCount: number;
  baselineAt: number;
  lastCount: number;
  lastAlarmAt: number | null;
  lastAlarmCount: number | null;
}

/**
 * Detects a container that *something else* is restarting in a loop.
 *
 * Two rules, and the second one is the point:
 *
 * - **Rate.** {@link EXTERNAL_RESTART_ALARM} restarts accumulated inside
 *   {@link RESTART_ALARM_WINDOW_MS} while this Hub was watching. Precise, and useless on the first
 *   sweep after boot, because a delta needs a baseline.
 * - **Absolute.** A `RestartCount` at or above {@link ABSOLUTE_RESTART_ALARM} at all, with no
 *   history required. This is the rule that catches the failure this layer exists for: the fleet's
 *   `hub-tailscale` sat at `RestartCount=11463`, respawning every ~60 s, and every delta-based
 *   detector that had itself restarted in the meantime saw a container whose count was simply large
 *   and rising slowly. dockerd's counter is durable even when the observer's memory is not, so the
 *   large number *is* the evidence, and it is legible on the first look.
 *
 * A container that vanishes is forgotten by {@link prune}; a container whose count goes *backwards*
 * has been recreated, and its baseline is re-anchored rather than producing a negative delta.
 *
 * Deliberately shaped like `backends/serving-quarantine.ts` — a plain class, not `@Injectable`,
 * with the clock injected as a default parameter that reads `Date.now` through the global on every
 * call so a fake clock installed after construction still moves it.
 */
export class RestartLoopWatcher {
  private readonly entries = new Map<string, WatchEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Record one sighting and say whether it should raise an alarm *now*.
   *
   * Returns `null` when there is nothing to say — which is the overwhelmingly common case, and
   * includes a container that is looping but has already been alarmed about recently. Repeat
   * alarms are spaced by {@link RESTART_ALARM_REPEAT_MS} so a week-long loop writes about 168
   * event-log rows instead of one per tick, and escalate early if the count climbs another
   * {@link RESTART_ALARM_ESCALATION_STEP} in the meantime.
   */
  observe(sighting: RestartSighting): RestartLoopDecision | null {
    const now = this.now();
    const existing = this.entries.get(sighting.name);

    let entry: WatchEntry;
    let restartsSinceFirstSeen: number | null;

    if (!existing || sighting.restartCount < existing.lastCount) {
      // First sighting, or the container was recreated (dockerd resets RestartCount with the
      // container). Either way there is no measured delta yet, and inventing one from a count we
      // did not watch accumulate would be the delta-detector's original sin.
      entry = { baselineCount: sighting.restartCount, baselineAt: now, lastCount: sighting.restartCount, lastAlarmAt: null, lastAlarmCount: null };
      restartsSinceFirstSeen = null;
    } else {
      entry = { ...existing, lastCount: sighting.restartCount };
      if (now - entry.baselineAt > RESTART_ALARM_WINDOW_MS) {
        // Re-anchor: restarts spread across many hours are a rough life, not a loop.
        entry.baselineCount = sighting.restartCount;
        entry.baselineAt = now;
      }
      restartsSinceFirstSeen = sighting.restartCount - entry.baselineCount;
    }

    this.entries.set(sighting.name, entry);

    const absolute = sighting.restartCount >= ABSOLUTE_RESTART_ALARM;
    const rate = restartsSinceFirstSeen !== null && restartsSinceFirstSeen >= EXTERNAL_RESTART_ALARM;
    if (!absolute && !rate) {
      return null;
    }

    if (!this.shouldAlarmAgain(entry, sighting.restartCount, now)) {
      return null;
    }

    entry.lastAlarmAt = now;
    entry.lastAlarmCount = sighting.restartCount;
    this.entries.set(sighting.name, entry);

    const kind: 'absolute' | 'rate' = absolute ? 'absolute' : 'rate';
    return {
      kind,
      restartCount: sighting.restartCount,
      restartsSinceFirstSeen,
      message: buildMessage(sighting, kind, restartsSinceFirstSeen),
    };
  }

  /** Restarts accumulated since this watcher first saw the container; `null` before a second sighting. */
  restartsSinceFirstSeen(name: string): number | null {
    const entry = this.entries.get(name);
    if (!entry) return null;
    const delta = entry.lastCount - entry.baselineCount;
    return delta > 0 ? delta : null;
  }

  /** Forget every container not in `names` — they no longer exist on this daemon. */
  prune(names: ReadonlySet<string>): void {
    for (const name of this.entries.keys()) {
      if (!names.has(name)) {
        this.entries.delete(name);
      }
    }
  }

  private shouldAlarmAgain(entry: WatchEntry, restartCount: number, now: number): boolean {
    if (entry.lastAlarmAt === null || entry.lastAlarmCount === null) return true;
    if (now - entry.lastAlarmAt >= RESTART_ALARM_REPEAT_MS) return true;
    return restartCount - entry.lastAlarmCount >= RESTART_ALARM_ESCALATION_STEP;
  }
}

function buildMessage(sighting: RestartSighting, kind: 'absolute' | 'rate', restartsSinceFirstSeen: number | null): string {
  const policy = sighting.restartPolicy ? `restart policy "${sighting.restartPolicy}"` : 'no restart policy reported';
  const observed =
    kind === 'absolute'
      ? `has been restarted ${sighting.restartCount} times`
      : `has been restarted ${restartsSinceFirstSeen} times in the last hour (${sighting.restartCount} in total)`;
  return (
    `Container ${sighting.name} (${sighting.image}) ${observed}. It is currently "${sighting.state}" with ${policy}. ` +
    'Something outside the Hub is looping it — the Hub never restarts containers. ' +
    `Inspect it with: docker inspect ${sighting.name} and docker logs --tail 200 ${sighting.name}`
  );
}
