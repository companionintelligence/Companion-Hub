/**
 * What `installNode` does when `register` comes back complaining about the code it was given.
 *
 * On 2026-09-22 a `cihub fleet install` across eighteen nodes failed on fifteen of them with one
 * `410 PAIRING_CODE_INVALID` apiece, and the two retries that followed sent every node the same dead
 * code again — the second and third runs were identical to the first, down to the mint timestamp on
 * the line (CI-Hub#1582). These tests are that run: a refused code earns exactly one replacement, a
 * code Portal already claimed earns none, and a failure that was never about the code leaves the
 * code alone.
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

import { installNode } from '../lib/fleet-install.js';

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

const node = { name: 'beta-max', ip: '10.0.0.7' };
const opts = { postgresPassword: 'a-long-enough-password', pairingCode: 'DEAD01' };

/** Verbatim from beta-max, 2026-09-22. */
const REFUSED = ['┌─ Pairing failed ─┐', '  That pairing code is no longer valid. Ask for a new one.', '└──┘'].join('\n');
const CLAIMED = [
  '┌─ Pairing accepted ─┐',
  '  Provisioning tunnel and DNS — this usually takes 1–3 minutes.',
  '└──┘',
  '┌─ Pairing failed ─┐',
  '  DNS provider error while creating record. Please retry.',
  '└──┘',
].join('\n');

/** The codes `cihub register` was actually run with, in order. */
const codesSent = (): string[] =>
  mocks.sshCapture.mock.calls
    .map(([, script]) => /cihub register --code '([^']*)'/.exec(String(script))?.[1])
    .filter((code): code is string => !!code);

/** A node with a cihub already on it, so the run reaches `register`; `register` then says `says`. */
function nodeWhoseRegisterSays(...says: string[]): void {
  let attempt = 0;
  mocks.sshCapture.mockImplementation(async (_target: unknown, script: string) => {
    if (script.includes('command -v cihub')) return { ok: true, out: 'path=/usr/bin/cihub\ncihub 0.2.74\n', err: '', code: 0, ms: 1 };
    if (script.includes('cihub register')) {
      const out = says[Math.min(attempt, says.length - 1)] ?? '';
      attempt += 1;
      return out === 'ok'
        ? { ok: true, out: '{"registered":true}\nhub-up-complete\n', err: '', code: 0, ms: 1 }
        : { ok: false, out, err: '', code: 1, ms: 1 };
    }
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

describe('a pairing code register refused', () => {
  it('sends the replacement the caller mints, rather than the dead code again', async () => {
    nodeWhoseRegisterSays(REFUSED, 'ok');
    const replacePairingCode = vi.fn().mockResolvedValue({ code: 'FRESH1', detail: 're-registered beta-max for a fresh code' });
    const report = await installNode(node, { ...opts, replacePairingCode }, 'ci');

    expect(replacePairingCode).toHaveBeenCalledTimes(1);
    expect(replacePairingCode.mock.calls[0]?.[0]).toMatchObject({ kind: 'refused' });
    expect(codesSent()).toEqual(['DEAD01', 'FRESH1']);
    const names = report.steps.map((s) => s.name);
    expect(names).toContain('replacement code');
    expect(names).toContain('hub up + register (retry)');
    expect(report.steps.find((s) => s.name === 'hub up + register (retry)')).toMatchObject({ ok: true });
  });

  it('asks once and no more: a replacement that is refused too ends the node', async () => {
    nodeWhoseRegisterSays(REFUSED, REFUSED);
    const replacePairingCode = vi.fn().mockResolvedValue({ code: 'FRESH1', detail: 'a fresh code' });
    const report = await installNode(node, { ...opts, replacePairingCode }, 'ci');

    expect(replacePairingCode).toHaveBeenCalledTimes(1);
    expect(codesSent()).toEqual(['DEAD01', 'FRESH1']);
    expect(report.ok).toBe(false);
  });

  it('puts the reason there is no replacement on the node line, and stops', async () => {
    nodeWhoseRegisterSays(REFUSED);
    const replacePairingCode = vi.fn().mockRejectedValue(new Error("minting a replacement needs 'cihub login --scope device:manage'"));
    const report = await installNode(node, { ...opts, replacePairingCode }, 'ci');

    expect(codesSent()).toEqual(['DEAD01']);
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ name: 'replacement code', ok: false });
    expect(report.steps.at(-1)?.detail).toContain('device:manage');
  });
});

describe('a pairing code Portal already claimed', () => {
  it('is reported, never retried — a second code meets the same DNS failure', async () => {
    // beta-max, three fresh codes, three identical DNS errors: the failure was never the code.
    nodeWhoseRegisterSays(CLAIMED, 'ok');
    const replacePairingCode = vi.fn().mockRejectedValue(new Error('the code is spent and a replacement would meet the same failure'));
    const report = await installNode(node, { ...opts, replacePairingCode }, 'ci');

    expect(replacePairingCode.mock.calls[0]?.[0]).toMatchObject({ kind: 'claimed' });
    expect(codesSent()).toEqual(['DEAD01']);
    expect(report.ok).toBe(false);
    expect(report.steps.map((s) => s.name)).not.toContain('hub up + register (retry)');
  });
});

describe('a failure that was not about the code', () => {
  it('leaves it alone: nothing is minted and nothing is asked for', async () => {
    nodeWhoseRegisterSays('hub-up-failed: the Hub is up but not registered: {"registered":false}');
    const replacePairingCode = vi.fn();
    const report = await installNode(node, { ...opts, replacePairingCode }, 'ci');

    expect(replacePairingCode).not.toHaveBeenCalled();
    expect(codesSent()).toEqual(['DEAD01']);
    expect(report.ok).toBe(false);
  });
});
