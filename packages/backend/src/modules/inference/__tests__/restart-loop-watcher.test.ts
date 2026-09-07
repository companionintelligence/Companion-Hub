import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_RESTART_ALARM,
  EXTERNAL_RESTART_ALARM,
  RESTART_ALARM_ESCALATION_STEP,
  RESTART_ALARM_REPEAT_MS,
  RESTART_ALARM_WINDOW_MS,
} from '@/common/helpers/inference-supervision';
import { RestartLoopWatcher, type RestartSighting } from '../supervision/restart-loop-watcher';

function atClock(): { watcher: RestartLoopWatcher; advance: (ms: number) => void } {
  let now = 1_700_000_000_000;
  return {
    watcher: new RestartLoopWatcher(() => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function sighting(overrides: Partial<RestartSighting> = {}): RestartSighting {
  return {
    name: 'hub-tailscale',
    image: 'tailscale/tailscale:latest',
    restartCount: 0,
    restartPolicy: 'unless-stopped',
    state: 'restarting',
    ...overrides,
  };
}

describe('RestartLoopWatcher', () => {
  it('says nothing about a container that is not looping', () => {
    const { watcher } = atClock();
    expect(watcher.observe(sighting({ restartCount: 0 }))).toBeNull();
    expect(watcher.observe(sighting({ restartCount: 1 }))).toBeNull();
  });

  it('catches an already-huge restart count on the very first sighting', () => {
    // This is the whole point of the absolute rule. The fleet's `hub-tailscale` sat at
    // RestartCount=11463, respawning every ~60 s through an entire measurement window, and nobody
    // noticed. A delta-only detector that has itself restarted has no baseline and sees a large,
    // slowly rising number — which is precisely the "supervisor with no memory across its own
    // restarts" property that let the ~97,000-restart ollama loop accumulate unseen.
    const { watcher } = atClock();

    const decision = watcher.observe(sighting({ restartCount: 11463 }));

    expect(decision).not.toBeNull();
    expect(decision?.kind).toBe('absolute');
    expect(decision?.restartsSinceFirstSeen).toBeNull();
    expect(decision?.message).toContain('11463');
    expect(decision?.message).toContain('Something outside the Hub is looping it');
    expect(decision?.message).toContain('docker logs --tail 200 hub-tailscale');
  });

  it('alarms on a rate that accumulates while it is watching', () => {
    const { watcher, advance } = atClock();

    expect(watcher.observe(sighting({ restartCount: 2 }))).toBeNull();
    for (let step = 1; step < EXTERNAL_RESTART_ALARM; step += 1) {
      advance(30_000);
      expect(watcher.observe(sighting({ restartCount: 2 + step }))).toBeNull();
    }

    advance(30_000);
    const decision = watcher.observe(sighting({ restartCount: 2 + EXTERNAL_RESTART_ALARM }));
    expect(decision?.kind).toBe('rate');
    expect(decision?.restartsSinceFirstSeen).toBe(EXTERNAL_RESTART_ALARM);
  });

  it('does not invent a delta from a count it did not watch accumulate', () => {
    const { watcher } = atClock();
    // Below the absolute threshold, a first sighting is never an alarm however large the count.
    const decision = watcher.observe(sighting({ restartCount: ABSOLUTE_RESTART_ALARM - 1 }));
    expect(decision).toBeNull();
  });

  it('re-anchors a baseline that has aged out, so a rough life is not a loop', () => {
    const { watcher, advance } = atClock();

    watcher.observe(sighting({ restartCount: 1 }));
    advance(RESTART_ALARM_WINDOW_MS + 1);
    watcher.observe(sighting({ restartCount: 3 }));
    advance(60_000);

    // Four more since the re-anchor is still one short of the threshold, even though seven have
    // accumulated since the watcher first looked.
    expect(watcher.observe(sighting({ restartCount: 3 + EXTERNAL_RESTART_ALARM - 1 }))).toBeNull();
  });

  it('does not re-alarm on every tick for a loop it already reported', () => {
    const { watcher, advance } = atClock();

    expect(watcher.observe(sighting({ restartCount: 200 }))).not.toBeNull();
    advance(30_000);
    expect(watcher.observe(sighting({ restartCount: 201 }))).toBeNull();
    advance(30_000);
    expect(watcher.observe(sighting({ restartCount: 202 }))).toBeNull();
  });

  it('re-alarms once the repeat interval has elapsed', () => {
    const { watcher, advance } = atClock();

    watcher.observe(sighting({ restartCount: 200 }));
    advance(RESTART_ALARM_REPEAT_MS);
    expect(watcher.observe(sighting({ restartCount: 205 }))).not.toBeNull();
  });

  it('escalates early when the count keeps climbing hard', () => {
    const { watcher, advance } = atClock();

    watcher.observe(sighting({ restartCount: 200 }));
    advance(60_000);
    expect(watcher.observe(sighting({ restartCount: 200 + RESTART_ALARM_ESCALATION_STEP }))).not.toBeNull();
  });

  it('re-anchors when a container is recreated and its counter goes backwards', () => {
    const { watcher, advance } = atClock();

    watcher.observe(sighting({ restartCount: 40 }));
    advance(30_000);
    // `docker rm` + recreate resets dockerd's counter. A naive delta would report -40.
    expect(watcher.observe(sighting({ restartCount: 0 }))).toBeNull();
    expect(watcher.restartsSinceFirstSeen('hub-tailscale')).toBeNull();
  });

  it('forgets containers that no longer exist', () => {
    const { watcher, advance } = atClock();

    watcher.observe(sighting({ restartCount: 2 }));
    advance(30_000);
    watcher.observe(sighting({ restartCount: 4 }));
    expect(watcher.restartsSinceFirstSeen('hub-tailscale')).toBe(2);

    watcher.prune(new Set(['something-else']));
    expect(watcher.restartsSinceFirstSeen('hub-tailscale')).toBeNull();
  });
});
