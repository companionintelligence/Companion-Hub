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
import { HUB_CONTEXT_CAP_MARKERS, ollamaRuntimeDropinContent, RUNTIME_DROPIN } from '../lib/fleet-ollama-runtime.js';
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
/** The Hub cap step runs unprivileged: the node's own key on its own loopback, no sudo. */
const capCalls = () =>
  mocks.sshCapture.mock.calls
    .filter(([, command]) => String(command).includes('CIHUB_HUB_CONTEXT_CAP_EOF'))
    .map(([t, c]) => ({ host: (t as SshTarget).host, command: String(c) }));
/** The Hub slot-count step, the same way: `--ollama-parallel`'s Hub half, under its own heredoc. */
const slotCalls = () =>
  mocks.sshCapture.mock.calls
    .filter(([, command]) => String(command).includes('CIHUB_HUB_OLLAMA_SLOTS_EOF'))
    .map(([t, c]) => ({ host: (t as SshTarget).host, command: String(c) }));

/** What the node's Hub answered: the marker lines of a cap step that read `now`, wrote `write`, and read back `after`. */
const capApplied = (now: string, write: string, after?: string) => {
  const m = HUB_CONTEXT_CAP_MARKERS;
  return [
    `${m.key} present`,
    `${m.get} 200`,
    `${m.now} ${now}`,
    `${m.write} ${write}`,
    ...(after === undefined ? [] : [`${m.after} ${after}`]),
    m.complete,
  ].join('\n');
};

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
    if (command.includes('CIHUB_HUB_CONTEXT_CAP_EOF')) return ok(capApplied('none', '200', '16384'));
    if (command.includes('CIHUB_HUB_OLLAMA_SLOTS_EOF')) return ok(capApplied('none', '200', '4'));
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

  it('plans the resident-model cap like any other runtime key: a write where the file lacks it, nothing where it already carries it', async () => {
    // core-2's file carries the cap already and the daemon runs it; core-1 has no runtime file.
    hosts['10.0.0.2'] = {
      bind: bindProbe({
        runtime: ollamaRuntimeDropinContent({ parallel: 4, maxLoaded: 2 }).trimEnd(),
        env: 'OLLAMA_NUM_PARALLEL=4 OLLAMA_MAX_LOADED_MODELS=2',
      }),
      ufw: firewallProbe(UFW_FULL),
    };
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-parallel', '4', '--ollama-max-loaded', '2', '--nodes', 'core-1,core-2']);
    const text = printed();
    expect(sudoCalls()).toHaveLength(0);
    expect(text).toContain('runtime: now OLLAMA_NUM_PARALLEL <unset>, OLLAMA_MAX_LOADED_MODELS <unset>');
    expect(text).toContain(
      `runtime: would write ${RUNTIME_DROPIN} with OLLAMA_NUM_PARALLEL=4 OLLAMA_MAX_LOADED_MODELS=2, then daemon-reload and restart ollama`,
    );
    expect(text).toContain('runtime: now OLLAMA_NUM_PARALLEL 4, OLLAMA_MAX_LOADED_MODELS 2');
    expect(text).toContain(`runtime: ${RUNTIME_DROPIN} already carries OLLAMA_NUM_PARALLEL, OLLAMA_MAX_LOADED_MODELS; ollama not restarted`);
    expect(process.exitCode).toBeUndefined();
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

  it('adds the resident-model cap to a node whose file predates it, and leaves one that already carries it unrestarted', async () => {
    // core-2's file was written by the four-flag CLI (parallel only); core-1 has no runtime file.
    // Both need the write; a third node that already carries the cap does not.
    hosts['10.0.0.4'] = {
      bind: bindProbe({
        runtime: ollamaRuntimeDropinContent({ parallel: 4, maxLoaded: 2 }).trimEnd(),
        env: 'OLLAMA_NUM_PARALLEL=4 OLLAMA_MAX_LOADED_MODELS=2',
      }),
      ufw: firewallProbe(UFW_FULL),
    };
    mocks.nodes.push({ name: 'core-7', ip: '10.0.0.4' });
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_OLLAMA_RUNTIME_EOF')) return ok(runtimeApplied('OLLAMA_NUM_PARALLEL=4 OLLAMA_MAX_LOADED_MODELS=2'));
      if (command.includes('CIHUB_PROBE_FIREWALL_EOF')) return ok(firewallApplied([8080, 8216]));
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand([
      'backends',
      '--backends',
      'ollama',
      '--ollama-parallel',
      '4',
      '--ollama-max-loaded',
      '2',
      '--execute',
      '--nodes',
      'core-1,core-2,core-7',
    ]);
    const text = printed();
    expect(runtimeCalls().map((c) => c.host)).toEqual(['10.0.0.1', '10.0.0.2']);
    for (const call of runtimeCalls()) expect(call.command).toContain('Environment="OLLAMA_MAX_LOADED_MODELS=2"');
    expect(text).toContain('runtime OLLAMA_NUM_PARALLEL <unset> → 4, OLLAMA_MAX_LOADED_MODELS <unset> → 2');
    expect(text).toContain(`runtime OLLAMA_NUM_PARALLEL 4, OLLAMA_MAX_LOADED_MODELS 2 — ${RUNTIME_DROPIN} unchanged, not restarted`);
    expect(process.exitCode).toBeUndefined();
  });

  it('runs the runtime step on a node whose file matches but whose daemon does not, and fails it when the read-back is wrong', async () => {
    // The file is on disk, byte for byte, and `systemctl show` has no OLLAMA_NUM_PARALLEL: a run cut
    // off before daemon-reload, or a later drop-in. "unchanged, not restarted" here would be a lie.
    hosts['10.0.0.2'] = { bind: bindProbe({ runtime: ollamaRuntimeDropinContent({ parallel: 4 }).trimEnd() }), ufw: firewallProbe(UFW_FULL) };
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_OLLAMA_RUNTIME_EOF'))
        return ok(
          [
            'ollama-runtime-before: OLLAMA_HOST=0.0.0.0:11434 OLLAMA_NUM_PARALLEL=1',
            `ollama-runtime-unchanged: ${RUNTIME_DROPIN} already carries OLLAMA_NUM_PARALLEL=4; ollama not restarted`,
            'ollama-runtime-after: OLLAMA_HOST=0.0.0.0:11434 OLLAMA_NUM_PARALLEL=1',
            'ollama-runtime-complete',
          ].join('\n'),
        );
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-parallel', '4', '--execute', '--nodes', 'core-2']);
    expect(runtimeCalls().map((c) => c.host)).toEqual(['10.0.0.2']);
    expect(printed()).toMatch(/ollama\s+failed.*requested OLLAMA_NUM_PARALLEL=4 but systemd resolved OLLAMA_NUM_PARALLEL=1/);
    expect(process.exitCode).toBe(1);

    // The dry run says what it would do about it, rather than "already carries; not restarted".
    output = [];
    process.exitCode = undefined;
    const sudoBefore = sudoCalls().length;
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-parallel', '4', '--nodes', 'core-2']);
    expect(printed()).toContain(
      `runtime: would re-read ${RUNTIME_DROPIN} (already carries OLLAMA_NUM_PARALLEL) — systemd resolves OLLAMA_NUM_PARALLEL=<unset>`,
    );
    expect(sudoCalls()).toHaveLength(sudoBefore);
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

  it('leaves a reject the operator placed ahead of the allow alone, and adds only the ports nothing decides', async () => {
    // beta-1 after the audit's O1: `ufw reject … port 8000,8080,13305` sits above the ollama allow,
    // and the audit asked for reject rather than allow on its :8000. Appending an allow behind it
    // would never fire; the step must say the port fails fast and add nothing for it.
    hosts['10.0.0.1'] = {
      bind: bindProbe({}),
      ufw: firewallProbe(
        [
          'Status: active',
          '',
          'To                         Action      From',
          '--                         ------      ----',
          '8000,8080,13305/tcp        REJECT      172.16.0.0/12              # ci-hub probe: fail fast',
          '11434/tcp                  ALLOW       172.16.0.0/12',
        ].join('\n'),
      ),
    };
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_PROBE_FIREWALL_EOF'))
        return ok(
          [
            'ufw-probe-added: 8216 (Rule added)',
            'ufw-status-begin',
            '8000,8080,13305/tcp        REJECT      172.16.0.0/12',
            '11434/tcp                  ALLOW       172.16.0.0/12',
            '8216/tcp                   ALLOW       172.16.0.0/12',
            'ufw-status-end',
            'ufw-probe-complete',
          ].join('\n'),
        );
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--nodes', 'core-1']);
    expect(printed()).toContain(
      'firewall: ufw active and dropping the bridge on :8216 (:8000, :8080, :13305 refused by a rule of its own, which fails fast and is left alone)',
    );
    expect(printed()).toContain('would run ufw allow from 172.16.0.0/12 to any port 8216 proto tcp');
    expect(printed()).not.toContain('to any port 8000 proto tcp');

    output = [];
    await runFleetCommand(['backends', '--backends', 'ollama', '--execute', '--nodes', 'core-1']);
    const script = firewallCalls()[0]?.command ?? '';
    expect(script).toContain('to any port 8216 proto tcp');
    for (const port of [8000, 8080, 13305]) expect(script).not.toContain(`to any port ${port} proto tcp`);
    expect(printed()).toMatch(/firewall\s+applied.*allowed 172\.16\.0\.0\/12 → :8216/);
    expect(printed()).not.toMatch(/→ :8000/);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails the node when an allow it added sits below a reject that still takes the packet first', async () => {
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
            '8080/tcp                   REJECT      172.16.0.0/12',
            '8080/tcp                   ALLOW       172.16.0.0/12',
            '8216/tcp                   ALLOW       172.16.0.0/12',
            'ufw-status-end',
            'ufw-probe-complete',
          ].join('\n'),
        );
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--execute', '--nodes', 'core-1']);
    expect(printed()).toMatch(/firewall\s+failed.*rule for :8080 but its table still does not admit 172\.16\.0\.0\/12/);
    expect(process.exitCode).toBe(1);
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

// ─── --ollama-parallel and the Hub's slot count ───────────────────────────────────────────────────

describe('fleet backends --ollama-parallel', () => {
  it('plans the Hub write under the runtime plan on a dry run, and dials no Hub', async () => {
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-parallel', '4']);
    const text = printed();
    expect(text).toContain(`runtime: would write ${RUNTIME_DROPIN} with OLLAMA_NUM_PARALLEL=4`);
    expect(text).toContain("hub: would set inferenceOllamaSlots=4 on this node's Hub (PATCH /api/user-settings)");
    expect(text).not.toContain('inferenceMaxNumCtx');
    expect(slotCalls()).toHaveLength(0);
    expect(capCalls()).toHaveLength(0);
    // beta-1's unit is not ours to edit: no runtime line, and so no Hub line either.
    const beta = text.slice(text.indexOf('beta-1'));
    expect(beta).not.toContain('hub: would');

    output = [];
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-parallel', 'unset']);
    expect(printed()).toContain("hub: would clear the slot count on this node's Hub (PATCH /api/inference/preferences ollamaSlots=null)");
    expect(slotCalls()).toHaveLength(0);
  });

  it('writes the slot count on every node where the runtime step applied or was already in effect, after the daemon runs it', async () => {
    hosts['10.0.0.2'] = {
      bind: bindProbe({ runtime: ollamaRuntimeDropinContent({ parallel: 4 }).trimEnd(), env: 'OLLAMA_NUM_PARALLEL=4' }),
      ufw: firewallProbe(UFW_FULL),
    };
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_OLLAMA_RUNTIME_EOF')) return ok(runtimeApplied('OLLAMA_NUM_PARALLEL=4'));
      if (command.includes('CIHUB_PROBE_FIREWALL_EOF')) return ok(firewallApplied([8080, 8216]));
      // core-1's Hub had no slot count; core-2's already carried it.
      if (command.includes('CIHUB_HUB_OLLAMA_SLOTS_EOF'))
        return ok(t.host === '10.0.0.1' ? capApplied('none', '200', '4') : capApplied('4', 'skipped'));
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-parallel', '4', '--execute', '--nodes', 'core-1,core-2']);
    const text = printed();
    expect(runtimeCalls().map((c) => c.host)).toEqual(['10.0.0.1']);
    expect(slotCalls().map((c) => c.host)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(capCalls()).toHaveLength(0);
    for (const call of slotCalls()) {
      expect(call.command.startsWith('bash <<')).toBe(true);
      expect(call.command).not.toContain('sudo');
      expect(call.command).toContain('{"inferenceOllamaSlots":4}');
      expect(call.command).toContain(`grep -q '"ollamaSlots"'`);
      expect(call.command).not.toContain('maxNumCtx');
    }
    expect(text).toMatch(/hub\s+applied.*slot count none → 4 \(PATCH \/api\/user-settings 200\)/);
    expect(text).toMatch(/hub\s+unchanged.*slot count already 4/);
    const core1 = mocks.sshCapture.mock.calls.filter(([t]) => (t as SshTarget).host === '10.0.0.1').map(([, c]) => String(c));
    expect(core1.findIndex((c) => c.includes('CIHUB_OLLAMA_RUNTIME_EOF'))).toBeLessThan(
      core1.findIndex((c) => c.includes('CIHUB_HUB_OLLAMA_SLOTS_EOF')),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('writes both halves, cap then slots, when --ollama-context and --ollama-parallel are given together', async () => {
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_OLLAMA_RUNTIME_EOF')) return ok(runtimeApplied('OLLAMA_NUM_PARALLEL=4 OLLAMA_CONTEXT_LENGTH=16384'));
      if (command.includes('CIHUB_PROBE_FIREWALL_EOF')) return ok(firewallApplied([8080, 8216]));
      if (command.includes('CIHUB_HUB_CONTEXT_CAP_EOF')) return ok(capApplied('none', '200', '16384'));
      if (command.includes('CIHUB_HUB_OLLAMA_SLOTS_EOF')) return ok(capApplied('none', '200', '4'));
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand([
      'backends',
      '--backends',
      'ollama',
      '--ollama-parallel',
      '4',
      '--ollama-context',
      '16384',
      '--execute',
      '--nodes',
      'core-1',
    ]);
    const text = printed();
    expect(capCalls().map((c) => c.host)).toEqual(['10.0.0.1']);
    expect(slotCalls().map((c) => c.host)).toEqual(['10.0.0.1']);
    const core1 = mocks.sshCapture.mock.calls.map(([, c]) => String(c));
    expect(core1.findIndex((c) => c.includes('CIHUB_HUB_CONTEXT_CAP_EOF'))).toBeLessThan(
      core1.findIndex((c) => c.includes('CIHUB_HUB_OLLAMA_SLOTS_EOF')),
    );
    expect(text).toMatch(/hub\s+applied.*context cap none → 16384/);
    expect(text).toMatch(/hub\s+applied.*slot count none → 4/);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails the node when the Hub predates the slot count, naming the fix, and does not touch the Hub on a node the runtime step skipped', async () => {
    // beta-1: user-scope unit → runtime refused → no slot step.
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-parallel', '4', '--execute', '--nodes', 'beta-1']);
    expect(slotCalls()).toHaveLength(0);
    expect(printed()).not.toContain('hub ');

    output = [];
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_OLLAMA_RUNTIME_EOF')) return ok(runtimeApplied('OLLAMA_NUM_PARALLEL=4'));
      if (command.includes('CIHUB_PROBE_FIREWALL_EOF')) return ok(firewallApplied([8080, 8216]));
      if (command.includes('CIHUB_HUB_OLLAMA_SLOTS_EOF')) return ok(capApplied('absent', 'skipped'));
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-parallel', '4', '--execute', '--nodes', 'core-1']);
    expect(slotCalls().map((c) => c.host)).toEqual(['10.0.0.1']);
    expect(printed()).toMatch(/hub\s+failed.*predates the slot count \(GET \/api\/inference\/preferences has no ollamaSlots\)/);
    expect(process.exitCode).toBe(1);
  });
});

// ─── --ollama-context and the Hub's cap ────────────────────────────────────────────────────────────

describe('fleet backends --ollama-context', () => {
  it('plans the Hub write under the runtime plan on a dry run, and dials no Hub', async () => {
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-context', '16384']);
    const text = printed();
    expect(text).toContain(`runtime: would write ${RUNTIME_DROPIN} with OLLAMA_CONTEXT_LENGTH=16384`);
    expect(text).toContain("hub: would set inferenceMaxNumCtx=16384 on this node's Hub (PATCH /api/user-settings)");
    expect(capCalls()).toHaveLength(0);
    // beta-1's unit is not ours to edit: no runtime line, and so no Hub line either.
    const beta = text.slice(text.indexOf('beta-1'));
    expect(beta).not.toContain('hub: would');

    output = [];
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-context', 'unset']);
    expect(printed()).toContain("hub: would clear the context cap on this node's Hub (PATCH /api/inference/preferences maxNumCtx=null)");
    expect(capCalls()).toHaveLength(0);
  });

  it('leaves the Hub alone when neither --ollama-context nor --ollama-parallel was given, even with other runtime flags', async () => {
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-keep-alive', '24h', '--execute', '--nodes', 'core-1']);
    expect(printed()).not.toContain('hub ');
    expect(capCalls()).toHaveLength(0);
    expect(slotCalls()).toHaveLength(0);
  });

  it('writes only the cap when --ollama-parallel was not given', async () => {
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_OLLAMA_RUNTIME_EOF')) return ok(runtimeApplied('OLLAMA_CONTEXT_LENGTH=16384'));
      if (command.includes('CIHUB_PROBE_FIREWALL_EOF')) return ok(firewallApplied([8080, 8216]));
      if (command.includes('CIHUB_HUB_CONTEXT_CAP_EOF')) return ok(capApplied('none', '200', '16384'));
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-context', '16384', '--execute', '--nodes', 'core-1']);
    expect(capCalls()).toHaveLength(1);
    expect(slotCalls()).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('writes the cap on every node where the runtime step applied or was already in effect, unprivileged, reporting was → is', async () => {
    hosts['10.0.0.2'] = {
      bind: bindProbe({ runtime: ollamaRuntimeDropinContent({ contextLength: 16384 }).trimEnd(), env: 'OLLAMA_CONTEXT_LENGTH=16384' }),
      ufw: firewallProbe(UFW_FULL),
    };
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_OLLAMA_RUNTIME_EOF')) return ok(runtimeApplied('OLLAMA_CONTEXT_LENGTH=16384'));
      if (command.includes('CIHUB_PROBE_FIREWALL_EOF')) return ok(firewallApplied([8080, 8216]));
      // core-1's Hub had no cap; core-2's already carried it.
      if (command.includes('CIHUB_HUB_CONTEXT_CAP_EOF'))
        return ok(t.host === '10.0.0.1' ? capApplied('none', '200', '16384') : capApplied('16384', 'skipped'));
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-context', '16384', '--execute', '--nodes', 'core-1,core-2']);
    const text = printed();
    // core-1: runtime written → cap written. core-2: runtime already in effect → cap step still runs, finds it in force.
    expect(runtimeCalls().map((c) => c.host)).toEqual(['10.0.0.1']);
    expect(capCalls().map((c) => c.host)).toEqual(['10.0.0.1', '10.0.0.2']);
    for (const call of capCalls()) {
      expect(call.command.startsWith('bash <<')).toBe(true);
      expect(call.command).not.toContain('sudo');
      expect(call.command).toContain('{"inferenceMaxNumCtx":16384}');
      expect(call.command).toContain("'/var/lib/companion-hub/state/settings.json'");
    }
    expect(text).toMatch(/hub\s+applied.*context cap none → 16384 \(PATCH \/api\/user-settings 200\)/);
    expect(text).toMatch(/hub\s+unchanged.*context cap already 16384/);
    // The runtime step comes first: the daemon runs the context before the Hub is told about it.
    const core1 = mocks.sshCapture.mock.calls.filter(([t]) => (t as SshTarget).host === '10.0.0.1').map(([, c]) => String(c));
    expect(core1.findIndex((c) => c.includes('CIHUB_OLLAMA_RUNTIME_EOF'))).toBeLessThan(
      core1.findIndex((c) => c.includes('CIHUB_HUB_CONTEXT_CAP_EOF')),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('honours --data-dir for the host fallback, and clears through the preferences route on `unset`', async () => {
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_OLLAMA_RUNTIME_EOF')) return ok(runtimeApplied(''));
      if (command.includes('CIHUB_PROBE_FIREWALL_EOF')) return ok(firewallApplied([8080, 8216]));
      if (command.includes('CIHUB_HUB_CONTEXT_CAP_EOF')) return ok(capApplied('65536', '200', 'none'));
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand([
      'backends',
      '--backends',
      'ollama',
      '--ollama-context',
      'unset',
      '--data-dir',
      '/srv/hub',
      '--execute',
      '--nodes',
      'core-1',
    ]);
    expect(capCalls()).toHaveLength(1);
    expect(capCalls()[0]?.command).toContain("'/srv/hub/state/settings.json'");
    expect(capCalls()[0]?.command).toContain('"$cihub_cap_url/inference/preferences"');
    expect(capCalls()[0]?.command).not.toContain('user-settings');
    expect(printed()).toMatch(/hub\s+applied.*context cap 65536 → none \(PATCH \/api\/inference\/preferences 200\)/);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails the node on a non-2xx from the Hub, naming the code, and on a 200 the read-back contradicts', async () => {
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_OLLAMA_RUNTIME_EOF')) return ok(runtimeApplied('OLLAMA_CONTEXT_LENGTH=16384'));
      if (command.includes('CIHUB_PROBE_FIREWALL_EOF')) return ok(firewallApplied([8080, 8216]));
      if (command.includes('CIHUB_HUB_CONTEXT_CAP_EOF')) return ok(capApplied('none', '401'));
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-context', '16384', '--execute', '--nodes', 'core-1']);
    expect(printed()).toMatch(/hub\s+failed.*PATCH \/api\/user-settings answered HTTP 401/);
    expect(process.exitCode).toBe(1);

    output = [];
    process.exitCode = undefined;
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_OLLAMA_RUNTIME_EOF')) return ok(runtimeApplied('OLLAMA_CONTEXT_LENGTH=16384'));
      if (command.includes('CIHUB_PROBE_FIREWALL_EOF')) return ok(firewallApplied([8080, 8216]));
      // An older Hub strips the key it does not know and answers 200 having stored nothing.
      if (command.includes('CIHUB_HUB_CONTEXT_CAP_EOF')) return ok(capApplied('none', '200', 'none'));
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-context', '16384', '--execute', '--nodes', 'core-1']);
    expect(printed()).toMatch(/hub\s+failed.*reads back none, not 16384/);
    expect(process.exitCode).toBe(1);
  });

  it('does not touch the Hub on a node the runtime step skipped or failed', async () => {
    // beta-1: user-scope unit → runtime refused → no cap step.
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-context', '16384', '--execute', '--nodes', 'beta-1']);
    expect(capCalls()).toHaveLength(0);
    expect(printed()).not.toContain('hub ');

    // core-2: the drop-in read back wrong → the node failed → the Hub is not told a context the daemon does not run.
    output = [];
    hosts['10.0.0.2'] = {
      bind: bindProbe({ runtime: ollamaRuntimeDropinContent({ contextLength: 16384 }).trimEnd() }),
      ufw: firewallProbe(UFW_FULL),
    };
    mocks.sshCapture.mockImplementation(async (t: SshTarget, command: string) => {
      const h = hosts[t.host] as NodeFixture;
      if (command.includes('bind_probe=1')) return ok(h.bind);
      if (command.includes('firewall_probe=1')) return ok(h.ufw);
      if (command.includes('CIHUB_OLLAMA_RUNTIME_EOF'))
        return ok(
          [
            'ollama-runtime-before: OLLAMA_HOST=0.0.0.0:11434',
            `ollama-runtime-unchanged: ${RUNTIME_DROPIN} already carries OLLAMA_CONTEXT_LENGTH=16384; ollama not restarted`,
            'ollama-runtime-after: OLLAMA_HOST=0.0.0.0:11434',
            'ollama-runtime-complete',
          ].join('\n'),
        );
      if (command.includes('CIHUB_PROBE_FIREWALL_EOF')) return ok(firewallApplied([8080, 8216]));
      throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
    });
    await runFleetCommand(['backends', '--backends', 'ollama', '--ollama-context', '16384', '--execute', '--nodes', 'core-2']);
    expect(printed()).toMatch(/ollama\s+failed/);
    expect(capCalls()).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });
});
