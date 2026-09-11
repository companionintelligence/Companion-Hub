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

import { runFleetCommand } from '../lib/cli-fleet.js';
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
    expect(mocks.sshCapture).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBeUndefined();
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
    expect(mocks.sshCapture).toHaveBeenCalledTimes(1);
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
    expect(mocks.sshCapture).toHaveBeenCalledTimes(1);
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
