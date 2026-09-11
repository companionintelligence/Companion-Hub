/**
 * `cihub fleet rdp` — the whole path from roster to exit code, over a scripted SSH.
 *
 * `sshCapture` is the only seam mocked, so the probe script, the install scripts and their
 * completion markers, the ini round trip and the verification re-read all run for real. What is
 * asserted is the contract an operator relies on: a dry run touches nothing and exits 0; `--execute`
 * is judged on the machine's SECOND answer, not on an install script exiting 0; and a node that ends
 * up reachable off the tailnet fails the run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nodes: [] as import('../lib/fleet-roster.js').FleetNode[],
  sshCapture: vi.fn(),
}));

vi.mock('../lib/fleet-roster.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-roster.js')>()),
  loadFleetRoster: () => ({ nodes: mocks.nodes, source: 'test-roster', dropped: [] }),
}));

vi.mock('../lib/fleet-ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-ssh.js')>()),
  sshCapture: mocks.sshCapture,
}));

import { FleetArgError, parseFleetArgs, runFleetCommand } from '../lib/cli-fleet.js';
import { GUARD_CHAIN } from '../lib/fleet-rdp.js';

const IP = '100.101.102.103';
const ok = (out: string) => ({ ok: true, out, err: '', code: 0, ms: 5 });
const fail = (err: string, code = 1) => ({ ok: false, out: '', err, code, ms: 5 });

const INI = '[Globals]\nport=3389\n\n[Xorg]\nport=-1\n';

/** Probe output for a node in a given state. */
function probeOut(
  state: 'quiet' | 'xrdp-wide' | 'xrdp-tailnet' | 'grd' | 'grd-guarded' | 'other',
  over: { sudo?: string; os?: string; load1?: string } = {},
) {
  const listener = {
    quiet: '',
    'xrdp-wide': 'LISTEN 0 2 *:3389 *:* users:(("xrdp",pid=1,fd=11))',
    'xrdp-tailnet': `LISTEN 0 2 ${IP}:3389 0.0.0.0:* users:(("xrdp",pid=1,fd=11))`,
    grd: 'LISTEN 0 5 *:3389 *:* users:(("gnome-remote-de",pid=2,fd=9))',
    'grd-guarded': 'LISTEN 0 5 *:3389 *:* users:(("gnome-remote-de",pid=2,fd=9))',
    other: 'LISTEN 0 5 0.0.0.0:3389 0.0.0.0:* users:(("docker-proxy",pid=7,fd=4))',
  }[state];
  const guarded = state === 'grd-guarded';
  const chain = guarded
    ? [
        `-N ${GUARD_CHAIN}`,
        `-A ${GUARD_CHAIN} -i lo -p tcp --dport 3389 -j ACCEPT`,
        `-A ${GUARD_CHAIN} -i tailscale0 -p tcp --dport 3389 -j ACCEPT`,
        `-A ${GUARD_CHAIN} -p tcp --dport 3389 -j REJECT --reject-with tcp-reset`,
      ].join('\n')
    : '';
  return [
    `sudo=${over.sudo ?? 'yes'}`,
    `os=${over.os ?? 'Linux'}`,
    'cpus=8',
    `load1=${over.load1 ?? '0.3'}`,
    `tailnet_ip=${IP}`,
    `tailscale0_ip=${IP}`,
    'ip6tables=absent',
    `guard_unit=${guarded ? 'active' : 'inactive'}`,
    `guard_jump4=${guarded ? 'yes' : 'no'}`,
    'guard_jump6=no',
    'guard4-begin',
    chain,
    'guard4-end',
    'guard6-begin',
    'guard6-end',
    'ss-begin',
    'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=9,fd=3))',
    listener,
    'ss-end',
  ].join('\n');
}

/** Script the SSH seam: answer probes and root scripts by what the command contains. */
function scriptSsh(answers: {
  probes: string[];
  prepare?: () => ReturnType<typeof ok>;
  apply?: () => ReturnType<typeof ok>;
  guard?: () => ReturnType<typeof ok>;
}) {
  let probeCalls = 0;
  mocks.sshCapture.mockImplementation(async (_target: unknown, command: string) => {
    if (command.includes('CIHUB_XRDP_PREP_EOF'))
      return (answers.prepare ?? (() => ok(`xsession_user=ci\nini-begin\n${INI}\nini-end\nxrdp-prepare-complete`)))();
    if (command.includes('CIHUB_XRDP_APPLY_EOF')) return (answers.apply ?? (() => ok('xrdp-apply-complete')))();
    if (command.includes('CIHUB_RDP_GUARD_UNIT_EOF')) return (answers.guard ?? (() => ok('rdp-guard-complete')))();
    if (command.includes('ss-begin')) {
      const out = answers.probes[Math.min(probeCalls, answers.probes.length - 1)] ?? '';
      probeCalls += 1;
      return ok(out);
    }
    throw new Error(`unexpected ssh command: ${command.slice(0, 80)}`);
  });
}

const commands = () => mocks.sshCapture.mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  process.exitCode = undefined;
  mocks.nodes = [{ name: 'core-1', ip: IP }];
  mocks.sshCapture.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('fleet rdp dry run', () => {
  it('probes only, prints the plan, and exits 0', async () => {
    scriptSsh({ probes: [probeOut('xrdp-wide')] });
    await runFleetCommand(['rdp']);
    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toContain('ss -ltnp');
    expect(commands()[0]).not.toContain('sudo -n bash');
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 0 even when the plan is a refusal — a dry run reports, it does not fail', async () => {
    scriptSsh({ probes: [probeOut('other')] });
    await runFleetCommand(['rdp']);
    expect(process.exitCode).toBeUndefined();
  });

  it('has no flag to bind every interface', () => {
    // Tailnet-only is the only mode. A flag that widened the bind would be the LAN front door back.
    for (const flag of ['--bind-all', '--address=0.0.0.0', '--expose', '--bind=*']) {
      expect(() => parseFleetArgs(['rdp', flag])).toThrow(FleetArgError);
    }
    expect(parseFleetArgs(['rdp', '--execute', '--nodes=core-1'])).toMatchObject({ subcommand: 'rdp', execute: true, nodes: ['core-1'] });
  });
});

describe('fleet rdp --execute', () => {
  it('installs xrdp on a quiet node, rewrites the ini to the tailnet URL, and passes on the re-read', async () => {
    scriptSsh({ probes: [probeOut('quiet'), probeOut('xrdp-tailnet')] });
    await runFleetCommand(['rdp', '--execute']);
    const cmds = commands();
    expect(cmds).toHaveLength(4); // probe, prepare, apply, verify
    expect(cmds[1]).toContain('sudo -n bash');
    expect(cmds[1]).toContain('apt-get install -y xrdp xfce4 xfce4-terminal dbus-x11');
    expect(cmds[2]).toContain(`port=tcp://${IP}:3389`);
    expect(cmds[2]).not.toMatch(/^address=/m);
    expect(cmds[2]).toContain('port=-1'); // [Xorg] untouched
    expect(cmds[3]).toContain('ss -ltnp');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails when the install exited 0 but the node still answers on *:3389', async () => {
    // The verdict is the machine's second answer. An install that "succeeded" into the address=
    // trap looked exactly like this.
    scriptSsh({ probes: [probeOut('xrdp-wide'), probeOut('xrdp-wide')] });
    await runFleetCommand(['rdp', '--execute']);
    expect(commands()).toHaveLength(4);
    expect(process.exitCode).toBe(1);
  });

  it('installs the guard for gnome-remote-desktop and passes once the rules are read back', async () => {
    scriptSsh({ probes: [probeOut('grd'), probeOut('grd-guarded')] });
    await runFleetCommand(['rdp', '--execute']);
    const cmds = commands();
    expect(cmds).toHaveLength(3); // probe, guard, verify
    expect(cmds[1]).toContain('rdp-tailnet-guard.service');
    expect(cmds[1]).toContain('-p tcp --dport 3389 -j REJECT --reject-with tcp-reset');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails a guard install whose rules did not take', async () => {
    scriptSsh({ probes: [probeOut('grd'), probeOut('grd')] });
    await runFleetCommand(['rdp', '--execute']);
    expect(process.exitCode).toBe(1);
  });

  it('applies nothing to a node already tailnet-only, but still verifies it', async () => {
    scriptSsh({ probes: [probeOut('xrdp-tailnet'), probeOut('xrdp-tailnet')] });
    await runFleetCommand(['rdp', '--execute']);
    expect(commands()).toHaveLength(2); // probe, verify
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses a port held by something else, runs nothing, and fails the node', async () => {
    scriptSsh({ probes: [probeOut('other')] });
    await runFleetCommand(['rdp', '--execute']);
    expect(commands()).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it('refuses a node that is too busy for an apt transaction', async () => {
    // load 40 on 8 cores — the state that once left a node needing hands-on recovery mid-upgrade.
    scriptSsh({ probes: [probeOut('quiet', { load1: '40' })] });
    await runFleetCommand(['rdp', '--execute']);
    expect(commands()).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it('names passwordless sudo when the install cannot elevate', async () => {
    scriptSsh({ probes: [probeOut('quiet')], prepare: () => fail('sudo: a password is required') });
    await runFleetCommand(['rdp', '--execute', '--json']);
    const json = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]).find((line) => String(line).startsWith('['));
    expect(String(json)).toContain('passwordless sudo is not available');
    expect(process.exitCode).toBe(1);
  });

  it('counts a probe that returned nothing as a failure, by name', async () => {
    mocks.sshCapture.mockResolvedValue(fail('ssh: connect to host: No route to host', 255));
    await runFleetCommand(['rdp', '--execute']);
    expect(process.exitCode).toBe(1);
  });
});
