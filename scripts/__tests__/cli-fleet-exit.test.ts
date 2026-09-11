/**
 * `cihub fleet` — the run's outcome as the shell sees it.
 *
 * Every one of these commands ended by printing what happened and returning. `0/14 node(s)
 * installed.` exited 0, so `cihub fleet install --execute && cihub fleet apps` carried on into the
 * next step, and a CI job wrapped around a fleet command went green on a fleet where nothing worked.
 *
 * The dry runs are here for the opposite reason: `install` and `update` without `--execute` change
 * nothing and report a plan, so they must keep exiting 0.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  nodes: [] as import('../lib/fleet-roster.js').FleetNode[],
  installNode: vi.fn(),
  sshCapture: vi.fn(),
  readHostFacts: vi.fn(),
  executeBackendPlan: vi.fn(),
  planAllBackends: vi.fn(),
  checkAppOnNode: vi.fn(),
  probeNode: vi.fn(),
  ensureTailscaleCert: vi.fn(),
  probeTailscaleCert: vi.fn(),
  preflightNode: vi.fn(),
}));

vi.mock('../lib/fleet-roster.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-roster.js')>()),
  loadFleetRoster: () => ({ nodes: mocks.nodes, source: 'test-roster', dropped: [] }),
}));

vi.mock('../lib/catalog-submit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/catalog-submit.js')>()),
  readStoredLogin: () => ({ orgSlug: 'test-org' }),
  loginScope: () => 'device:pair',
  mintPairingCode: async ({ name }: { name: string }) => ({ pairingCode: 'ABC123', slug: name }),
}));

vi.mock('../lib/fleet-install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-install.js')>()),
  installNode: mocks.installNode,
}));

vi.mock('../lib/fleet-ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-ssh.js')>()),
  sshCapture: mocks.sshCapture,
}));

vi.mock('../lib/fleet-hardware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-hardware.js')>()),
  readHostFacts: mocks.readHostFacts,
}));

vi.mock('../lib/fleet-backends.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-backends.js')>()),
  planAllBackends: (...args: unknown[]) => mocks.planAllBackends(...args),
  executeBackendPlan: mocks.executeBackendPlan,
}));

vi.mock('../lib/fleet-apps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-apps.js')>()),
  checkAppOnNode: mocks.checkAppOnNode,
}));

vi.mock('../lib/fleet-discover.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-discover.js')>()),
  probeNode: mocks.probeNode,
}));

import { runFleetCommand } from '../lib/cli-fleet.js';
import { HUB_IMAGE_REPO } from '../lib/fleet-image.js';

/** Calls that ran `cihub pool update`, as distinct from the image probes that now bracket each one. */
const updateCalls = () => mocks.sshCapture.mock.calls.filter((call) => String(call[1]).includes('cihub pool update'));
const probeCalls = () => mocks.sshCapture.mock.calls.filter((call) => String(call[1]).includes('image-probe'));

const imageId = (prefix: string) => `sha256:${prefix.padEnd(64, '0')}`;
const digestOf = (prefix: string) => `${HUB_IMAGE_REPO}@sha256:${prefix.padEnd(64, 'b')}`;
/** The probe script's output on a node running the given image. */
const probeOutput = (prefix: string, repoDigest: string | null = digestOf(prefix)) =>
  [
    'image-probe: container=ci-hub',
    `image-probe-container: ${JSON.stringify({ Name: '/ci-hub', Image: imageId(prefix), State: { Status: 'running' }, Config: { Image: `${HUB_IMAGE_REPO}:dev` } })}`,
    `image-probe-image: ${JSON.stringify({ Id: imageId(prefix), RepoTags: [`${HUB_IMAGE_REPO}:dev`], RepoDigests: repoDigest ? [repoDigest] : [], Created: '2026-09-08T14:03:11Z' })}`,
    'image-probe: complete',
  ].join('\n');
const okResult = (out: string) => ({ ok: true, out, err: '', code: 0, ms: 5 });

/**
 * Route the SSH mock: probes answer per host (and may answer differently before and after the update
 * on that host), everything else gets `update`.
 */
function routeSsh(opts: { before: Record<string, string>; after?: Record<string, string>; update?: ReturnType<typeof okResult> }) {
  const seen = new Map<string, number>();
  mocks.sshCapture.mockImplementation(async (target: { host: string }, command: string) => {
    if (command.includes('image-probe')) {
      const n = seen.get(target.host) ?? 0;
      seen.set(target.host, n + 1);
      const out = n === 0 || !opts.after ? opts.before[target.host] : opts.after[target.host];
      return okResult(out ?? '');
    }
    return opts.update ?? okResult('hub-update-complete');
  });
}
vi.mock('../lib/fleet-tailscale-cert.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-tailscale-cert.js')>()),
  ensureTailscaleCert: mocks.ensureTailscaleCert,
  probeTailscaleCert: mocks.probeTailscaleCert,
}));

// The probe is an SSH call of its own; the gate that reads it is real.
vi.mock('../lib/fleet-preflight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-preflight.js')>()),
  preflightNode: mocks.preflightNode,
}));

import { CANONICAL_BIND_DROPIN, canonicalBindDropinContent } from '../lib/fleet-ollama-bind.js';

const facts = {
  os: 'linux',
  arch: 'x86_64',
  appleSilicon: false,
  cpuCount: 16,
  load1: 0.2,
  docker: { present: true, usable: true },
  gpus: [],
  enginesListening: [],
  notes: [],
};

beforeEach(() => {
  process.exitCode = undefined;
  process.env.CIHUB_POSTGRES_PASSWORD = 'a-long-enough-password';
  mocks.nodes = [
    { name: 'core-1', ip: '10.0.0.1' },
    { name: 'core-2', ip: '10.0.0.2' },
  ];
  mocks.installNode.mockReset();
  // `backends` now reads each node's Ollama bind over SSH before planning; an unreachable probe
  // must not turn a dry run into a crash, so the default answer is "no output".
  mocks.sshCapture.mockReset().mockResolvedValue({ ok: false, out: '', err: '', code: 255, ms: 1 });
  mocks.readHostFacts.mockReset().mockResolvedValue({ facts });
  mocks.executeBackendPlan.mockReset();
  mocks.planAllBackends.mockReset().mockReturnValue([{ backend: 'ollama', action: 'install', why: 'no engine answering' }]);
  mocks.checkAppOnNode.mockReset();
  mocks.probeNode.mockReset().mockResolvedValue({ ssh: true, sshFailure: 'ok', hub: true, hubDetail: 'tier a', engines: [] });
  mocks.ensureTailscaleCert.mockReset();
  mocks.probeTailscaleCert.mockReset();
  mocks.preflightNode
    .mockReset()
    .mockImplementation(async (_target: unknown, node: { name: string }) => ({ node: node.name, findings: [], verdict: 'ok', ms: 1 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = undefined;
  delete process.env.CIHUB_POSTGRES_PASSWORD;
  vi.restoreAllMocks();
});

describe('fleet install', () => {
  it('fails when no node installed', async () => {
    mocks.installNode.mockImplementation(async (node: { name: string }) => ({ node: node.name, ok: false, steps: [] }));
    await runFleetCommand(['install', '--execute']);
    expect(process.exitCode).toBe(1);
  });

  it('fails when one node out of two failed', async () => {
    // A partial success is still a fleet that is not in the state the operator asked for.
    let call = 0;
    mocks.installNode.mockImplementation(async (node: { name: string }) => ({ node: node.name, ok: call++ === 0, steps: [] }));
    await runFleetCommand(['install', '--execute']);
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 when every node installed', async () => {
    mocks.installNode.mockImplementation(async (node: { name: string }) => ({ node: node.name, ok: true, steps: [] }));
    await runFleetCommand(['install', '--execute']);
    expect(mocks.installNode).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 0 on a dry run, which installs nothing', async () => {
    await runFleetCommand(['install']);
    expect(mocks.installNode).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('hands --force and --touches-boot to the per-node installer, where the preflight gate lives', async () => {
    mocks.installNode.mockImplementation(async (node: { name: string }) => ({ node: node.name, ok: true, steps: [] }));
    await runFleetCommand(['install', '--execute', '--force', '--touches-boot']);
    expect(mocks.installNode).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ force: true, touchesBoot: true }), undefined);
    await runFleetCommand(['install', '--execute']);
    expect(mocks.installNode).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ force: false, touchesBoot: false }), undefined);
  });
});

describe('fleet update', () => {
  it('fails when the hub image did not update', async () => {
    mocks.sshCapture.mockResolvedValue({ ok: false, out: '', err: 'connection refused', code: 255, ms: 5 });
    await runFleetCommand(['update', '--execute', '--hub']);
    expect(process.exitCode).toBe(1);
  });

  it('fails when a model pull did not complete', async () => {
    mocks.sshCapture.mockResolvedValue({ ok: true, out: 'pulling manifest', err: '', code: 0, ms: 5 });
    await runFleetCommand(['update', '--execute', '--models=llama3']);
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 when every node reported the completion marker', async () => {
    mocks.sshCapture.mockResolvedValue({ ok: true, out: 'hub-update-complete', err: '', code: 0, ms: 5 });
    await runFleetCommand(['update', '--execute', '--hub']);
    expect(updateCalls()).toHaveLength(2);
    expect(process.exitCode).toBeUndefined();
  });

  /**
   * The preflight runs before the first thing that changes a node. A `block` — a wedged dpkg, a
   * held lock, no sudo — ends that node's update without touching it, and counts as a failure.
   */
  describe('preflight gate', () => {
    const blocked = (name: string) => ({
      node: name,
      findings: [{ check: 'dpkg', ok: false, severity: 'block', value: '3 package(s) half-configured', via: 'dpkg --audit' }],
      verdict: 'block',
      ms: 1,
    });

    it('refuses a blocked node before running anything on it, and fails the run', async () => {
      mocks.preflightNode.mockImplementation(async (_t: unknown, node: { name: string }) =>
        node.name === 'core-1' ? blocked(node.name) : { node: node.name, findings: [], verdict: 'ok', ms: 1 },
      );
      mocks.sshCapture.mockResolvedValue({ ok: true, out: 'hub-update-complete', err: '', code: 0, ms: 5 });
      await runFleetCommand(['update', '--execute', '--hub']);
      // Only core-2 was dialled at all — for `--hub` that is the image probe before, the update, and
      // the probe after; the blocked node gets none of them. The count is the image work's business;
      // the gate's promise is the set of hosts.
      const hosts = new Set(mocks.sshCapture.mock.calls.map((c) => (c[0] as { host: string }).host));
      expect(hosts).toEqual(new Set(['10.0.0.2']));
      expect(mocks.sshCapture.mock.calls.length).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
    });

    it('goes ahead under --force and exits 0 when the work itself succeeded', async () => {
      mocks.preflightNode.mockImplementation(async (_t: unknown, node: { name: string }) => blocked(node.name));
      mocks.sshCapture.mockResolvedValue({ ok: true, out: 'hub-update-complete', err: '', code: 0, ms: 5 });
      await runFleetCommand(['update', '--execute', '--hub', '--force']);
      const hosts = new Set(mocks.sshCapture.mock.calls.map((c) => (c[0] as { host: string }).host));
      expect(hosts).toEqual(new Set(['10.0.0.1', '10.0.0.2']));
      expect(process.exitCode).toBeUndefined();
    });

    it('continues past a warn', async () => {
      mocks.preflightNode.mockImplementation(async (_t: unknown, node: { name: string }) => ({
        node: node.name,
        findings: [{ check: 'boot-recovery', ok: false, severity: 'warn', value: 'no boot window', via: '/etc/default/grub' }],
        verdict: 'warn',
        ms: 1,
      }));
      mocks.sshCapture.mockResolvedValue({ ok: true, out: 'hub-update-complete', err: '', code: 0, ms: 5 });
      await runFleetCommand(['update', '--execute', '--hub']);
      const hosts = new Set(mocks.sshCapture.mock.calls.map((c) => (c[0] as { host: string }).host));
      expect(hosts).toEqual(new Set(['10.0.0.1', '10.0.0.2']));
      expect(process.exitCode).toBeUndefined();
    });

    it('passes --touches-boot through to the probe', async () => {
      mocks.sshCapture.mockResolvedValue({ ok: true, out: 'hub-update-complete', err: '', code: 0, ms: 5 });
      await runFleetCommand(['update', '--execute', '--hub', '--touches-boot']);
      expect(mocks.preflightNode).toHaveBeenCalledWith(expect.anything(), expect.anything(), { touchesBoot: true });
    });

    it('does not probe on a dry run', async () => {
      await runFleetCommand(['update', '--hub']);
      expect(mocks.preflightNode).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });
  });
});

describe('fleet preflight', () => {
  it('exits 0 when every node is clear, and dials nothing but the probe', async () => {
    await runFleetCommand(['preflight']);
    expect(mocks.preflightNode).toHaveBeenCalledTimes(2);
    expect(mocks.sshCapture).not.toHaveBeenCalled();
    expect(mocks.installNode).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 when a node would be refused, so it can gate a script', async () => {
    mocks.preflightNode.mockImplementation(async (_t: unknown, node: { name: string }) => ({
      node: node.name,
      findings: [{ check: 'sudo', ok: false, severity: 'block', value: 'sudo wants a password', via: 'sudo -n true' }],
      verdict: 'block',
      ms: 1,
    }));
    await runFleetCommand(['preflight']);
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when a probe could not run — unmeasured is not clear', async () => {
    mocks.preflightNode.mockImplementation(async (_t: unknown, node: { name: string }) => ({
      node: node.name,
      findings: [],
      verdict: 'block',
      error: 'Timed out after 60000ms',
      ms: 60000,
    }));
    await runFleetCommand(['preflight']);
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 on info and warn findings', async () => {
    mocks.preflightNode.mockImplementation(async (_t: unknown, node: { name: string }) => ({
      node: node.name,
      findings: [
        { check: 'sudo', ok: false, severity: 'info', value: 'CI OS: unprivileged by design', via: 'sudo -n true' },
        { check: 'boot-recovery', ok: false, severity: 'warn', value: 'no boot window', via: '/etc/default/grub' },
      ],
      verdict: 'warn',
      ms: 1,
    }));
    await runFleetCommand(['preflight']);
    expect(process.exitCode).toBeUndefined();
  });

  it('prints a row per node and a detail line per finding', async () => {
    mocks.preflightNode.mockImplementation(async (_t: unknown, node: { name: string }) => ({
      node: node.name,
      findings: [{ check: 'apt-lock', ok: false, severity: 'block', value: 'dpkg lock held by PID 40210', via: 'lslocks', fix: 'wait for it' }],
      verdict: 'block',
      ms: 1,
    }));
    await runFleetCommand(['preflight', '--nodes=core-1']);
    const out = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(out).toContain('APT-LOCK');
    expect(out).toContain('dpkg lock held by PID 40210');
    expect(out).toContain('via: lslocks');
    expect(out).toContain('fix: wait for it');
    expect(out).toContain('--force');
  });

  it('emits JSON with the findings when asked', async () => {
    await runFleetCommand(['preflight', '--json']);
    const out = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .find((line) => line.trim().startsWith('{'));
    expect(out).toBeDefined();
    const parsed = JSON.parse(out as string) as { nodes: { node: string; verdict: string }[]; touchesBoot: boolean };
    expect(parsed.nodes.map((n) => n.node)).toEqual(['core-1', 'core-2']);
    expect(parsed.touchesBoot).toBe(false);
  });
});

describe('fleet backends', () => {
  it('fails when a backend install failed', async () => {
    mocks.executeBackendPlan.mockResolvedValue({ backend: 'ollama', outcome: 'failed', why: 'apt returned 100', detail: 'E: broken packages' });
    await runFleetCommand(['backends', '--execute']);
    expect(process.exitCode).toBe(1);
  });

  it('fails when a node could not be read at all', async () => {
    mocks.readHostFacts.mockResolvedValue({ error: 'ssh: connect to host 10.0.0.1 port 22: No route to host' });
    await runFleetCommand(['backends', '--execute']);
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 when every backend installed', async () => {
    mocks.executeBackendPlan.mockResolvedValue({ backend: 'ollama', outcome: 'installed', why: 'no engine answering' });
    await runFleetCommand(['backends', '--execute']);
    expect(mocks.executeBackendPlan).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 0 on a dry run against readable machines', async () => {
    await runFleetCommand(['backends']);
    expect(mocks.executeBackendPlan).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('reads the Ollama bind read-only on a dry run, and never applies it', async () => {
    mocks.sshCapture.mockResolvedValue({
      ok: true,
      out: [
        'bind_probe=1',
        'unit_file=/etc/systemd/system/ollama.service',
        'show:Environment=OLLAMA_HOST=0.0.0.0',
        'tailscale_ip=100.64.0.9',
        '===DROPIN /etc/systemd/system/ollama.service.d/zzz-tailnet-bind.conf===',
        '[Service]',
        'Environment="OLLAMA_HOST=100.64.0.9:11434"',
        '===END===',
        '===DROPIN /etc/systemd/system/ollama.service.d/zzzz-bind-all.conf===',
        '[Service]',
        'Environment="OLLAMA_HOST=0.0.0.0"',
        '===END===',
      ].join('\n'),
      err: '',
      code: 0,
      ms: 1,
    });
    await runFleetCommand(['backends', '--backends', 'ollama']);
    // One probe per node, nothing else: no sudo, no apply script.
    expect(mocks.sshCapture).toHaveBeenCalledTimes(2);
    for (const call of mocks.sshCapture.mock.calls) {
      expect(String(call[1])).not.toContain('sudo');
      expect(String(call[1])).not.toContain('systemctl restart');
    }
    const printed = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(printed).toContain('CONFLICT');
    expect(printed).toContain('move zzzz-bind-all.conf → zzzz-bind-all.conf.disabled-by-cihub-');
    expect(process.exitCode).toBeUndefined();
  });
});

/**
 * An Ollama that is already answering is adopted, not installed — and the fourteen nodes that
 * already run one are exactly where the bind arrangements diverge. The adopt path converges them,
 * except where it must not.
 */
describe('fleet backends --execute on an adopted ollama', () => {
  const probe = (dropins: string, extra = '') =>
    [
      'bind_probe=1',
      'unit_file=/etc/systemd/system/ollama.service',
      'show:ActiveState=active',
      'show:UnitFileState=enabled',
      'show:Environment=OLLAMA_HOST=100.64.0.9:11434',
      'tailscale_ip=100.64.0.9',
      extra,
      dropins,
    ].join('\n');
  const dropin = (name: string, value: string) =>
    `===DROPIN /etc/systemd/system/ollama.service.d/${name}===\n[Service]\nEnvironment="OLLAMA_HOST=${value}"\n===END===`;

  beforeEach(() => {
    mocks.nodes = [{ name: 'core-1', ip: '10.0.0.1' }];
    mocks.planAllBackends.mockReturnValue([{ backend: 'ollama', action: 'adopt', why: 'already answering on :11434' }]);
    mocks.executeBackendPlan.mockResolvedValue({ backend: 'ollama', outcome: 'adopted', why: 'already answering on :11434' });
  });

  it('refuses the system-unit path on a node whose port belongs to a user-scope unit, and exits 0', async () => {
    // beta-1: ollama-local.service under the ci user's systemd --user, system unit disabled.
    mocks.sshCapture.mockResolvedValue({
      ok: true,
      out: probe(
        dropin('override.conf', '0.0.0.0'),
        'ss=LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:* users:(("ollama",pid=2417,fd=3))\nowner=2417 ci /user.slice/user-1000.slice/user@1000.service/app.slice/ollama-local.service',
      ),
      err: '',
      code: 0,
      ms: 1,
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--execute']);
    // The probe, and nothing under sudo.
    expect(mocks.sshCapture).toHaveBeenCalledTimes(1);
    const printed = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(printed).toMatch(/skipped.*ollama-local\.service under ci's systemd --user/);
    expect(process.exitCode).toBeUndefined();
  });

  it('touches nothing on a node that already reads back as managed for this bind', async () => {
    const canonical = canonicalBindDropinContent({ host: '100.64.0.9', port: 11434, address: '100.64.0.9:11434' }).trimEnd();
    mocks.sshCapture.mockResolvedValue({
      ok: true,
      out: probe(`===DROPIN /etc/systemd/system/ollama.service.d/${CANONICAL_BIND_DROPIN}===\n${canonical}\n===END===`),
      err: '',
      code: 0,
      ms: 1,
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--execute']);
    expect(mocks.sshCapture).toHaveBeenCalledTimes(1);
    const printed = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(printed).toContain(`bind already 100.64.0.9:11434 ← ${CANONICAL_BIND_DROPIN}`);
    expect(process.exitCode).toBeUndefined();
  });

  it('applies the bind on a conflicted node, and fails the run when the read-back does not match', async () => {
    mocks.sshCapture
      .mockResolvedValueOnce({
        ok: true,
        out: probe(`${dropin('zzz-tailnet-bind.conf', '100.64.0.9:11434')}\n${dropin('zzzz-bind-all.conf', '0.0.0.0')}`),
        err: '',
        code: 0,
        ms: 1,
      })
      .mockResolvedValueOnce({
        ok: false,
        out: 'ollama-bind-disabled: zzzz-bind-all.conf → zzzz-bind-all.conf.disabled-by-cihub-2026-09-10',
        err: "ollama-bind-mismatch: requested OLLAMA_HOST=100.64.0.9:11434 but systemd resolved '0.0.0.0' (drop-ins in merge order: /etc/systemd/system/ollama.service.d/zzzzzz-manual.conf)",
        code: 1,
        ms: 1,
      });
    await runFleetCommand(['backends', '--backends', 'ollama', '--execute']);
    expect(mocks.sshCapture).toHaveBeenCalledTimes(2);
    expect(String(mocks.sshCapture.mock.calls[1]?.[1])).toContain('sudo -n bash');
    const printed = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(printed).toContain("systemd resolved '0.0.0.0'");
    expect(process.exitCode).toBe(1);
  });

  it('converges a conflicted node and stays exit 0 when the read-back matches', async () => {
    mocks.sshCapture
      .mockResolvedValueOnce({
        ok: true,
        out: probe(`${dropin('zzz-tailnet-bind.conf', '100.64.0.9:11434')}\n${dropin('zzzz-bind-all.conf', '0.0.0.0')}`),
        err: '',
        code: 0,
        ms: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        out: [
          'ollama-bind-disabled: zzz-tailnet-bind.conf → zzz-tailnet-bind.conf.disabled-by-cihub-2026-09-10',
          'ollama-bind-disabled: zzzz-bind-all.conf → zzzz-bind-all.conf.disabled-by-cihub-2026-09-10',
          'ollama-bind-effective: OLLAMA_HOST=100.64.0.9:11434 listening=100.64.0.9:11434',
          'ollama-bind-complete',
        ].join('\n'),
        err: '',
        code: 0,
        ms: 1,
      });
    await runFleetCommand(['backends', '--backends', 'ollama', '--bind', 'tailnet', '--execute']);
    const printed = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(printed).toContain('OLLAMA_HOST=100.64.0.9:11434');
    expect(printed).toContain('zzzz-bind-all.conf.disabled-by-cihub-2026-09-10');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('fleet apps', () => {
  it('fails when an app cannot get inference credentials', async () => {
    mocks.sshCapture.mockResolvedValue({ ok: true, out: 'pool-routes-present', err: '', code: 0, ms: 5 });
    mocks.checkAppOnNode.mockResolvedValue({ slug: 'clara', ok: false, detail: '401 from /api/apps' });
    await runFleetCommand(['apps']);
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 when every check passed', async () => {
    mocks.sshCapture.mockResolvedValue({ ok: true, out: 'pool-routes-present', err: '', code: 0, ms: 5 });
    mocks.checkAppOnNode.mockResolvedValue({ slug: 'clara', ok: true, detail: 'app-creds-ok' });
    await runFleetCommand(['apps']);
    expect(mocks.checkAppOnNode).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

/**
 * `fleet cert` — a finding is an answer; a failed measurement or a broken promise is a failure.
 *
 * "absent" on a dry run exits 0: the command was asked what the fleet has and said so. A node it
 * could not measure at all, or one where `tailscale cert` ran and the store still lacks the file,
 * is the failure the exit code exists to carry.
 */
describe('fleet cert', () => {
  const finding = (value: string, via = 'test') => ({ cert: { value, via }, fqdn: { value: 'hub.example-tailnet.ts.net', via: 'test' } });
  const result = (over: Record<string, unknown>) => ({
    before: finding('absent'),
    final: finding('absent'),
    ok: true,
    detail: '',
    plan: 'would run: sudo tailscale cert hub.example-tailnet.ts.net',
    ...over,
  });

  it('exits 0 on a dry run that found certificates missing — that is the answer, not a failure', async () => {
    mocks.ensureTailscaleCert.mockResolvedValue(result({ final: finding('absent') }));
    await runFleetCommand(['cert']);
    expect(mocks.ensureTailscaleCert).toHaveBeenCalledTimes(2);
    expect(mocks.ensureTailscaleCert.mock.calls.every(([, opts]) => (opts as { execute: boolean }).execute === false)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 0 when a node is skipped with a reason, such as HTTPS being off for the tailnet', async () => {
    mocks.ensureTailscaleCert.mockResolvedValue(result({ final: finding('https-not-enabled'), plan: 'would skip: HTTPS is not enabled' }));
    await runFleetCommand(['cert', '--execute']);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails when a node could not be measured at all', async () => {
    mocks.ensureTailscaleCert.mockResolvedValue(result({ final: finding('unknown', 'ssh failed (acl-denied)'), ok: false }));
    await runFleetCommand(['cert']);
    expect(process.exitCode).toBe(1);
  });

  it('fails when tailscale cert ran and the store still lacks the file', async () => {
    mocks.ensureTailscaleCert.mockResolvedValue(
      result({ issue: { value: 'issued', via: 'sudo -n tailscale cert', ms: 10 }, after: finding('absent'), final: finding('absent'), ok: false }),
    );
    await runFleetCommand(['cert', '--execute']);
    expect(mocks.ensureTailscaleCert.mock.calls.every(([, opts]) => (opts as { execute: boolean }).execute === true)).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 when every node issued and verified', async () => {
    mocks.ensureTailscaleCert.mockResolvedValue(
      result({ issue: { value: 'issued', via: 'sudo -n tailscale cert', ms: 10 }, after: finding('present'), final: finding('present'), ok: true }),
    );
    await runFleetCommand(['cert', '--execute']);
    expect(mocks.ensureTailscaleCert).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBeUndefined();
  });

  it('never dials the local node, and does not count it as a failure', async () => {
    mocks.nodes = [{ name: 'here', ip: '10.0.0.9', local: true }];
    await runFleetCommand(['cert', '--execute']);
    expect(mocks.ensureTailscaleCert).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

/**
 * `--nodes core-l` for `core-1` is not the same event as a roster whose entries are all skipped.
 * `partitionForRun` drops an unmatched name into neither `run` nor `skipped`, so both printed "No
 * nodes selected." and both exited 0 — and a scripted `fleet update --nodes $HOST` that had drifted
 * one rename behind reported success for a machine it never touched.
 */
describe('fleet --nodes naming a machine that is not in the roster', () => {
  it('fails when the only name given matches nothing', async () => {
    await runFleetCommand(['update', '--execute', '--hub', '--nodes=core-9']);
    expect(mocks.sshCapture).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('fails on the unknown name while still doing the work for the known one', async () => {
    mocks.sshCapture.mockResolvedValue({ ok: true, out: 'hub-update-complete', err: '', code: 0, ms: 5 });
    await runFleetCommand(['update', '--execute', '--hub', '--nodes=core-1,core-9']);
    expect(updateCalls()).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it('names the node it could not find, rather than reporting a count', async () => {
    const errorSpy = vi.mocked(console.error);
    await runFleetCommand(['update', '--execute', '--hub', '--nodes=core-9']);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain("'core-9'");
  });

  it('exits 0 when a named node exists but is deliberately skipped', async () => {
    // The operator asked for a machine the roster knows and has marked. Nothing was misspelled.
    mocks.nodes = [{ name: 'core-1', ip: '10.0.0.1', skip: 'unreachable' }];
    await runFleetCommand(['update', '--execute', '--hub', '--nodes=core-1']);
    expect(mocks.sshCapture).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 0 on an empty roster, which is a state rather than a typo', async () => {
    mocks.nodes = [];
    await runFleetCommand(['update', '--execute', '--hub']);
    expect(process.exitCode).toBeUndefined();
  });

  it('accepts an address as readily as a name', async () => {
    mocks.sshCapture.mockResolvedValue({ ok: true, out: 'hub-update-complete', err: '', code: 0, ms: 5 });
    await runFleetCommand(['update', '--execute', '--hub', '--nodes=10.0.0.2']);
    expect(updateCalls()).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 0 for every subcommand when each name matches', async () => {
    mocks.checkAppOnNode.mockResolvedValue({ slug: 'clara', ok: true, detail: 'app-creds-ok' });
    mocks.sshCapture.mockResolvedValue({ ok: true, out: 'pool-routes-present', err: '', code: 0, ms: 5 });
    await runFleetCommand(['apps', '--nodes=core-1,core-2']);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails an apps run on an unknown name too', async () => {
    mocks.checkAppOnNode.mockResolvedValue({ slug: 'clara', ok: true, detail: 'app-creds-ok' });
    mocks.sshCapture.mockResolvedValue({ ok: true, out: 'pool-routes-present', err: '', code: 0, ms: 5 });
    await runFleetCommand(['apps', '--nodes=core-1,core-typo']);
    expect(process.exitCode).toBe(1);
  });
});

/**
 * Every node runs the floating `ci-hub:dev` tag, so `docker ps` reads identically across a fleet on
 * four different builds. Measured 2026-09-10: twelve nodes on one image ID, four outliers on three
 * others, two of which changed during the evening with nothing recording it. `update --hub` now
 * reads the image on each side of the redeploy and can pin the build; `status` shows the image.
 */
describe('fleet update --hub image accounting', () => {
  const logged = () =>
    vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');
  const errored = () =>
    vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');

  it('reads the image before and after each update and prints the transition', async () => {
    routeSsh({
      before: { '10.0.0.1': probeOutput('d5ff45d90203'), '10.0.0.2': probeOutput('9a38714ff31a') },
      after: { '10.0.0.1': probeOutput('7370f6f35ab7'), '10.0.0.2': probeOutput('7370f6f35ab7') },
    });
    await runFleetCommand(['update', '--execute', '--hub']);
    expect(probeCalls()).toHaveLength(4);
    expect(updateCalls()).toHaveLength(2);
    expect(logged()).toContain('d5ff45d9 → 7370f6f3');
    expect(logged()).toContain('9a38714f → 7370f6f3');
    expect(logged()).toContain('hub image 7370f6f3 on 2/2');
    expect(process.exitCode).toBeUndefined();
  });

  it('runs the plain floating-tag update without a pin, and says so', async () => {
    mocks.sshCapture.mockResolvedValue(okResult('hub-update-complete'));
    await runFleetCommand(['update', '--execute', '--hub']);
    for (const call of updateCalls()) expect(String(call[1])).not.toContain('CI_HUB_IMAGE');
    // A node whose probe answered nothing useful is unknown on both sides — never a fabricated id.
    expect(logged()).toContain('? (probe returned no image data) → ? (probe returned no image data)');
  });

  it('passes --pin-digest to every node as CI_HUB_IMAGE, and reports success when the node lands on it', async () => {
    const pin = digestOf('d5ff45d90203');
    routeSsh({
      before: { '10.0.0.1': probeOutput('9a38714ff31a'), '10.0.0.2': probeOutput('9a38714ff31a') },
      after: { '10.0.0.1': probeOutput('d5ff45d90203'), '10.0.0.2': probeOutput('d5ff45d90203') },
    });
    await runFleetCommand(['update', '--execute', '--hub', `--pin-digest=${pin}`]);
    expect(updateCalls()).toHaveLength(2);
    for (const call of updateCalls()) expect(String(call[1])).toContain(`export CI_HUB_IMAGE='${pin}'`);
    expect(logged()).toContain('for this run only');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails a pinned update whose node completed but is not running the pinned image', async () => {
    // `pool update` printed its marker, but the node is still on the old build. The operator asked for
    // a digest; "complete" is not the same as "there".
    const pin = digestOf('d5ff45d90203');
    routeSsh({
      before: { '10.0.0.1': probeOutput('9a38714ff31a'), '10.0.0.2': probeOutput('9a38714ff31a') },
      after: { '10.0.0.1': probeOutput('d5ff45d90203'), '10.0.0.2': probeOutput('9a38714ff31a') },
    });
    await runFleetCommand(['update', '--execute', '--hub', `--pin-digest=${pin}`]);
    expect(logged()).toContain('not on the pinned image');
    expect(process.exitCode).toBe(1);
  });

  it('dials nothing on a dry run with a pin, and prints the exact command it would run', async () => {
    const pin = digestOf('d5ff45d90203');
    await runFleetCommand(['update', '--hub', `--pin-digest=${pin}`]);
    expect(mocks.sshCapture).not.toHaveBeenCalled();
    expect(logged()).toContain(`would run: CI_HUB_IMAGE=${pin} cihub pool update`);
    expect(process.exitCode).toBeUndefined();
  });

  describe('--to-majority', () => {
    beforeEach(() => {
      mocks.nodes = [
        { name: 'core-1', ip: '10.0.0.1' },
        { name: 'core-2', ip: '10.0.0.2' },
        { name: 'core-3', ip: '10.0.0.3' },
        { name: 'core-4', ip: '10.0.0.4' },
        { name: 'core-5', ip: '10.0.0.5' },
      ];
    });

    it('pins every targeted node to the digest most of the roster runs', async () => {
      routeSsh({
        before: {
          '10.0.0.1': probeOutput('d5ff45d90203'),
          '10.0.0.2': probeOutput('d5ff45d90203'),
          '10.0.0.3': probeOutput('d5ff45d90203'),
          '10.0.0.4': probeOutput('9a38714ff31a'),
          '10.0.0.5': probeOutput('7370f6f35ab7'),
        },
        after: { '10.0.0.4': probeOutput('d5ff45d90203'), '10.0.0.5': probeOutput('d5ff45d90203') },
      });
      await runFleetCommand(['update', '--execute', '--hub', '--to-majority', '--nodes=core-4,core-5']);
      // The majority is measured over the whole roster, not the two nodes being brought in line.
      expect(logged()).toContain('hub image d5ff45d9 on 3/5');
      expect(updateCalls()).toHaveLength(2);
      for (const call of updateCalls()) expect(String(call[1])).toContain(`export CI_HUB_IMAGE='${digestOf('d5ff45d90203')}'`);
      expect(process.exitCode).toBeUndefined();
    });

    it('refuses when the most common image is not a strict majority, dials no update, and exits 2', async () => {
      routeSsh({
        before: {
          '10.0.0.1': probeOutput('d5ff45d90203'),
          '10.0.0.2': probeOutput('d5ff45d90203'),
          '10.0.0.3': probeOutput('9a38714ff31a'),
          '10.0.0.4': probeOutput('7370f6f35ab7'),
          '10.0.0.5': 'image-probe: container=absent',
        },
      });
      await runFleetCommand(['update', '--execute', '--hub', '--to-majority']);
      expect(updateCalls()).toHaveLength(0);
      expect(errored()).toContain('Refusing --to-majority');
      expect(errored()).toContain('2 of 5 nodes (40%)');
      expect(errored()).toContain('1 node(s) could not be read');
      expect(process.exitCode).toBe(2);
    });

    it('refuses a tie rather than picking a side', async () => {
      routeSsh({
        before: {
          '10.0.0.1': probeOutput('d5ff45d90203'),
          '10.0.0.2': probeOutput('d5ff45d90203'),
          '10.0.0.3': probeOutput('9a38714ff31a'),
          '10.0.0.4': probeOutput('9a38714ff31a'),
          '10.0.0.5': '',
        },
      });
      await runFleetCommand(['update', '--execute', '--hub', '--to-majority']);
      expect(updateCalls()).toHaveLength(0);
      expect(errored()).toMatch(/split 2\/2 of 5/);
      expect(process.exitCode).toBe(2);
    });

    it('refuses to pin to a majority image that no other node can pull', async () => {
      const local = (prefix: string) => probeOutput(prefix, null);
      routeSsh({
        before: {
          '10.0.0.1': local('0badbeef'),
          '10.0.0.2': local('0badbeef'),
          '10.0.0.3': local('0badbeef'),
          '10.0.0.4': probeOutput('9a38714ff31a'),
          '10.0.0.5': probeOutput('9a38714ff31a'),
        },
      });
      await runFleetCommand(['update', '--execute', '--hub', '--to-majority']);
      expect(updateCalls()).toHaveLength(0);
      expect(errored()).toContain('built locally');
      expect(process.exitCode).toBe(2);
    });

    it('measures the fleet on a dry run too, so the plan names the image it would pin', async () => {
      routeSsh({
        before: {
          '10.0.0.1': probeOutput('d5ff45d90203'),
          '10.0.0.2': probeOutput('d5ff45d90203'),
          '10.0.0.3': probeOutput('d5ff45d90203'),
          '10.0.0.4': probeOutput('9a38714ff31a'),
          '10.0.0.5': probeOutput('9a38714ff31a'),
        },
      });
      await runFleetCommand(['update', '--hub', '--to-majority']);
      expect(probeCalls()).toHaveLength(5);
      expect(updateCalls()).toHaveLength(0);
      expect(logged()).toContain(`would run: CI_HUB_IMAGE=${digestOf('d5ff45d90203')} cihub pool update`);
      expect(process.exitCode).toBeUndefined();
    });
  });
});

describe('fleet status image column', () => {
  const logged = () =>
    vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');

  it("shows each node's short image id and a footer naming the drift", async () => {
    mocks.nodes = [
      { name: 'core-1', ip: '10.0.0.1' },
      { name: 'core-2', ip: '10.0.0.2' },
      { name: 'core-3', ip: '10.0.0.3' },
    ];
    routeSsh({
      before: { '10.0.0.1': probeOutput('d5ff45d90203'), '10.0.0.2': probeOutput('d5ff45d90203'), '10.0.0.3': probeOutput('9a38714ff31a') },
    });
    await runFleetCommand(['status']);
    const out = logged();
    expect(out).toContain('IMAGE');
    expect(out).toContain('d5ff45d9');
    expect(out).toContain('hub image d5ff45d9 on 2/3; drifted: core-3 (9a38714f)');
    expect(process.exitCode).toBeUndefined();
  });

  it('marks a node SSH could not reach as unknown with that reason, without dialling it again', async () => {
    mocks.probeNode.mockImplementation(async (node: { ip: string }) =>
      node.ip === '10.0.0.2'
        ? { ssh: false, sshFailure: 'acl-denied', hub: true, hubDetail: 'tier a', engines: ['ollama:11434'] }
        : { ssh: true, sshFailure: 'ok', hub: true, hubDetail: 'tier a', engines: [] },
    );
    routeSsh({ before: { '10.0.0.1': probeOutput('d5ff45d90203') } });
    await runFleetCommand(['status']);
    expect(probeCalls().map((call) => (call[0] as { host: string }).host)).toEqual(['10.0.0.1']);
    expect(logged()).toContain('hub image d5ff45d9 on 1/2; unknown: core-2 (acl-denied)');
  });

  it('carries the image and the fleet summary in --json', async () => {
    routeSsh({ before: { '10.0.0.1': probeOutput('d5ff45d90203'), '10.0.0.2': 'image-probe: container=absent' } });
    await runFleetCommand(['status', '--json']);
    const doc = JSON.parse(logged()) as {
      nodes: { name: string; image: { state: string; reason?: string } }[];
      image: { majority: { count: number } | null };
    };
    expect(doc.nodes.find((n) => n.name === 'core-1')?.image.state).toBe('same');
    expect(doc.nodes.find((n) => n.name === 'core-2')?.image).toEqual({ node: 'core-2', state: 'unknown', reason: 'no ci-hub container' });
    expect(doc.image.majority?.count).toBe(1);
  });
});
