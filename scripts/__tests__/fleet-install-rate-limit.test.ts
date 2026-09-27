/**
 * What `installNode` does when Portal refuses a pairing, or a mint, for rate — and how it spaces one
 * node's pairing after the last.
 *
 * On 2026-09-26 a fleet rebuild paired ten nodes back to back; core-2, core-4 and core-5 then
 * answered "Too many attempts. Try again in 51 seconds." The node's line said only "Pairing failed",
 * nothing waited, and the operator re-ran each one by hand about 65 s apart. A refusal for rate comes
 * from Portal's limiter, before its handler has looked at the code, so the right answer is to wait
 * what Portal asked and send the same code again: never a replacement, never a dropped code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readHostFacts: vi.fn(),
  preflightNode: vi.fn(),
  sshCapture: vi.fn(),
}));

vi.mock('../lib/fleet-hardware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-hardware.js')>()),
  readHostFacts: mocks.readHostFacts,
}));

vi.mock('../lib/fleet-preflight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-preflight.js')>()),
  preflightNode: mocks.preflightNode,
}));

vi.mock('../lib/fleet-ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-ssh.js')>()),
  sshCapture: mocks.sshCapture,
}));

import { describeStepFailure, installNode, type NodeInstallReport } from '../lib/fleet-install.js';
import { classifyPairingFailure } from '../lib/fleet-pairing-codes.js';
import { DEFAULT_PAIRING_GAP_MS, type PacerClock, PairingPacer, PORTAL_PAIR_RATE_LIMIT, PortalRateLimitedError } from '../lib/portal-rate-limit.js';

const linuxFacts = {
  os: 'linux',
  arch: 'x86_64',
  appleSilicon: false,
  cpuCount: 16,
  load1: 0.4,
  docker: { present: true, usable: true },
  gpus: [],
  enginesListening: [],
  notes: [],
};

const opts = { postgresPassword: 'a-long-enough-password', pairingCode: 'CODE01' };

/** core-2's `hub up + register`, 2026-09-26, as `cihub register` boxes it. */
const rateLimited = (seconds: number | undefined) =>
  [
    'sync-postgres-password: Postgres password already matches env',
    'sync-rabbitmq-password: auth already matches RABBITMQ_PASSWORD',
    '┌─ Pairing failed ─┐',
    seconds === undefined ? '  Too many attempts. Please wait a moment and try again.' : `  Too many attempts. Try again in ${seconds} seconds.`,
    '└──┘',
  ].join('\n');

const REFUSED = ['┌─ Pairing failed ─┐', '  That pairing code is no longer valid. Ask for a new one.', '└──┘'].join('\n');

/**
 * Portal's limiter failing closed: its D1 counter unreachable, it refuses the pair with 503
 * `Service temporarily unavailable` and `Retry-After: 5` before PairDevice runs. The Hub passes the
 * body of any non-429 through, without the header.
 */
const LIMITER_DOWN = ['┌─ Pairing failed ─┐', '  Service temporarily unavailable', '└──┘'].join('\n');

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

/** The codes `cihub register` was actually run with, in order. */
const codesSent = (): string[] =>
  mocks.sshCapture.mock.calls
    .map(([, script]) => /cihub register --code '([^']*)'/.exec(String(script))?.[1])
    .filter((code): code is string => !!code);

/** A node with a cihub already on it, so the run reaches `register`; `register` then says `says`, in turn. */
function nodeWhoseRegisterSays(...says: string[]): void {
  let attempt = 0;
  mocks.sshCapture.mockImplementation(async (_target: unknown, script: string) => {
    if (script.includes('command -v cihub')) return { ok: true, out: 'path=/usr/bin/cihub\ncihub 0.2.76\n', err: '', code: 0, ms: 1 };
    if (script.includes('cihub register')) {
      const out = says[Math.min(attempt, says.length - 1)] ?? '';
      attempt += 1;
      return out === 'ok'
        ? { ok: true, out: '{"registered":true}\nhub-up-complete\n', err: '', code: 0, ms: 1 }
        : { ok: false, out, err: '', code: 1, ms: 1 };
    }
    // Claim, timers and cert are not this test's business; failing them keeps the run short.
    return { ok: false, out: '', err: 'not part of this test', code: 1, ms: 1 };
  });
}

beforeEach(() => {
  mocks.readHostFacts.mockReset().mockResolvedValue({ facts: linuxFacts });
  mocks.preflightNode
    .mockReset()
    .mockImplementation(async (_t: unknown, n: { name: string }) => ({ node: n.name, findings: [], verdict: 'ok', ms: 1 }));
  mocks.sshCapture.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('a pairing Portal refused for rate', () => {
  it('waits what Portal asked and sends the same code again, and the node counts as installed', async () => {
    nodeWhoseRegisterSays(rateLimited(51), 'ok');
    const clock = fakeClock();
    const progress: string[] = [];
    const replacePairingCode = vi.fn();
    const report = await installNode(
      { name: 'core-2', ip: '10.0.0.2' },
      { ...opts, replacePairingCode, pairingPacer: new PairingPacer(65_000, clock), onProgress: (line) => progress.push(line) },
      'ci',
    );

    expect(codesSent()).toEqual(['CODE01', 'CODE01']);
    expect(clock.slept).toEqual([56_000]);
    expect(replacePairingCode).not.toHaveBeenCalled();
    // The wait is on screen while it happens, not only in the report printed afterwards.
    expect(progress).toEqual([expect.stringMatching(/^waiting 56s before pairing — .*Too many attempts\. Try again in 51 seconds\..*retry 1 of 3/)]);
    const wait = report.steps.find((s) => s.name === 'pairing rate limit');
    expect(wait).toMatchObject({ ok: true, skipped: true, ms: 56_000 });
    expect(report.steps.find((s) => s.name === 'hub up + register')).toMatchObject({ ok: true });
    // The steps after register failed on purpose here; what matters is that the refusal is not one.
    expect(report.steps.filter((s) => s.name.startsWith('hub up') && !s.ok)).toEqual([]);
  });

  it('stops after three waits, says the code is still good, and nothing reads that as a dead code', async () => {
    nodeWhoseRegisterSays(rateLimited(51));
    const clock = fakeClock();
    const replacePairingCode = vi.fn();
    const report = await installNode(
      { name: 'core-4', ip: '10.0.0.4' },
      { ...opts, replacePairingCode, pairingPacer: new PairingPacer(65_000, clock) },
      'ci',
    );

    expect(codesSent()).toEqual(['CODE01', 'CODE01', 'CODE01', 'CODE01']);
    expect(clock.slept).toEqual([56_000, 56_000, 56_000]);
    expect(replacePairingCode).not.toHaveBeenCalled();
    expect(report.ok).toBe(false);
    const last = report.steps.at(-1);
    expect(last).toMatchObject({ name: 'hub up + register', ok: false });
    expect(last?.detail).toContain('Too many attempts. Try again in 51 seconds.');
    expect(last?.detail).toMatch(/still good: rerun this node \(--nodes core-4\)/);
    // `fleet install` drops a kept code whose register step classifies; this one must survive.
    expect(classifyPairingFailure(last?.detail ?? '')).toBeUndefined();
  });

  it('holds the next node for the same wait, since the two share an address', async () => {
    nodeWhoseRegisterSays(rateLimited(51));
    const clock = fakeClock();
    const pacer = new PairingPacer(0, clock);
    await installNode({ name: 'core-4', ip: '10.0.0.4' }, { ...opts, pairingPacer: pacer }, 'ci');
    expect(pacer.dueInMs()).toBe(56_000);
  });

  it('waits the default gap when the Hub relayed no delay', async () => {
    nodeWhoseRegisterSays(rateLimited(undefined), 'ok');
    const clock = fakeClock();
    await installNode({ name: 'core-5', ip: '10.0.0.5' }, { ...opts, pairingPacer: new PairingPacer(0, clock) }, 'ci');
    expect(clock.slept).toEqual([65_000]);
    expect(codesSent()).toEqual(['CODE01', 'CODE01']);
  });

  it("does not sit through a wait longer than Portal's own window, and says why", async () => {
    nodeWhoseRegisterSays(rateLimited(3600), 'ok');
    const clock = fakeClock();
    const report = await installNode({ name: 'core-5', ip: '10.0.0.5' }, { ...opts, pairingPacer: new PairingPacer(0, clock) }, 'ci');
    expect(clock.slept).toEqual([]);
    expect(codesSent()).toEqual(['CODE01']);
    expect(report.steps.at(-1)?.detail).toMatch(/Portal asked for 3600s, more than the 600s window/);
  });

  // A regression guard, not coverage for the fix: this passes before and after it.
  it('regression guard: a refusal about the code itself still goes to replacePairingCode', async () => {
    nodeWhoseRegisterSays(REFUSED, 'ok');
    const replacePairingCode = vi.fn().mockResolvedValue({ code: 'FRESH1', detail: 'a fresh code' });
    await installNode({ name: 'beta-max', ip: '10.0.0.7' }, { ...opts, replacePairingCode, pairingPacer: new PairingPacer(0, fakeClock()) }, 'ci');
    expect(replacePairingCode).toHaveBeenCalledTimes(1);
    expect(codesSent()).toEqual(['CODE01', 'FRESH1']);
  });
});

describe("a pairing Portal's limiter refused because it was down", () => {
  it('waits the five seconds Portal gives it and sends the same code again, and the node counts as installed', async () => {
    nodeWhoseRegisterSays(LIMITER_DOWN, 'ok');
    const clock = fakeClock();
    const progress: string[] = [];
    const replacePairingCode = vi.fn();
    const report = await installNode(
      { name: 'core-3', ip: '10.0.0.3' },
      { ...opts, replacePairingCode, pairingPacer: new PairingPacer(0, clock), onProgress: (line) => progress.push(line) },
      'ci',
    );

    expect(codesSent()).toEqual(['CODE01', 'CODE01']);
    expect(clock.slept).toEqual([10_000]);
    expect(replacePairingCode).not.toHaveBeenCalled();
    expect(progress).toEqual([expect.stringMatching(/^waiting 10s before pairing — Portal's rate limiter could not reach its counter/)]);
    expect(report.steps.find((s) => s.name === 'hub up + register')).toMatchObject({ ok: true });
    expect(report.steps.filter((s) => s.name.startsWith('hub up') && !s.ok)).toEqual([]);
  });

  it('gives up after three short waits, keeps the code, and says what Portal said', async () => {
    nodeWhoseRegisterSays(LIMITER_DOWN);
    const clock = fakeClock();
    const replacePairingCode = vi.fn();
    const report = await installNode(
      { name: 'core-3', ip: '10.0.0.3' },
      { ...opts, replacePairingCode, pairingPacer: new PairingPacer(0, clock) },
      'ci',
    );

    expect(codesSent()).toEqual(['CODE01', 'CODE01', 'CODE01', 'CODE01']);
    expect(clock.slept).toEqual([10_000, 10_000, 10_000]);
    expect(replacePairingCode).not.toHaveBeenCalled();
    const last = report.steps.at(-1);
    expect(last).toMatchObject({ name: 'hub up + register', ok: false });
    expect(last?.detail).toContain('Service temporarily unavailable');
    expect(last?.detail).toMatch(/rate limiter was still unavailable after 3 wait\(s\).*still good: rerun this node \(--nodes core-3\)/);
    expect(classifyPairingFailure(last?.detail ?? '')).toBeUndefined();
  });
});

describe('a run whose pairings Portal keeps refusing', () => {
  it('says to stop once two nodes in a row have given up, naming them', async () => {
    nodeWhoseRegisterSays(rateLimited(51));
    const pacer = new PairingPacer(0, fakeClock());
    await installNode({ name: 'core-2', ip: '10.0.0.2' }, { ...opts, pairingPacer: pacer }, 'ci');
    expect(pacer.stopReason()).toBeUndefined();
    await installNode({ name: 'core-4', ip: '10.0.0.4' }, { ...opts, pairingPacer: pacer }, 'ci');
    expect(pacer.stopReason()).toMatch(/^Portal kept refusing core-2, core-4, one after the other, before it looked at their codes/);
  });

  it('counts a mint that stayed refused, since the next node mints from the same address', async () => {
    nodeWhoseRegisterSays('ok');
    const pacer = new PairingPacer(0, fakeClock());
    const mintPairingCode = vi
      .fn()
      .mockRejectedValue(
        new PortalRateLimitedError({ retryAfterSeconds: 30, said: 'Too many requests' }, 'Portal is rate-limiting device registration'),
      );
    for (const name of ['core-6', 'core-7']) {
      await installNode(
        { name, ip: `10.0.0.${name.slice(-1)}` },
        { postgresPassword: opts.postgresPassword, mintPairingCode, pairingPacer: pacer },
        'ci',
      );
    }
    expect(pacer.stopReason()).toMatch(/core-6, core-7/);
  });

  it('starts counting again after a node registers', async () => {
    nodeWhoseRegisterSays(rateLimited(51), rateLimited(51), rateLimited(51), rateLimited(51), 'ok', rateLimited(51));
    const pacer = new PairingPacer(0, fakeClock());
    for (const name of ['core-2', 'core-4', 'core-5'])
      await installNode({ name, ip: `10.0.0.${name.slice(-1)}` }, { ...opts, pairingPacer: pacer }, 'ci');
    // core-2 gave up, core-4 registered, core-5 gave up: never two in a row.
    expect(pacer.stopReason()).toBeUndefined();
  });
});

/**
 * Portal's pair limiter as CI-Portal `consumeRateLimit` decides it: a fixed window that opens at the
 * first pairing from an address and closes `windowMs` later, `max` pairings in it, a refusal not
 * counted, and `Retry-After` the seconds left in the window, rounded up.
 */
function portalPairLimiter() {
  let windowEnd = Number.NEGATIVE_INFINITY;
  let count = 0;
  return (at: number): { allowed: true } | { allowed: false; retryAfterSeconds: number } => {
    if (at >= windowEnd) {
      windowEnd = at + PORTAL_PAIR_RATE_LIMIT.windowMs;
      count = 0;
    }
    if (count >= PORTAL_PAIR_RATE_LIMIT.max) return { allowed: false, retryAfterSeconds: Math.ceil((windowEnd - at) / 1000) };
    count += 1;
    return { allowed: true };
  };
}

/**
 * Every node's `hub up + register` against that limiter, on the test's clock: ten seconds of probe
 * and preflight, then fifteen of `cihub up` before the pair, and five after it. What each attempt
 * sent and what Portal answered is kept, in order.
 */
function fleetBehindPortal(clock: ReturnType<typeof fakeClock>, pair: ReturnType<typeof portalPairLimiter>) {
  const attempts: { code: string; allowed: boolean }[] = [];
  mocks.sshCapture.mockImplementation(async (_target: unknown, script: string) => {
    if (script.includes('command -v cihub')) {
      clock.advance(10_000);
      return { ok: true, out: 'path=/usr/bin/cihub\ncihub 0.2.76\n', err: '', code: 0, ms: 1 };
    }
    const code = /cihub register --code '([^']*)'/.exec(script)?.[1];
    if (code) {
      clock.advance(15_000);
      const answer = pair(clock.now());
      clock.advance(5_000);
      attempts.push({ code, allowed: answer.allowed });
      return answer.allowed
        ? { ok: true, out: '{"registered":true}\nhub-up-complete\n', err: '', code: 0, ms: 1 }
        : { ok: false, out: rateLimited(answer.retryAfterSeconds), err: '', code: 1, ms: 1 };
    }
    return { ok: false, out: '', err: 'not part of this test', code: 1, ms: 1 };
  });
  return attempts;
}

/** Seventeen nodes, one after the other on one pacer, the way `fleet install` runs them. */
async function installSeventeen(pacer: PairingPacer, replacePairingCode = vi.fn()): Promise<NodeInstallReport[]> {
  const reports: NodeInstallReport[] = [];
  for (let i = 1; i <= 17; i++) {
    const code = `CODE${String(i).padStart(2, '0')}`;
    reports.push(
      await installNode({ name: `node-${i}`, ip: `10.0.2.${i}` }, { ...opts, pairingCode: code, replacePairingCode, pairingPacer: pacer }, 'ci'),
    );
  }
  return reports;
}

const registered = (report: NodeInstallReport) => report.steps.find((s) => s.name === 'hub up + register')?.ok === true;

describe("seventeen nodes through installNode against Portal's limiter", () => {
  it('stays under it at the default gap: no refusal, and every node registers with its own code, once', async () => {
    const clock = fakeClock();
    const attempts = fleetBehindPortal(clock, portalPairLimiter());
    const reports = await installSeventeen(new PairingPacer(DEFAULT_PAIRING_GAP_MS, clock));

    expect(attempts.filter((a) => !a.allowed)).toEqual([]);
    expect(attempts.map((a) => a.code)).toEqual(Array.from({ length: 17 }, (_, i) => `CODE${String(i + 1).padStart(2, '0')}`));
    expect(reports.every(registered)).toBe(true);
  });

  it('back to back, trips it as the 2026-09-26 rebuild did, waits out what Portal asked, and still registers every node with its own code', async () => {
    const clock = fakeClock();
    const attempts = fleetBehindPortal(clock, portalPairLimiter());
    const replacePairingCode = vi.fn();
    const started = clock.now();
    const reports = await installSeventeen(new PairingPacer(0, clock), replacePairingCode);
    const backToBackMs = clock.now() - started;

    // The eleventh is refused with the rest of the window, waits it out, and the same code goes again.
    expect(attempts.filter((a) => !a.allowed).map((a) => a.code)).toEqual(['CODE11']);
    expect(attempts.filter((a) => a.allowed).map((a) => a.code)).toEqual(
      Array.from({ length: 17 }, (_, i) => `CODE${String(i + 1).padStart(2, '0')}`),
    );
    expect(reports.every(registered)).toBe(true);
    expect(replacePairingCode).not.toHaveBeenCalled();

    // The trade the default makes, measured on the same model: spacing costs more time than the one
    // wait it avoids, in exchange for leaving the address's budget for anything else on the network.
    const pacedClock = fakeClock();
    fleetBehindPortal(pacedClock, portalPairLimiter());
    const pacedStarted = pacedClock.now();
    await installSeventeen(new PairingPacer(DEFAULT_PAIRING_GAP_MS, pacedClock));
    expect(pacedClock.now() - pacedStarted).toBeGreaterThan(backToBackMs);
  });

  it('waits out a window someone else on the network already filled, then registers', async () => {
    const clock = fakeClock();
    const pair = portalPairLimiter();
    for (let i = 0; i < PORTAL_PAIR_RATE_LIMIT.max; i++) pair(clock.now());
    const attempts = fleetBehindPortal(clock, pair);
    const reports = await installSeventeen(new PairingPacer(DEFAULT_PAIRING_GAP_MS, clock));

    expect(attempts[0]).toEqual({ code: 'CODE01', allowed: false });
    expect(attempts[1]).toEqual({ code: 'CODE01', allowed: true });
    expect(reports[0]?.steps.find((s) => s.name === 'pairing rate limit')?.ms).toBe(580_000);
    expect(reports.every(registered)).toBe(true);
  });
});

describe('pairings across nodes', () => {
  it("waits out the rest of the gap since the last node's pairing ended, and says so", async () => {
    nodeWhoseRegisterSays('ok');
    const clock = fakeClock();
    const pacer = new PairingPacer(65_000, clock);
    const progress: string[] = [];
    const first = await installNode({ name: 'beta-1', ip: '10.0.1.1' }, { ...opts, pairingPacer: pacer }, 'ci');
    expect(first.steps.map((s) => s.name)).not.toContain('pairing pace');
    expect(clock.slept).toEqual([]);

    clock.advance(20_000);
    const second = await installNode(
      { name: 'beta-3-glass', ip: '10.0.1.3' },
      { ...opts, pairingCode: 'CODE02', pairingPacer: pacer, onProgress: (line) => progress.push(line) },
      'ci',
    );
    expect(clock.slept).toEqual([45_000]);
    expect(progress).toEqual([expect.stringMatching(/^waiting 45s before pairing — Portal allows 10 pairings per 10 minutes/)]);
    const names = second.steps.map((s) => s.name);
    expect(names.indexOf('pairing pace')).toBe(names.indexOf('hub up + register') - 1);
    expect(second.steps.find((s) => s.name === 'pairing pace')).toMatchObject({ ok: true, skipped: true, ms: 45_000 });
  });
});

describe('a mint Portal refused for rate', () => {
  it('is waited out and minted again, since Portal created no device', async () => {
    nodeWhoseRegisterSays('ok');
    const clock = fakeClock();
    const mintPairingCode = vi
      .fn()
      .mockRejectedValueOnce(
        new PortalRateLimitedError({ retryAfterSeconds: 30, said: 'Too many requests' }, 'Portal is rate-limiting device registration'),
      )
      .mockResolvedValueOnce({ code: 'MINT01', detail: 'registered as core-6' });
    const progress: string[] = [];
    const report = await installNode(
      { name: 'core-6', ip: '10.0.0.6' },
      {
        postgresPassword: opts.postgresPassword,
        mintPairingCode,
        pairingPacer: new PairingPacer(0, clock),
        onProgress: (line) => progress.push(line),
      },
      'ci',
    );

    expect(mintPairingCode).toHaveBeenCalledTimes(2);
    expect(clock.slept).toEqual([35_000]);
    expect(progress).toEqual([expect.stringMatching(/^waiting 35s before minting again/)]);
    expect(report.steps.find((s) => s.name === 'portal device')).toMatchObject({ ok: true, detail: 'registered as core-6' });
    expect(codesSent()).toEqual(['MINT01']);
  });

  it('gives up after three waits without minting anything else', async () => {
    nodeWhoseRegisterSays('ok');
    const clock = fakeClock();
    const mintPairingCode = vi
      .fn()
      .mockRejectedValue(
        new PortalRateLimitedError({ retryAfterSeconds: 30, said: 'Too many requests' }, 'Portal is rate-limiting device registration'),
      );
    const report = await installNode(
      { name: 'core-6', ip: '10.0.0.6' },
      { postgresPassword: opts.postgresPassword, mintPairingCode, pairingPacer: new PairingPacer(0, clock) },
      'ci',
    );

    expect(mintPairingCode).toHaveBeenCalledTimes(4);
    expect(clock.slept).toEqual([35_000, 35_000, 35_000]);
    expect(codesSent()).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ name: 'portal device', ok: false });
    expect(report.steps.at(-1)?.detail).toMatch(/created none here, so rerun this node later/);
  });

  // A regression guard, not coverage for the fix: this passes before and after it.
  it('regression guard: any other mint failure still ends the node, without waiting', async () => {
    nodeWhoseRegisterSays('ok');
    const clock = fakeClock();
    const mintPairingCode = vi.fn().mockRejectedValue(new Error('a device named "core-6" already exists in this org'));
    const report = await installNode(
      { name: 'core-6', ip: '10.0.0.6' },
      { postgresPassword: opts.postgresPassword, mintPairingCode, pairingPacer: new PairingPacer(0, clock) },
      'ci',
    );
    expect(mintPairingCode).toHaveBeenCalledTimes(1);
    expect(clock.slept).toEqual([]);
    expect(report.steps.at(-1)).toMatchObject({ name: 'portal device', ok: false, detail: 'a device named "core-6" already exists in this org' });
  });
});

describe('describeStepFailure on a refusal for rate', () => {
  it('keeps the line that says how long to wait, not just the box title', () => {
    expect(describeStepFailure(rateLimited(51), '', { code: 1, marker: 'hub-up-complete' })).toContain('Too many attempts. Try again in 51 seconds.');
  });
});
