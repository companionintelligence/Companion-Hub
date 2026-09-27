/**
 * Portal's pairing rate limit, as `cihub fleet install` reads and paces it.
 *
 * On 2026-09-26 a from-scratch rebuild paired ten nodes back to back and the next ones were refused
 * "Too many attempts. Try again in 51 seconds." — Portal allows ten pairings per ten minutes from
 * one address, and a fleet behind one NAT is one address. The run printed "Pairing failed" and moved
 * on. These tests pin what the run now knows about that answer, and that its default spacing keeps a
 * seventeen-node fleet under the limit where back to back does not.
 */
import { describe, expect, it } from 'vitest';
import { rateLimitedWaitCopy } from '../../packages/backend/src/common/helpers/retry-after.js';
import { box } from '../lib/cli-ui.js';
import { classifyPairingFailure } from '../lib/fleet-pairing-codes.js';
import {
  DEFAULT_PAIRING_GAP_MS,
  detectPairingRateLimit,
  MAX_RATE_LIMIT_WAIT_MS,
  type PacerClock,
  PairingPacer,
  PORTAL_PAIR_RATE_LIMIT,
  PortalRateLimitedError,
  portalRateLimitOf,
  rateLimitWaitMs,
  retryAfterSecondsFrom,
} from '../lib/portal-rate-limit.js';

/** What core-2's `hub up + register` printed, down to the box `cihub register` draws. */
const RATE_LIMITED = [
  'sync-postgres-password: Postgres password already matches env',
  'sync-rabbitmq-password: auth already matches RABBITMQ_PASSWORD',
  '┌─ Pairing ───────────────────┐',
  '  Submitting pairing code to the Hub…',
  '└─────────────────────────────┘',
  '┌─ Pairing failed ────────────┐',
  '  Too many attempts. Try again in 51 seconds.',
  '└─────────────────────────────┘',
].join('\n');

/** A clock that only moves when something sleeps on it or a test says so. */
function fakeClock(start = 1_000_000): PacerClock & { slept: number[]; advance: (ms: number) => void } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
}

describe('detectPairingRateLimit', () => {
  it("reads the Hub's relay of Portal's 429, with the delay it advertised", () => {
    expect(detectPairingRateLimit(RATE_LIMITED)).toEqual({ retryAfterSeconds: 51, said: 'Too many attempts. Try again in 51 seconds.' });
  });

  it('reads the copy the Hub uses when Portal sent no Retry-After, and waits a default for it', () => {
    const limit = detectPairingRateLimit(RATE_LIMITED.replace('Try again in 51 seconds.', 'Please wait a moment and try again.'));
    expect(limit).toEqual({ said: 'Too many attempts. Please wait a moment and try again.' });
    expect(rateLimitWaitMs(limit ?? { said: '' })).toBe(DEFAULT_PAIRING_GAP_MS);
  });

  it('reads the copy the Hub and `cihub register` actually print, so rewording either fails here first', () => {
    // The Hub's own helper and the CLI's own box, not a transcription of them: the node's text is
    // the only channel this signal has, and a reworded message would otherwise stop the retry silently.
    const withDelay = rateLimitedWaitCopy({ 'retry-after': '51' });
    expect(detectPairingRateLimit(box('Pairing failed', [withDelay], 'red'))).toEqual({ retryAfterSeconds: 51, said: withDelay });
    const withoutDelay = rateLimitedWaitCopy({});
    expect(detectPairingRateLimit(box('Pairing failed', [withoutDelay], 'red'))).toEqual({ said: withoutDelay });
  });

  it("reads a Hub older than that copy, which passed Portal's own body through", () => {
    expect(detectPairingRateLimit(RATE_LIMITED.replace('Too many attempts. Try again in 51 seconds.', 'Too many requests'))).toEqual({
      said: 'Too many requests',
    });
  });

  it("does not mistake Docker Hub's pull limit, before register ever ran, for Portal's", () => {
    const pullLimited = [
      'Error response from daemon: toomanyrequests: Too Many Requests. You have reached your pull rate limit.',
      'hub-up-failed: cihub up exited 1',
    ].join('\n');
    expect(detectPairingRateLimit(pullLimited)).toBeUndefined();
  });

  it('does not fire once Portal accepted the code, or on a refusal about the code itself', () => {
    expect(detectPairingRateLimit(`┌─ Pairing accepted ─┐\n  Provisioning tunnel and DNS\n└──┘\n${RATE_LIMITED}`)).toBeUndefined();
    expect(detectPairingRateLimit('┌─ Pairing failed ─┐\n  That pairing code is no longer valid. Ask for a new one.\n└──┘')).toBeUndefined();
  });

  it('is never read as a verdict on the code, so the kept code is neither dropped nor replaced', () => {
    expect(classifyPairingFailure(RATE_LIMITED)).toBeUndefined();
  });
});

describe('rateLimitWaitMs', () => {
  it('waits what Portal asked, plus a margin for the trip back', () => {
    expect(rateLimitWaitMs({ retryAfterSeconds: 51 })).toBe(56_000);
  });

  it("will wait out Portal's whole window, and not a second more", () => {
    expect(rateLimitWaitMs({ retryAfterSeconds: 600 })).toBe(MAX_RATE_LIMIT_WAIT_MS);
    expect(rateLimitWaitMs({ retryAfterSeconds: 601 })).toBeUndefined();
    expect(rateLimitWaitMs({ retryAfterSeconds: 3600 })).toBeUndefined();
  });
});

describe('retryAfterSecondsFrom', () => {
  it('takes the delta Portal sends, rounding up, or an HTTP date', () => {
    expect(retryAfterSecondsFrom(new Headers({ 'Retry-After': '51' }))).toBe(51);
    expect(retryAfterSecondsFrom(new Headers({ 'Retry-After': '9.2' }))).toBe(10);
    const now = Date.parse('2026-09-26T21:47:00Z');
    expect(retryAfterSecondsFrom(new Headers({ 'Retry-After': 'Sat, 26 Sep 2026 21:47:30 GMT' }), now)).toBe(30);
    expect(retryAfterSecondsFrom(new Headers({ 'Retry-After': 'soon' }))).toBeUndefined();
    expect(retryAfterSecondsFrom(new Headers())).toBeUndefined();
  });
});

describe('portalRateLimitOf', () => {
  it('recognises the typed refusal and nothing else', () => {
    const error = new PortalRateLimitedError({ retryAfterSeconds: 30, said: 'Too many requests' }, 'rate limited');
    expect(portalRateLimitOf(error)).toEqual({ retryAfterSeconds: 30, said: 'Too many requests' });
    expect(portalRateLimitOf(new Error('Too many requests'))).toBeUndefined();
  });
});

describe('DEFAULT_PAIRING_GAP_MS', () => {
  it("is Portal's window over its budget, plus the margin", () => {
    expect(PORTAL_PAIR_RATE_LIMIT).toEqual({ windowMs: 600_000, max: 10 });
    expect(DEFAULT_PAIRING_GAP_MS).toBe(65_000);
  });
});

describe('PairingPacer', () => {
  it('lets the first pairing go at once and holds the next until the gap has passed since the last one ended', async () => {
    const clock = fakeClock();
    const pacer = new PairingPacer(65_000, clock);
    expect(await pacer.waitTurn()).toBe(0);
    pacer.redeemed();
    clock.advance(20_000);
    expect(pacer.dueInMs()).toBe(45_000);
    expect(await pacer.waitTurn()).toBe(45_000);
    expect(clock.slept).toEqual([45_000]);
  });

  it('never waits with the spacing off', async () => {
    const clock = fakeClock();
    const pacer = new PairingPacer(0, clock);
    pacer.redeemed();
    expect(await pacer.waitTurn()).toBe(0);
    expect(clock.slept).toEqual([]);
  });

  it('holds every node for what Portal asked, and a hold never shortens the gap', () => {
    const clock = fakeClock();
    const pacer = new PairingPacer(65_000, clock);
    pacer.holdFor(56_000);
    expect(pacer.dueInMs()).toBe(56_000);
    pacer.redeemed();
    pacer.holdFor(10_000);
    expect(pacer.dueInMs()).toBe(65_000);
  });
});

/**
 * Portal's limiter, reduced to what decides the answer: a fixed window that opens at the first
 * pairing from an address, counts up to `max`, and refuses until it closes (CI-Portal
 * `consumeRateLimit`). A refused pairing is not counted.
 */
function portalLimiter() {
  let windowEnd = 0;
  let count = 0;
  return (at: number): boolean => {
    if (at >= windowEnd) {
      windowEnd = at + PORTAL_PAIR_RATE_LIMIT.windowMs;
      count = 0;
    }
    if (count >= PORTAL_PAIR_RATE_LIMIT.max) return false;
    count += 1;
    return true;
  };
}

/**
 * Seventeen nodes, serialised the way `fleet install` runs them: ten seconds of probe, preflight and
 * mint, then `hub up + register`, which pairs fifteen seconds in and ends five later. Returns the
 * nodes Portal refused.
 */
async function installSeventeen(gapMs: number): Promise<number[]> {
  const clock = fakeClock();
  const pacer = new PairingPacer(gapMs, clock);
  const allowed = portalLimiter();
  const refused: number[] = [];
  for (let node = 1; node <= 17; node++) {
    await clock.sleep(10_000);
    await pacer.waitTurn();
    if (!allowed(clock.now() + 15_000)) refused.push(node);
    await clock.sleep(20_000);
    pacer.redeemed();
  }
  return refused;
}

describe('a seventeen-node install against the limiter', () => {
  it('trips it back to back, as the rebuild on 2026-09-26 did', async () => {
    expect((await installSeventeen(0)).length).toBeGreaterThan(0);
  });

  it('stays under it at the default gap', async () => {
    expect(await installSeventeen(DEFAULT_PAIRING_GAP_MS)).toEqual([]);
  });
});
