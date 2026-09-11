/**
 * The Ollama version pin, its post-install confirmation, and the fleet-wide reading.
 *
 * Measured 2026-09-10: eighteen nodes spanned 0.12.11 → 0.33.3 because the installer was never told
 * a version and nothing ever printed the spread. Every case below is a way that state could come
 * back — an unpinned install, a success reported for a version nobody read, a node that binds to
 * its tailnet address and therefore reads as "no Ollama" on loopback, an unreachable node rendered
 * as a number.
 *
 * SSH is stubbed with the exact text the remote scripts print, routed by each script's heredoc
 * marker. Nothing here dials a machine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sshCapture: vi.fn(),
  readHostFacts: vi.fn(),
}));

vi.mock('../lib/fleet-ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-ssh.js')>()),
  sshCapture: mocks.sshCapture,
}));

vi.mock('../lib/fleet-hardware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-hardware.js')>()),
  readHostFacts: mocks.readHostFacts,
}));

import { FleetArgError, parseFleetArgs } from '../lib/cli-fleet.js';
import { executeBackendPlan, planBackend } from '../lib/fleet-backends.js';
import type { HostFacts } from '../lib/fleet-hardware.js';
import {
  OLLAMA_PINNED_VERSION,
  OllamaVersionError,
  compareOllamaVersions,
  judgeOllamaVersion,
  ollamaUpgradeScript,
  ollamaVersionScript,
  parseOllamaVersionOutput,
  renderOllamaCell,
  resolveOllamaVersion,
  standingAgainstPin,
  summariseOllamaVersions,
  upgradeOllamaOnNode,
  type OllamaVersionReading,
} from '../lib/fleet-ollama-version.js';
import type { SshResult } from '../lib/fleet-ssh.js';

const linux = (over: Partial<HostFacts> = {}): HostFacts => ({
  os: 'linux',
  arch: 'x86_64',
  appleSilicon: false,
  cpuCount: 32,
  load1: 0.4,
  docker: { present: true, usable: true },
  gpus: [],
  enginesListening: [],
  notes: [],
  ...over,
});

const ok = (out: string): SshResult => ({ ok: true, out, err: '', code: 0, ms: 12 });

// ─── Fixtures: what the remote scripts actually print ────────────────────────

/** A node whose unit binds OLLAMA_HOST to its tailnet address — loopback answers nothing there. */
const TAILNET_BOUND_AT_PIN = `ollama-host=100.124.211.75:11434\nollama-version=${OLLAMA_PINNED_VERSION}`;
const LOOPBACK_BEHIND = 'ollama-host=127.0.0.1:11434\nollama-version=0.30.9';
const NOTHING_ANSWERED = 'ollama-host=127.0.0.1:11434\nollama-version-error=nothing answered at 127.0.0.1:11434 and no ollama binary on PATH';
const DAEMON_DOWN =
  'ollama-host=100.64.0.9:11434\nollama-version-error=nothing answered at 100.64.0.9:11434, though an ollama binary is on PATH — daemon down, or bound elsewhere';

/**
 * Route a stubbed SSH call by the heredoc marker of the script it carries, and answer the version
 * probe from a queue so a test can say what the daemon reported before and after an install.
 */
function stubNode(opts: { versionProbes: string[]; install?: SshResult; upgrade?: SshResult }) {
  const probes = [...opts.versionProbes];
  mocks.sshCapture.mockImplementation(async (_target: unknown, command: string) => {
    if (command.includes('CIHUB_OLLAMA_VERSION_EOF')) return ok(probes.length > 1 ? (probes.shift() as string) : (probes[0] ?? ''));
    if (command.includes('CIHUB_OLLAMA_UPGRADE_EOF')) return opts.upgrade ?? ok('>>> Installing ollama\nollama-upgrade-complete');
    if (command.includes('CIHUB_OLLAMA_EOF')) return opts.install ?? ok('>>> The Ollama API is now available\nollama-install-complete');
    throw new Error(`unexpected remote command in test: ${command.slice(0, 80)}`);
  });
}

beforeEach(() => {
  mocks.sshCapture.mockReset();
  mocks.readHostFacts.mockReset().mockResolvedValue({ facts: linux() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── The pin and its override ────────────────────────────────────────────────

describe('resolveOllamaVersion', () => {
  it('is the pin when nothing is asked for', () => {
    expect(resolveOllamaVersion()).toBe(OLLAMA_PINNED_VERSION);
    expect(OLLAMA_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('takes an exact release, with or without a leading v', () => {
    expect(resolveOllamaVersion('0.33.3')).toBe('0.33.3');
    expect(resolveOllamaVersion('v0.33.3')).toBe('0.33.3');
    expect(resolveOllamaVersion(' 0.35.0-rc1 ')).toBe('0.35.0-rc1');
  });

  it("refuses 'latest' by name — it is the policy that produced the spread", () => {
    expect(() => resolveOllamaVersion('latest')).toThrow(OllamaVersionError);
    expect(() => resolveOllamaVersion('latest')).toThrow(/unpinned/);
  });

  it('refuses anything that is not x.y.z', () => {
    for (const bad of ['0.34', '', '34', '0.34.0; rm -rf /', 'stable']) {
      expect(() => resolveOllamaVersion(bad)).toThrow(OllamaVersionError);
    }
  });
});

describe('--ollama-version on the command line', () => {
  it('is validated at parse time, before any machine is dialled', () => {
    expect(parseFleetArgs(['backends', '--ollama-version', '0.33.3']).ollamaVersion).toBe('0.33.3');
    expect(parseFleetArgs(['update', '--ollama', '--ollama-version=v0.33.3']).ollamaVersion).toBe('0.33.3');
    expect(() => parseFleetArgs(['backends', '--ollama-version=latest'])).toThrow(FleetArgError);
    expect(() => parseFleetArgs(['backends', '--ollama-version=0.34'])).toThrow(/x\.y\.z/);
  });

  it('leaves the pin in force when the flag is absent', () => {
    expect(parseFleetArgs(['status']).ollamaVersion).toBeUndefined();
    expect(parseFleetArgs(['update', '--ollama']).ollama).toBe(true);
    expect(parseFleetArgs(['update']).ollama).toBe(false);
  });

  it('does not let --ollama swallow --ollama-version or vice versa', () => {
    // Exact-spelling flags: `--ollama` must not match as a prefix of `--ollama-version`.
    const args = parseFleetArgs(['update', '--ollama-version', '0.33.3']);
    expect(args.ollama).toBe(false);
    expect(args.ollamaVersion).toBe('0.33.3');
    expect(() => parseFleetArgs(['update', '--ollamas'])).toThrow(/Unknown flag/);
  });
});

describe('the ollama install plan', () => {
  it('hands the installer the pinned version, and still downloads to a file first', () => {
    const plan = planBackend('ollama', linux(), '/data');
    expect(plan.pinnedVersion).toBe(OLLAMA_PINNED_VERSION);
    expect(plan.script).toContain(`OLLAMA_VERSION='${OLLAMA_PINNED_VERSION}' sh "$installer"`);
    // The unpinned line is exactly what installed eighteen different versions.
    expect(plan.script).not.toMatch(/^sh "\$installer"$/m);
    expect(plan.script).toContain('-o "$installer"');
    expect(plan.script).not.toMatch(/curl[^\n]*\|\s*sh/);
    expect(plan.why).toContain(OLLAMA_PINNED_VERSION);
    expect(plan.why).toContain('pinned');
  });

  it('honours --ollama-version for the run, and says the version came from the flag', () => {
    const plan = planBackend('ollama', linux(), '/data', { ollamaVersion: '0.33.3' });
    expect(plan.pinnedVersion).toBe('0.33.3');
    expect(plan.script).toContain("OLLAMA_VERSION='0.33.3' sh");
    expect(plan.why).toContain('--ollama-version');
  });

  it('gives no other backend a pinned version, so nothing else is version-checked', () => {
    expect(
      planBackend('vllm', linux({ gpus: [{ vendor: 'nvidia', name: 'RTX 3080', driverWorking: true }] }), '/data').pinnedVersion,
    ).toBeUndefined();
  });
});

// ─── Reading the version at the resolved bind ────────────────────────────────

describe('ollamaVersionScript', () => {
  const script = ollamaVersionScript();

  it('asks the bind the node actually uses, not loopback by assumption', () => {
    // Several nodes bind OLLAMA_HOST to their tailnet address; `curl localhost:11434` on those reads
    // as "no Ollama" on a machine that is serving fine.
    expect(script).toContain('systemctl show ollama -p Environment');
    expect(script).toMatch(/OLLAMA_HOST=/);
    expect(script).toMatch(/ss -ltn/);
    expect(script).toContain('host="127.0.0.1:11434"');
    expect(script).toContain('"http://$host/api/version"');
  });

  it('maps every wildcard bind to something curl can dial', () => {
    for (const wildcard of ['0\\.0\\.0\\.0:', '\\[::\\]:', '\\*:']) expect(script).toContain(`s/^${wildcard}/127.0.0.1:/`);
  });

  it('never exits non-zero, so a silent daemon is not mistaken for a failed SSH session', () => {
    expect(script).not.toContain('set -e');
    expect(script.trim().endsWith('exit 0')).toBe(true);
    expect(script).toContain('ollama-version-error=');
  });

  it('retries only when asked to, for the restart window after an install', () => {
    expect(ollamaVersionScript()).toContain('-lt 1 ]');
    expect(ollamaVersionScript({ attempts: 10 })).toContain('-lt 10 ]');
    expect(ollamaVersionScript({ attempts: 10 })).toContain('sleep 2');
  });
});

describe('parseOllamaVersionOutput', () => {
  it('reads the version and the bind it came from', () => {
    expect(parseOllamaVersionOutput(TAILNET_BOUND_AT_PIN)).toEqual({ host: '100.124.211.75:11434', version: OLLAMA_PINNED_VERSION });
  });

  it('turns the error line into a reason, with no version', () => {
    const reading = parseOllamaVersionOutput(DAEMON_DOWN);
    expect(reading.version).toBeUndefined();
    expect(reading.host).toBe('100.64.0.9:11434');
    expect(reading.reason).toMatch(/daemon down, or bound elsewhere/);
  });

  it('never invents a version from empty or foreign output', () => {
    expect(parseOllamaVersionOutput('').version).toBeUndefined();
    expect(parseOllamaVersionOutput('').reason).toMatch(/printed nothing/);
    expect(parseOllamaVersionOutput('bash: line 3: ss: command not found').version).toBeUndefined();
  });
});

describe('judgeOllamaVersion', () => {
  it('passes only an exact match, and names where it was read', () => {
    const verdict = judgeOllamaVersion(OLLAMA_PINNED_VERSION, parseOllamaVersionOutput(TAILNET_BOUND_AT_PIN));
    expect(verdict.ok).toBe(true);
    expect(verdict.why).toContain('100.124.211.75:11434');
  });

  it('fails a mismatch, naming both versions', () => {
    const verdict = judgeOllamaVersion('0.34.0', { host: '127.0.0.1:11434', version: '0.33.3' });
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain('0.33.3');
    expect(verdict.why).toContain('0.34.0');
  });

  it('is never ok without a version to point at', () => {
    // An install whose daemon cannot be asked is unconfirmed, not successful.
    const verdict = judgeOllamaVersion('0.34.0', parseOllamaVersionOutput(NOTHING_ANSWERED));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/could not confirm/);
    expect(verdict.why).toMatch(/nobody read/);
  });
});

// ─── The post-install check, end to end through executeBackendPlan ──────────

describe('executeBackendPlan for ollama', () => {
  const target = { host: '100.64.0.9', user: 'root' };

  it('reports installed only after /api/version at the resolved bind says the pin', async () => {
    stubNode({ versionProbes: [TAILNET_BOUND_AT_PIN] });
    const result = await executeBackendPlan(target, planBackend('ollama', linux(), '/data'));
    expect(result.outcome).toBe('installed');
    expect(result.why).toContain(`confirms ${OLLAMA_PINNED_VERSION}`);
    expect(result.why).toContain('100.124.211.75:11434');
    // The installer ran, then the probe: two round trips, in that order.
    const commands = mocks.sshCapture.mock.calls.map((c) => String(c[1]));
    expect(commands[0]).toContain('CIHUB_OLLAMA_EOF');
    expect(commands[1]).toContain('CIHUB_OLLAMA_VERSION_EOF');
    expect(commands[0]).toContain(`OLLAMA_VERSION='${OLLAMA_PINNED_VERSION}'`);
  });

  it('fails when the installer finished but the daemon serving is a different version', async () => {
    // The completion marker says the tarball unpacked. Only the daemon says what is serving.
    stubNode({ versionProbes: [LOOPBACK_BEHIND] });
    const result = await executeBackendPlan(target, planBackend('ollama', linux(), '/data'));
    expect(result.outcome).toBe('failed');
    expect(result.why).toContain('0.30.9');
    expect(result.why).toContain(OLLAMA_PINNED_VERSION);
  });

  it('fails when nothing answers, rather than printing success for a version nobody read', async () => {
    stubNode({ versionProbes: [NOTHING_ANSWERED] });
    const result = await executeBackendPlan(target, planBackend('ollama', linux(), '/data'));
    expect(result.outcome).toBe('failed');
    expect(result.why).toMatch(/could not confirm/);
  });

  it('does not run the probe when the install itself failed', async () => {
    stubNode({
      versionProbes: [TAILNET_BOUND_AT_PIN],
      install: { ok: false, out: '', err: 'curl: (28) Connection timed out', code: 28, ms: 30_000 },
    });
    const result = await executeBackendPlan(target, planBackend('ollama', linux(), '/data'));
    expect(result.outcome).toBe('failed');
    expect(result.why).toContain('exited 28');
    expect(mocks.sshCapture).toHaveBeenCalledTimes(1);
  });
});

// ─── Standing against the pin, and the fleet summary ─────────────────────────

describe('compareOllamaVersions', () => {
  it('compares numerically, not lexically', () => {
    // Lexically '0.12.11' > '0.9.0' and '0.9.0' > '0.34.0' — both wrong.
    expect(compareOllamaVersions('0.12.11', '0.34.0')).toBe(-1);
    expect(compareOllamaVersions('0.9.0', '0.34.0')).toBe(-1);
    expect(compareOllamaVersions('0.34.0', '0.34.0')).toBe(0);
    expect(compareOllamaVersions('v0.35.1', '0.34.0')).toBe(1);
  });

  it('sorts a pre-release below its release', () => {
    expect(compareOllamaVersions('0.34.0-rc1', '0.34.0')).toBe(-1);
    expect(standingAgainstPin('0.34.0-rc1', '0.34.0')).toBe('behind');
  });

  it('never reports garbage as ahead', () => {
    expect(standingAgainstPin('0.0.0', '0.34.0')).toBe('behind');
    expect(standingAgainstPin(undefined, '0.34.0')).toBe('unmeasured');
  });
});

describe('renderOllamaCell', () => {
  it('prints a dash for an unmeasured node, never a version or "missing"', () => {
    const cell = renderOllamaCell({ node: 'core-7', reason: 'ssh acl-denied; :11434 did not answer from here' }, '0.34.0');
    expect(cell).toEqual({ text: '—', standing: 'unmeasured' });
    expect(cell.text).not.toMatch(/missing/i);
  });

  it('marks a node behind the pin on its own line', () => {
    expect(renderOllamaCell({ node: 'localhost-0', version: '0.30.9' }, '0.34.0')).toEqual({
      text: '0.30.9 ◂ behind pin 0.34.0',
      standing: 'behind',
    });
    expect(renderOllamaCell({ node: 'core-1', version: '0.34.0' }, '0.34.0')).toEqual({ text: '0.34.0', standing: 'at-pin' });
    expect(renderOllamaCell({ node: 'core-2', version: '0.35.0' }, '0.34.0').standing).toBe('ahead');
  });
});

describe('summariseOllamaVersions', () => {
  const fleet = (
    behind: Record<string, string> = {},
    unmeasured: Record<string, string> = {},
    ahead: Record<string, string> = {},
  ): OllamaVersionReading[] => {
    const rows: OllamaVersionReading[] = [];
    const named = new Set([...Object.keys(behind), ...Object.keys(unmeasured), ...Object.keys(ahead)]);
    for (let i = 1; rows.length + named.size < 18; i++) rows.push({ node: `core-${i}`, version: '0.34.0', host: '127.0.0.1:11434', source: 'node' });
    for (const [node, version] of Object.entries(behind)) rows.push({ node, version, host: '127.0.0.1:11434', source: 'node' });
    for (const [node, version] of Object.entries(ahead)) rows.push({ node, version, host: '127.0.0.1:11434', source: 'node' });
    for (const [node, reason] of Object.entries(unmeasured)) rows.push({ node, reason });
    return rows;
  };

  it('is the one line the night of 2026-09-10 needed', () => {
    expect(summariseOllamaVersions(fleet({ 'localhost-0': '0.30.9' }), '0.34.0')).toBe('0.34.0 on 17/18; behind: localhost-0 (0.30.9)');
  });

  it('reports a fully aligned fleet without a trailing clause', () => {
    expect(summariseOllamaVersions(fleet(), '0.34.0')).toBe('0.34.0 on 18/18');
  });

  it('counts an unmeasured node against the total and names it with its reason', () => {
    // Denominator is every node asked, so a machine nobody could read lowers the fraction instead
    // of quietly leaving it.
    const line = summariseOllamaVersions(fleet({ 'core-3': '0.12.11' }, { 'core-7': 'ssh acl-denied; :11434 did not answer from here' }), '0.34.0');
    expect(line).toBe('0.34.0 on 16/18; behind: core-3 (0.12.11); unmeasured: core-7 (ssh acl-denied; :11434 did not answer from here)');
    expect(line).not.toMatch(/missing/i);
  });

  it('lists a node ahead of the pin separately from one behind it', () => {
    const line = summariseOllamaVersions(fleet({}, {}, { 'core-9': '0.35.1' }), '0.34.0');
    expect(line).toBe('0.34.0 on 17/18; ahead: core-9 (0.35.1)');
  });

  it('measures against the version the operator asked for, not only the pin', () => {
    expect(summariseOllamaVersions(fleet({ 'localhost-0': '0.30.9' }), '0.30.9')).toBe(
      `0.30.9 on 1/18; ahead: ${Array.from({ length: 17 }, (_, i) => `core-${i + 1} (0.34.0)`).join(', ')}`,
    );
  });
});

// ─── Moving a node to the pin ────────────────────────────────────────────────

describe('ollamaUpgradeScript', () => {
  const script = ollamaUpgradeScript('0.34.0');

  it('keeps the download-to-file-then-run shape, with the version in the environment', () => {
    expect(script).toContain('-o "$installer"');
    expect(script).not.toMatch(/curl[^\n]*\|\s*sh/);
    expect(script).toContain('OLLAMA_VERSION=\'0.34.0\' sh "$installer"');
    expect(script).toContain('ollama-upgrade-complete');
  });

  it("leaves the bind drop-in alone — that is the install path's job, and another change's", () => {
    expect(script).not.toContain('ollama.service.d');
    expect(script).not.toContain('OLLAMA_HOST');
  });

  it('refuses an unpinned version even here', () => {
    expect(() => ollamaUpgradeScript('latest')).toThrow(OllamaVersionError);
  });
});

describe('upgradeOllamaOnNode', () => {
  const target = { host: '100.64.0.9', user: 'root' };

  it('leaves a node already at the pin alone, downloading nothing', async () => {
    stubNode({ versionProbes: [TAILNET_BOUND_AT_PIN] });
    const result = await upgradeOllamaOnNode(target, OLLAMA_PINNED_VERSION);
    expect(result.outcome).toBe('current');
    expect(result.why).toContain('100.124.211.75:11434');
    expect(mocks.sshCapture.mock.calls.some((c) => String(c[1]).includes('CIHUB_OLLAMA_UPGRADE_EOF'))).toBe(false);
  });

  it('upgrades a node behind the pin and reports the transition only once the daemon confirms it', async () => {
    stubNode({ versionProbes: [LOOPBACK_BEHIND, `ollama-host=127.0.0.1:11434\nollama-version=${OLLAMA_PINNED_VERSION}`] });
    const result = await upgradeOllamaOnNode(target, OLLAMA_PINNED_VERSION);
    expect(result.outcome).toBe('upgraded');
    expect(result.from).toBe('0.30.9');
    expect(result.to).toBe(OLLAMA_PINNED_VERSION);
    expect(result.why).toContain(`0.30.9 → ${OLLAMA_PINNED_VERSION}`);
    const upgrade = mocks.sshCapture.mock.calls.find((c) => String(c[1]).includes('CIHUB_OLLAMA_UPGRADE_EOF'));
    expect(String(upgrade?.[1])).toContain(`OLLAMA_VERSION='${OLLAMA_PINNED_VERSION}'`);
    expect(String(upgrade?.[1])).toMatch(/^sudo -n bash/);
  });

  it('fails when the installer finished but the daemon still serves the old version', async () => {
    // Seen when a restart is refused or a second binary shadows the new one on PATH.
    stubNode({ versionProbes: [LOOPBACK_BEHIND, LOOPBACK_BEHIND] });
    const result = await upgradeOllamaOnNode(target, OLLAMA_PINNED_VERSION);
    expect(result.outcome).toBe('failed');
    expect(result.why).toContain('0.30.9');
  });

  it('will not turn into an install on a node with no Ollama', async () => {
    stubNode({ versionProbes: [NOTHING_ANSWERED] });
    const result = await upgradeOllamaOnNode(target, OLLAMA_PINNED_VERSION);
    expect(result.outcome).toBe('skipped');
    expect(result.why).toContain('fleet backends --backends ollama --execute');
    expect(mocks.sshCapture.mock.calls.some((c) => String(c[1]).includes('CIHUB_OLLAMA_UPGRADE_EOF'))).toBe(false);
  });

  it('refuses a node under load, since the installer restarts the daemon', async () => {
    mocks.readHostFacts.mockResolvedValue({ facts: linux({ cpuCount: 32, load1: 110 }) });
    stubNode({ versionProbes: [LOOPBACK_BEHIND] });
    const result = await upgradeOllamaOnNode(target, OLLAMA_PINNED_VERSION);
    expect(result.outcome).toBe('skipped');
    expect(result.why).toMatch(/load 110/);
    expect(mocks.sshCapture).not.toHaveBeenCalled();
  });

  it('names passwordless sudo when that is what is missing', async () => {
    stubNode({
      versionProbes: [LOOPBACK_BEHIND],
      upgrade: { ok: false, out: '', err: 'sudo: a password is required', code: 1, ms: 40 },
    });
    const result = await upgradeOllamaOnNode(target, OLLAMA_PINNED_VERSION);
    expect(result.outcome).toBe('failed');
    expect(result.why).toMatch(/passwordless sudo/);
  });
});
