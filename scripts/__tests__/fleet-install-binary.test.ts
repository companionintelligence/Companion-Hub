/**
 * `installNode` and the `cihub` already on a node: adopt it, or replace it with the one this run has.
 *
 * On 2026-09-20 `cihub fleet install --nodes core-1 --execute` with `GH_TOKEN` set — the default,
 * `latest` — adopted a July 0.2.36 in `~/.local/bin` and then failed at `hub up + register`, because
 * that build predates the headless seed path. The compare only ran when `--cihub-version 0.2.72` was
 * typed. And the attempt that did try to replace it reported `✗ install cihub (0s) — ` with nothing
 * after the dash. Both are pinned here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readHostFacts: vi.fn(),
  preflightNode: vi.fn(),
  sshCapture: vi.fn(),
  sshStreamFile: vi.fn(),
  downloadReleaseAsset: vi.fn(),
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
  sshStreamFile: mocks.sshStreamFile,
}));

vi.mock('../lib/fleet-cihub-binary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-cihub-binary.js')>()),
  downloadReleaseAsset: mocks.downloadReleaseAsset,
  sha256File: () => 'deadbeef',
}));

import type { CihubBinarySource } from '../lib/fleet-cihub-binary.js';
import { type InstallOptions, installNode } from '../lib/fleet-install.js';

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

const node = { name: 'core-1', ip: '10.0.0.1' };
const release: CihubBinarySource = { kind: 'release', token: 'ghp_x', version: 'v0.2.72', resolvedFrom: 'latest' };
const base: InstallOptions = { postgresPassword: 'a-long-enough-password', pairingCode: 'ABC123' };

/** What `detectCihub` sees on the node: the path a login shell resolves, then `cihub version`. */
function nodeHas(version: string | undefined, path = '/home/ci/.local/bin/cihub') {
  mocks.sshCapture.mockImplementation(async (_t: unknown, command: string) => {
    if (command.includes('command -v cihub')) {
      return { ok: true, out: `path=${path}\n${version ? `cihub ${version}` : ''}`, err: '', code: 0, ms: 1 };
    }
    // Every later step stops here, so a test ends right after the cihub decision.
    return { ok: false, out: '', err: 'stop here', code: 1, ms: 1 };
  });
}

const ok = (s: { name: string }) => s.name;

beforeEach(() => {
  mocks.readHostFacts.mockReset().mockResolvedValue({ facts: linuxFacts });
  mocks.preflightNode
    .mockReset()
    .mockImplementation(async (_t: unknown, n: { name: string }) => ({ node: n.name, findings: [], verdict: 'ok', ms: 1 }));
  mocks.sshCapture.mockReset();
  mocks.sshStreamFile.mockReset().mockResolvedValue({ ok: true, out: 'cihub-installed v0.2.72', err: '', code: 0, ms: 900 });
  mocks.downloadReleaseAsset.mockReset().mockResolvedValue({ path: '/tmp/v0.2.72-cihub-linux-x64', tag: 'v0.2.72', sha256: 'deadbeef' });
});

afterEach(() => vi.restoreAllMocks());

describe('installNode with a release the run resolved', () => {
  it('replaces a copy older than the resolved tag, even though the flag said latest', async () => {
    nodeHas('0.2.36');
    const report = await installNode(node, { ...base, cihubBinary: release }, 'ci');
    const install = report.steps.find((s) => s.name === 'install cihub');
    expect(install).toMatchObject({ ok: true });
    expect(install?.detail).toContain('0.2.36 is older than v0.2.72; replacing it');
    expect(mocks.sshStreamFile).toHaveBeenCalledTimes(1);
    expect(mocks.downloadReleaseAsset).toHaveBeenCalledWith(expect.objectContaining({ version: 'v0.2.72', assetName: 'cihub-linux-x64' }));
  });

  it('adopts a copy that is not older, and says what it was compared with', async () => {
    nodeHas('0.2.80', '/usr/local/bin/cihub');
    const report = await installNode(node, { ...base, cihubBinary: release }, 'ci');
    const cihub = report.steps.find((s) => s.name === 'cihub');
    expect(cihub).toMatchObject({ ok: true, skipped: true });
    expect(cihub?.detail).toBe('already installed (0.2.80, not older than v0.2.72) at /usr/local/bin/cihub');
    expect(mocks.sshStreamFile).not.toHaveBeenCalled();
  });

  it('streams the install script in a form that leaves stdin to it, never a heredoc', async () => {
    nodeHas(undefined);
    await installNode(node, { ...base, cihubBinary: release }, 'ci');
    const command = mocks.sshStreamFile.mock.calls[0]?.[1] as string;
    expect(command.startsWith('bash -c ')).toBe(true);
    expect(command).not.toContain('<<');
    expect(command).toContain('cihub-installed v0.2.72');
    expect(mocks.sshStreamFile.mock.calls[0]?.[2]).toBe('/tmp/v0.2.72-cihub-linux-x64');
  });

  it('still refuses an older copy when the download fails — the tag is known, the bytes are not', async () => {
    nodeHas('0.2.36');
    mocks.downloadReleaseAsset.mockRejectedValue(new Error('asset download failed: HTTP 502 for cihub-linux-x64'));
    const report = await installNode(node, { ...base, cihubBinary: release }, 'ci');
    expect(report.ok).toBe(false);
    expect(report.steps.map(ok)).toEqual(['probe', 'preflight', 'install cihub']);
    expect(report.steps[2]?.detail).toContain('asset download failed: HTTP 502');
    expect(report.steps[2]?.detail).toContain('GH_TOKEN');
  });

  it('names the reason when it exits 0 without installing anything', async () => {
    // The 2026-09-20 shape exactly: exit 0, nothing on either stream, no marker.
    nodeHas('0.2.36');
    mocks.sshStreamFile.mockResolvedValue({ ok: true, out: '', err: '', code: 0, ms: 120 });
    const report = await installNode(node, { ...base, cihubBinary: release }, 'ci');
    const install = report.steps.find((s) => s.name === 'install cihub');
    expect(install).toMatchObject({ ok: false });
    expect(install?.detail).toBe('exited 0 without printing cihub-installed: nothing on stdout or stderr');
    expect(report.ok).toBe(false);
  });
});

describe('installNode with nothing comparable on offer', () => {
  it('adopts what is there when there is no source, and says the version was not compared', async () => {
    nodeHas('0.2.36');
    const unavailable: CihubBinarySource = { kind: 'unavailable', why: 'no cihub binary to install: releases are private', fix: ['Set GH_TOKEN.'] };
    const report = await installNode(node, { ...base, cihubBinary: unavailable }, 'ci');
    const cihub = report.steps.find((s) => s.name === 'cihub');
    expect(cihub).toMatchObject({ ok: true, skipped: true });
    expect(cihub?.detail).toBe(
      'already installed (0.2.36) at /home/ci/.local/bin/cihub — version not compared: no cihub binary to install: releases are private',
    );
    expect(mocks.sshStreamFile).not.toHaveBeenCalled();
  });

  it('adopts, uncompared, when a --cihub-binary would not run on the operator machine', async () => {
    nodeHas('0.2.36');
    const local: CihubBinarySource = { kind: 'local', path: '/home/op/cihub-linux-arm64' };
    const report = await installNode(node, { ...base, cihubBinary: local }, 'ci');
    const cihub = report.steps.find((s) => s.name === 'cihub');
    expect(cihub?.detail).toContain('version not compared: /home/op/cihub-linux-arm64 would not run here');
    expect(mocks.sshStreamFile).not.toHaveBeenCalled();
  });

  it('compares against a --cihub-binary whose version is known', async () => {
    nodeHas('0.2.36');
    const local: CihubBinarySource = { kind: 'local', path: '/home/op/cihub-linux-x64', version: '0.2.72' };
    const report = await installNode(node, { ...base, cihubBinary: local }, 'ci');
    const install = report.steps.find((s) => s.name === 'install cihub');
    expect(install?.detail).toContain('0.2.36 is older than 0.2.72; replacing it');
    expect(mocks.sshStreamFile.mock.calls[0]?.[2]).toBe('/home/op/cihub-linux-x64');
    expect(mocks.downloadReleaseAsset).not.toHaveBeenCalled();
  });

  it('installs on a node with no cihub at all, without a compare to report', async () => {
    nodeHas(undefined, '');
    const report = await installNode(node, { ...base, cihubBinary: release }, 'ci');
    const install = report.steps.find((s) => s.name === 'install cihub');
    expect(install).toMatchObject({ ok: true });
    expect(install?.detail).toBe('cihub-installed v0.2.72');
  });
});
