/**
 * `installNode` refuses to mint for a node whose Hub talks to a different Portal.
 *
 * A code minted on one Portal is not in the other's database, so the Hub's `register` gets the same
 * 410 a mistyped code gets — after resetting the node's registration first. `cihub` defaults to the
 * dev tier and a release Hub to production, so this is the default outcome, not an edge case. The
 * check runs before the mint so the doomed node leaves no device behind in Portal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const node = { name: 'core-3', ip: '10.0.0.3' };
let nodeUrl = 'https://hub.ci.computer';
const mint = vi.fn();

beforeEach(() => {
  nodeUrl = 'https://hub.ci.computer';
  mocks.readHostFacts.mockReset().mockResolvedValue({ facts: linuxFacts });
  mocks.preflightNode.mockReset().mockResolvedValue({ node: 'core-3', findings: [], verdict: 'ok', ms: 1 });
  mocks.sshCapture.mockReset().mockImplementation(async (_target: unknown, cmd: string) => {
    if (cmd.includes('command -v cihub')) return { ok: true, out: 'path=/usr/local/bin/cihub\ncihub 0.2.74 (abc123)', err: '', code: 0, ms: 1 };
    if (cmd.includes('ci-cloud-url='))
      return { ok: true, out: `ci-cloud-url=${nodeUrl}\nci-cloud-url-file=/home/ci/.env.dev`, err: '', code: 0, ms: 1 };
    // Everything after the mint stops here; these tests are about whether the mint happens.
    return { ok: false, out: '', err: 'stop here', code: 1, ms: 1 };
  });
  mint.mockReset().mockResolvedValue({ code: 'ABC123', detail: 'minted' });
});

const run = (portalOrigin?: string) => installNode(node, { postgresPassword: 'a-long-enough-password', mintPairingCode: mint, portalOrigin }, 'ci');

describe('installNode portal origin gate', () => {
  it('stops before minting when the Hub pairs against another Portal', async () => {
    const report = await run('https://hub.companionintelligence.com');
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ name: 'portal origin', ok: false });
    expect(report.steps.at(-1)?.detail).toContain('https://hub.ci.computer');
    expect(mint).not.toHaveBeenCalled();
    // An installed Hub is never handed another Portal: nothing is brought up at all.
    expect(mocks.sshCapture.mock.calls.some((c) => String(c[1]).includes('cihub up'))).toBe(false);
  });

  it('mints when the Portals match', async () => {
    const report = await run('https://hub.ci.computer/');
    expect(mint).toHaveBeenCalledTimes(1);
    expect(report.steps.map((s) => s.name)).not.toContain('portal origin');
    expect(report.steps.map((s) => s.name)).toContain('portal device');
  });

  it('mints for a node with no install yet, and seeds it against the Portal the code was minted on', async () => {
    // 2026-09-28: sixteen wiped nodes answered empty here, were minted codes on the dev Portal, and
    // were then seeded with production by `cihub up` — the one Portal those codes could not pair on.
    nodeUrl = '';
    await run('https://hub.companionintelligence.com/');
    expect(mint).toHaveBeenCalledTimes(1);
    const bringUp = mocks.sshCapture.mock.calls.map((c) => String(c[1])).find((cmd) => cmd.includes('cihub register'));
    expect(bringUp).toContain("CI_CLOUD_URL='https://hub.companionintelligence.com' cihub up --detached");
    // Checked again on the node itself, before and after `up`.
    expect(bringUp).toContain('portal-mismatch');
  });

  it('does not probe at all without a Portal to compare against, and hands `cihub up` none', async () => {
    await run(undefined);
    expect(mocks.sshCapture.mock.calls.some((c) => String(c[1]).includes('ci-cloud-url='))).toBe(false);
    expect(mint).toHaveBeenCalledTimes(1);
    const bringUp = mocks.sshCapture.mock.calls.map((c) => String(c[1])).find((cmd) => cmd.includes('cihub register'));
    expect(bringUp).toContain('\ncihub up --detached\n');
    expect(bringUp).not.toContain('CI_CLOUD_URL=');
  });
});
