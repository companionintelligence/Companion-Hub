/**
 * The order of `installNode`'s gates, and where the preflight sits among them.
 *
 * probe → load → platform → docker → **preflight** → install. The load gate stays first and stays as
 * it was: the outage once blamed on an initramfs rebuild had a kernel soft-lockup cascade under
 * inference twenty minutes earlier in the journal, so load was the right thing to refuse on. The
 * preflight comes after the cheap gates and before the first command that changes the machine.
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

const clean = (name: string) => ({ node: name, findings: [], verdict: 'ok', ms: 1 });
const blocked = (name: string) => ({
  node: name,
  findings: [{ check: 'sudo', ok: false, severity: 'block', value: 'sudo wants a password (sudo-rs)', via: 'sudo -n true' }],
  verdict: 'block',
  ms: 1,
});

const node = { name: 'core-7', ip: '10.0.0.7', oob: 'nanokvm 192.168.0.115' };
const opts = { postgresPassword: 'a-long-enough-password', pairingCode: 'ABC123' };

beforeEach(() => {
  mocks.readHostFacts.mockReset().mockResolvedValue({ facts: linuxFacts });
  mocks.preflightNode.mockReset().mockImplementation(async (_t: unknown, n: { name: string }) => clean(n.name));
  // Every later step fails fast, so a test that gets past the gates stops at "install cihub".
  mocks.sshCapture.mockReset().mockResolvedValue({ ok: false, out: '', err: 'stop here', code: 1, ms: 1 });
});

afterEach(() => vi.restoreAllMocks());

describe('installNode preflight gate', () => {
  it('runs the preflight after the docker gate and before anything is installed', async () => {
    const report = await installNode(node, opts, 'ci');
    expect(report.steps.map((s) => s.name)).toEqual(['probe', 'preflight', 'install cihub']);
    expect(report.steps[1]).toMatchObject({ ok: true });
    // detectCihub is the first SSH call after the gates; it happened only because preflight passed.
    expect(mocks.preflightNode.mock.invocationCallOrder[0]).toBeLessThan(mocks.sshCapture.mock.invocationCallOrder[0] as number);
  });

  it('stops the node on a block, before the first command that would change it', async () => {
    mocks.preflightNode.mockImplementation(async (_t: unknown, n: { name: string }) => blocked(n.name));
    const report = await installNode(node, opts, 'ci');
    expect(report.ok).toBe(false);
    expect(report.steps.map((s) => s.name)).toEqual(['probe', 'preflight']);
    expect(report.steps[1]).toMatchObject({ ok: false, skipped: true });
    expect(report.steps[1]?.detail).toContain('sudo: sudo wants a password');
    expect(report.steps[1]?.detail).toContain('--force');
    expect(mocks.sshCapture).not.toHaveBeenCalled();
  });

  it('goes ahead under force and says the block was overridden', async () => {
    mocks.preflightNode.mockImplementation(async (_t: unknown, n: { name: string }) => blocked(n.name));
    const report = await installNode(node, { ...opts, force: true }, 'ci');
    expect(report.steps[1]).toMatchObject({ name: 'preflight', ok: true });
    expect(report.steps[1]?.detail).toContain('overridden by --force');
    expect(report.steps.map((s) => s.name)).toContain('install cihub');
  });

  it('hands the roster console and the boot flag to the probe', async () => {
    await installNode(node, { ...opts, touchesBoot: true }, 'ci');
    expect(mocks.preflightNode).toHaveBeenCalledWith({ host: '10.0.0.7', user: 'ci' }, node, { touchesBoot: true });
  });

  it('keeps the load gate first: a busy node is never preflighted', async () => {
    mocks.readHostFacts.mockResolvedValue({ facts: { ...linuxFacts, load1: 110, cpuCount: 32 } });
    const report = await installNode(node, opts, 'ci');
    expect(report.steps.map((s) => s.name)).toEqual(['probe', 'load gate']);
    expect(mocks.preflightNode).not.toHaveBeenCalled();
  });

  it('keeps the platform and docker gates ahead of it too', async () => {
    mocks.readHostFacts.mockResolvedValue({ facts: { ...linuxFacts, os: 'darwin' } });
    expect((await installNode(node, opts, 'ci')).steps.map((s) => s.name)).toEqual(['probe', 'platform']);
    mocks.readHostFacts.mockResolvedValue({ facts: { ...linuxFacts, docker: { present: true, usable: false } } });
    expect((await installNode(node, opts, 'ci')).steps.map((s) => s.name)).toEqual(['probe', 'docker']);
    expect(mocks.preflightNode).not.toHaveBeenCalled();
  });
});
