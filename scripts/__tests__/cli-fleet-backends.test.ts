/**
 * `cihub fleet backends` with the runtime flags and the probe-firewall step, over a scripted SSH.
 *
 * `sshCapture` and `readHostFacts` are the only seams mocked; the bind probe parser, the runtime
 * and firewall planners, and the apply-shell classifiers all run for real. What is asserted is the
 * operator's contract: a dry run prints every plan and runs nothing under sudo; `--execute` restarts
 * Ollama only when the runtime file would change; a node whose :11434 belongs to a user-scope unit
 * is skipped with the reason and never edited; and the firewall step adds only the rules that are
 * missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nodes: [] as import('../lib/fleet-roster.js').FleetNode[],
  sshCapture: vi.fn(),
  readHostFacts: vi.fn(),
}));

vi.mock('../lib/fleet-roster.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-roster.js')>()),
  loadFleetRoster: () => ({ nodes: mocks.nodes, source: 'test-roster', dropped: [] }),
}));

vi.mock('../lib/fleet-ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-ssh.js')>()),
  sshCapture: mocks.sshCapture,
}));

vi.mock('../lib/fleet-hardware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-hardware.js')>()),
  readHostFacts: mocks.readHostFacts,
}));

import { runFleetCommand } from '../lib/cli-fleet.js';
import type { HostFacts } from '../lib/fleet-hardware.js';
import { CANONICAL_BIND_DROPIN, canonicalBindDropinContent, normalizeOllamaHost } from '../lib/fleet-ollama-bind.js';
import { ollamaRuntimeDropinContent, RUNTIME_DROPIN } from '../lib/fleet-ollama-runtime.js';
import type { SshTarget } from '../lib/fleet-ssh.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────────────

const facts = (over: Partial<HostFacts> = {}): HostFacts => ({
  os: 'linux',
  arch: 'x86_64',
  appleSilicon: false,
  cpuCount: 16,
  load1: 0.2,
  docker: { present: true, usable: true },
  gpus: [],
  enginesListening: [11434],
  notes: [],
  ...over,
});

const ok = (out: string) => ({ ok: true, out, err: '', code: 0, ms: 5 });

/** The bind probe for a node already managed for `--bind all` (guard up), with or without the runtime file. */
function bindProbe(node: { runtime?: string; env?: string; userScope?: boolean }) {
  const bindFile = canonicalBindDropinContent(normalizeOllamaHost('0.0.0.0'));
  const lines = [
    'bind_probe=1',
    'unit_file=/etc/systemd/system/ollama.service',
    `show:ActiveState=${node.userScope ? 'inactive' : 'active'}`,
    `show:UnitFileState=${node.userScope ? 'disabled' : 'enabled'}`,
    'show:NeedDaemonReload=no',
    `show:Environment=OLLAMA_HOST=0.0.0.0:11434 OLLAMA_KEEP_ALIVE=5m${node.env ? ` ${node.env}` : ''}`,
    'tailscale_ip=100.100.1.1',
    'guard_unit=active',
    node.userScope
      ? 'ss=LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:* users:(("ollama",pid=2417,fd=3))'
      : 'ss=LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:* users:(("ollama",pid=901,fd=3))',
    node.userScope
      ? 'owner=2417 ci /user.slice/user-1000.slice/user@1000.service/app.slice/ollama-local.service'
      : 'owner=901 ollama /system.slice/ollama.service',
    `dir_entry=${CANONICAL_BIND_DROPIN}`,
    `===DROPIN /etc/systemd/system/ollama.service.d/${CANONICAL_BIND_DROPIN}===`,
    bindFile,
    '',
    '===END===',
  ];
  if (node.runtime !== undefined) {
    lines.push(`dir_entry=${RUNTIME_DROPIN}`, `===DROPIN /etc/systemd/system/ollama.service.d/${RUNTIME_DROPIN}===`, node.runtime, '', '===END===');
  }
  return lines.join('\n');
}

const UFW_PARTIAL = [
  'Status: active',
  '',
  'To                         Action      From',
  '--                         ------      ----',
  '11434/tcp                  ALLOW       172.16.0.0/12              # ci-hub container -> host ollama',
  '8000/tcp                   ALLOW       172.16.0.0/12',
  '13305/tcp                  ALLOW       172.16.0.0/12',
].join('\n');
const UFW_FULL = [UFW_PARTIAL, '8080/tcp                   ALLOW       172.16.0.0/12', '8216/tcp                   ALLOW       172.16.0.0/12'].join(
  '\n',
);

const firewallProbe = (status: string) =>
  ['firewall_probe=1', 'root=yes', 'ufw_bin=yes', 'ufw_conf=yes', 'ufw-status-begin', status, 'ufw-status-end'].join('\n');

interface NodeFixture {
  bind: string;
  ufw: string;
}
let hosts: Record<string, NodeFixture> = {};
let output: string[] = [];

const printed = () => output.join('\n');
const sudoCalls = () =>
  mocks.sshCapture.mock.calls
    .filter(([, command]) => String(command).startsWith('sudo -n bash'))
    .map(([t, c]) => ({ host: (t as SshTarget).host, command: String(c) }));
const runtimeCalls = () => sudoCalls().filter((c) => c.command.includes('CIHUB_OLLAMA_RUNTIME_EOF'));
const firewallCalls = () => sudoCalls().filter((c) => c.command.includes('CIHUB_PROBE_FIREWALL_EOF'));

const runtimeApplied = (settings: string) =>
  [
    'ollama-runtime-before: OLLAMA_HOST=0.0.0.0:11434 OLLAMA_KEEP_ALIVE=5m',
    `ollama-runtime-written: ${RUNTIME_DROPIN} now carries ${settings}; ollama restarted`,
    `ollama-runtime-after: OLLAMA_HOST=0.0.0.0:11434 OLLAMA_KEEP_ALIVE=5m ${settings}`,
    'ollama-runtime-complete',
  ].join('\n');

const firewallApplied = (ports: number[]) =>
  [
    ...ports.map((p) => `ufw-probe-added: ${p} (Rule added)`),
    'ufw-status-begin',
    ...[8000, 13305, ...ports].map((p) => `${p}/tcp                   ALLOW       172.16.0.0/12`),
    'ufw-status-end',
    'ufw-probe-complete',
  ].join('\n');

beforeEach(() => {
  process.exitCode = undefined;
  output = [];
  hosts = {
    '10.0.0.1': { bind: bindProbe({}), ufw: firewallProbe(UFW_PARTIAL) },
    '10.0.0.2': {
      bind: bindProbe({ runtime: ollamaRuntimeDropinContent({ parallel: 4 }).trimEnd(), env: 'OLLAMA_NUM_PARALLEL=4' }),
      ufw: firewallProbe(UFW_FULL),
    },
    '10.0.0.3': { bind: bindProbe({ userScope: true }), ufw: firewallProbe(UFW_FULL) },
  };
  mocks.nodes = [
    { name: 'core-1', ip: '10.0.0.1' },
    { name: 'core-2', ip: '10.0.0.2' },
    { name: 'beta-1', ip: '10.0.0.3' },
  ];
  mocks.readHostFacts.mockReset().mockImplementation(async () => ({ facts: facts() }));
  mocks.sshCapture.mockReset().mockImplementation(async (t: SshTarget, command: string) => {
    const h = hosts[t.host];
    if (!h) return { ok: false, out: '', err: 'no route', code: 255, ms: 5 };
    if (command.includes('bind_probe=1')) return ok(h.bind);
    if (command.includes('firewall_probe=1')) return ok(h.ufw);
    if (command.includes('CIHUB_OLLAMA_RUNTIME_EOF')) return ok(runtimeApplied('OLLAMA_NUM_PARALLEL=4'));
    if (command.includes('CIHUB_PROBE_FIREWALL_EOF')) return ok(firewallApplied([8080, 8216]));
    throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

// ─── Dry run ───────────────────────────────────────────────────────────────────────────────────────

describe('fleet backends (dry run)', () => {
  it('prints the runtime and firewall plans per node and runs nothing under sudo', async () => {
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-parallel', '4']);
    const text = printed();
    expect(text).toContain('Dry run');
    expect(sudoCalls()).toHaveLength(0);
    // Every SSH call was a read-only probe.
    for (const [, command] of mocks.sshCapture.mock.calls) expect(String(command)).toMatch(/bind_probe=1|firewall_probe=1/);

    // core-1: no runtime file yet → would write and restart; two probe ports still dropped.
    expect(text).toContain('runtime: now OLLAMA_NUM_PARALLEL <unset>');
    expect(text).toContain(`runtime: would write ${RUNTIME_DROPIN} with OLLAMA_NUM_PARALLEL=4, then daemon-reload and restart ollama`);
    expect(text).toContain('firewall: ufw active and dropping the bridge on :8080, :8216 (:8000, :13305 already allowed)');
    expect(text).toContain(
      "firewall:   would run ufw allow from 172.16.0.0/12 to any port 8080 proto tcp comment 'ci-hub container -> host engine :8080'",
    );
    expect(text).not.toContain('port 8000 proto tcp');
    // core-2: already carries it → nothing to change, and every port already allowed.
    expect(text).toContain(`runtime: ${RUNTIME_DROPIN} already carries OLLAMA_NUM_PARALLEL; ollama not restarted`);
    expect(text).toContain('firewall: ufw active; bridge → :8000, :8080, :13305, :8216 already allowed');
    // beta-1: the user-scope unit is named and nothing about the runtime is planned for it.
    expect(text).toMatch(/bind: would refuse — ollama-local\.service under ci's systemd --user/);
    expect(process.exitCode).toBeUndefined();
  });

  it('plans nothing about the runtime when no runtime flag was given, exactly as before', async () => {
    await runFleetCommand(['backends', '--backends', 'ollama']);
    expect(printed()).not.toContain('runtime:');
    expect(sudoCalls()).toHaveLength(0);
  });

  it('refuses a runtime flag on a subcommand it does not apply to', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(runFleetCommand(['update', '--ollama-parallel', '4'])).rejects.toThrow('exit');
    expect(printed()).toContain('only apply to `fleet backends`');
    exit.mockRestore();
  });
});

// ─── Execute ───────────────────────────────────────────────────────────────────────────────────────

describe('fleet backends --execute', () => {
  it('writes the runtime file where it differs, reports was → is, and leaves an unchanged node unrestarted', async () => {
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-parallel', '4', '--execute', '--nodes', 'core-1,core-2']);
    const text = printed();
    // core-1 got the runtime step; core-2, whose file already matched, did not.
    expect(runtimeCalls().map((c) => c.host)).toEqual(['10.0.0.1']);
    expect(runtimeCalls()[0]?.command).toContain('Environment="OLLAMA_NUM_PARALLEL=4"');
    expect(runtimeCalls()[0]?.command).not.toContain(CANONICAL_BIND_DROPIN);
    expect(text).toContain('runtime OLLAMA_NUM_PARALLEL <unset> → 4');
    expect(text).toContain(`runtime OLLAMA_NUM_PARALLEL 4 — ${RUNTIME_DROPIN} unchanged, not restarted`);
    expect(process.exitCode).toBeUndefined();
  });

  it('skips a node whose :11434 belongs to a user-scope unit, with the reason, and never edits it', async () => {
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-parallel', '4', '--execute', '--nodes', 'beta-1']);
    const text = printed();
    expect(text).toMatch(/ollama\s+skipped.*ollama-local\.service under ci's systemd --user/);
    expect(runtimeCalls()).toHaveLength(0);
    // Not a failure: a fact about the machine, reported so the run continues.
    expect(process.exitCode).toBeUndefined();
  });

  it('adds only the missing firewall rules, verifies them, and leaves a complete table alone', async () => {
    await runFleetCommand(['backends', '--backends', 'ollama', '--execute', '--nodes', 'core-1,core-2']);
    const text = printed();
    expect(firewallCalls().map((c) => c.host)).toEqual(['10.0.0.1']);
    const script = firewallCalls()[0]?.command ?? '';
    expect(script).toContain('to any port 8080 proto tcp');
    expect(script).toContain('to any port 8216 proto tcp');
    expect(script).not.toContain('to any port 8000 proto tcp');
    expect(script).not.toContain('to any port 13305 proto tcp');
    expect(text).toMatch(/firewall\s+applied.*allowed 172\.16\.0\.0\/12 → :8080, :8216/);
    expect(text).toMatch(/firewall\s+present — ufw active; bridge → :8000, :8080, :13305, :8216 already allowed/);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails the node when ufw is enabled but its table needs root the account does not have', async () => {
    hosts['10.0.0.1'] = {
      bind: bindProbe({}),
      ufw: ['firewall_probe=1', 'root=no', 'ufw_bin=yes', 'ufw_conf=yes', 'ufw-status-begin', 'ufw-status-end'].join('\n'),
    };
    await runFleetCommand(['backends', '--backends', 'ollama', '--execute', '--nodes', 'core-1']);
    expect(firewallCalls()).toHaveLength(0);
    expect(printed()).toMatch(/firewall\s+failed — ufw is active but its rules need root to read — pass --user/);
    expect(process.exitCode).toBe(1);
  });

  it('fails the run when ufw reports a rule the table still does not carry', async () => {
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_PROBE_FIREWALL_EOF'))
        return ok(
          [
            'ufw-probe-added: 8080 (Rule added)',
            'ufw-probe-added: 8216 (Rule added)',
            'ufw-status-begin',
            'ufw-status-end',
            'ufw-probe-complete',
          ].join('\n'),
        );
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--execute', '--nodes', 'core-1']);
    expect(printed()).toMatch(/firewall\s+failed.*still does not admit 172\.16\.0\.0\/12/);
    expect(process.exitCode).toBe(1);
  });
});
