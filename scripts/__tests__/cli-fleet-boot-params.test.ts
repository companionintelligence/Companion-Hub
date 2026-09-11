/**
 * `cihub fleet boot-params` end to end, against a fleet shaped like the real one and an SSH layer
 * that answers from fixtures.
 *
 * What these hold the runner to, beyond the pure functions:
 *
 *   · The dry run dials nothing with `sudo`, and exits 0 even when a node would be refused.
 *   · `--execute` writes only on nodes the gate allows. core-10 — hidden zero-timeout menu, no roster
 *     console — is never handed the write, and the run exits 1 so a chain cannot read it as done.
 *   · No SSH command this subcommand ever sends contains a reboot. The "reboot required" list is
 *     printed; the reboot is the operator's.
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
import { computeGttTarget } from '../lib/fleet-boot-params.js';
import type { HostFacts } from '../lib/fleet-hardware.js';
import type { SshTarget } from '../lib/fleet-ssh.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────────────

const RAM = 131072;
const target = computeGttTarget(RAM);

const strixFacts = (over: Partial<HostFacts> = {}): HostFacts => ({
  os: 'linux',
  arch: 'x86_64',
  appleSilicon: false,
  cpuCount: 32,
  load1: 0.3,
  totalRamMib: RAM,
  docker: { present: true, usable: true },
  gpus: [{ vendor: 'amd', gfx: 'gfx1151', reportedVramMib: 2048, gttMib: 62061, driverWorking: true }],
  enginesListening: [],
  notes: [],
  ...over,
});

const nvidiaFacts: HostFacts = strixFacts({ gpus: [{ vendor: 'nvidia', name: 'RTX 3080', reportedVramMib: 10240, driverWorking: true }] });

const CMDLINE_ABSENT = 'BOOT_IMAGE=/boot/vmlinuz-6.14.0-29-generic root=UUID=abc ro quiet splash vt.handoff=7';
const CMDLINE_FULL = `BOOT_IMAGE=/boot/vmlinuz-6.14.0-29-generic root=UUID=abc ro quiet splash ${target.tokens.join(' ')} vt.handoff=7`;

const grubFile = (menu: 'hidden' | 'menu', cmdlineDefault = '"quiet splash"') =>
  [
    'GRUB_DEFAULT=0',
    `GRUB_TIMEOUT_STYLE=${menu}`,
    `GRUB_TIMEOUT=${menu === 'hidden' ? 0 : 5}`,
    `GRUB_CMDLINE_LINUX_DEFAULT=${cmdlineDefault}`,
    'GRUB_CMDLINE_LINUX=""',
    '',
  ].join('\n');

interface HostFixture {
  cmdline: string;
  grub: string;
}

const SHA = 'c'.repeat(64);

/** The byte stream BOOT_PARAM_PROBE_SCRIPT emits for a host: `cat file; echo` gives one newline before the next marker. */
const probeOutput = (h: HostFixture) =>
  [
    '---CIHUB_BOOT_CMDLINE---',
    h.cmdline,
    '---CIHUB_BOOT_GRUB_DEFAULT---',
    h.grub,
    '---CIHUB_BOOT_GRUB_SHA256---',
    SHA,
    '---CIHUB_BOOT_GRUB_OVERRIDES---',
    '',
    '---CIHUB_BOOT_UPDATE_GRUB---',
    'yes',
    '---CIHUB_BOOT_END---',
  ].join('\n');

const hosts: Record<string, HostFixture> = {
  // absent everywhere, menu shown: the plain case
  '10.0.0.1': { cmdline: CMDLINE_ABSENT, grub: grubFile('menu') },
  // live full, staged absent: someone set it by hand and the next reboot would lose it
  '10.0.0.6': { cmdline: CMDLINE_FULL, grub: grubFile('menu') },
  // core-10: absent, hidden zero-timeout menu, and (unless the test says otherwise) no console
  '10.0.0.10': { cmdline: CMDLINE_ABSENT, grub: grubFile('hidden') },
  // single-quoted line: the CI-OS corruption case
  '10.0.0.13': { cmdline: CMDLINE_ABSENT, grub: grubFile('menu', "'quiet splash'") },
};

const facts: Record<string, HostFacts> = {
  '10.0.0.1': strixFacts(),
  '10.0.0.6': strixFacts(),
  '10.0.0.10': strixFacts(),
  '10.0.0.13': strixFacts(),
  '10.0.0.99': nvidiaFacts,
};

let applyResponse = 'boot-params-backup=/etc/default/grub.bak-20260910-120000\nboot-params-staged';
let output: string[] = [];

const sudoCalls = () => mocks.sshCapture.mock.calls.filter(([, command]) => String(command).startsWith('sudo -n bash'));
const sudoHosts = () => sudoCalls().map(([t]) => (t as SshTarget).host);
const printed = () => output.join('\n');

beforeEach(() => {
  process.exitCode = undefined;
  output = [];
  applyResponse = 'boot-params-backup=/etc/default/grub.bak-20260910-120000\nboot-params-staged';
  mocks.nodes = [
    { name: 'core-1', ip: '10.0.0.1' },
    { name: 'core-6', ip: '10.0.0.6' },
    { name: 'core-10', ip: '10.0.0.10' },
    { name: 'core-13', ip: '10.0.0.13' },
    { name: 'bench-1', ip: '10.0.0.99' },
  ];
  mocks.readHostFacts
    .mockReset()
    .mockImplementation(async (t: SshTarget) => ({ facts: facts[t.host] ?? null, error: facts[t.host] ? undefined : 'no such host' }));
  mocks.sshCapture.mockReset().mockImplementation(async (t: SshTarget, command: string) => {
    if (command.includes('---CIHUB_BOOT_CMDLINE---')) {
      const h = hosts[t.host];
      return h ? { ok: true, out: probeOutput(h), err: '', code: 0, ms: 5 } : { ok: false, out: '', err: 'no route', code: 255, ms: 5 };
    }
    if (command.startsWith('sudo -n bash')) return { ok: true, out: applyResponse, err: '', code: 0, ms: 5 };
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

const noRebootEverSent = () => {
  for (const [, command] of mocks.sshCapture.mock.calls) expect(String(command)).not.toMatch(/\b(reboot|shutdown|kexec|poweroff)\b/);
};

// ─── Dry run ───────────────────────────────────────────────────────────────────────────────────────

describe('fleet boot-params (dry run)', () => {
  it('reports live and staged per gfx1151 node, the target, the diff, and writes nothing', async () => {
    await runFleetCommand(['boot-params']);
    const text = printed();

    expect(sudoCalls()).toHaveLength(0);
    expect(text).toContain('Dry run');
    // core-1: absent both sides, an edit planned
    expect(text).toMatch(/core-1 .*131072 MiB RAM/);
    expect(text).toContain(`amdgpu.gttsize=${target.gttSizeMib} ttm.pages_limit=${target.pagesLimit}`);
    expect(text).toContain('- GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"');
    expect(text).toContain(`+ GRUB_CMDLINE_LINUX_DEFAULT="quiet splash ${target.tokens.join(' ')}"`);
    // core-6: live full, staged absent — both said
    const core6 = text.slice(text.indexOf('core-6'), text.indexOf('core-10'));
    expect(core6).toMatch(/live\s+full/);
    expect(core6).toMatch(/staged\s+absent/);
    // bench-1 is not gfx1151 and is left alone
    expect(text).toMatch(/bench-1 .*not gfx1151/);
    noRebootEverSent();
  });

  it('names the nodes it would refuse and why, lists the reboots, and still exits 0', async () => {
    await runFleetCommand(['boot-params']);
    const text = printed();
    expect(text).toContain('Refused');
    expect(text).toMatch(/core-10 has GRUB_TIMEOUT=0 with GRUB_TIMEOUT_STYLE=hidden and no out-of-band console/);
    expect(text).toMatch(/core-13: .*single-quoted/);
    // core-1 gains the parameters after --execute and a reboot; core-6 already runs them; core-10 and
    // core-13 will not be staged, so sending someone to reboot them would be a wasted trip.
    expect(text).toMatch(/Reboot required \(after --execute\) on: core-1\b/);
    expect(text).not.toMatch(/Reboot required .*core-(6|10|13)/);
    expect(text).toContain('This command never reboots');
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 only when a node could not be read', async () => {
    mocks.nodes = [{ name: 'ghost', ip: '10.0.0.77' }];
    await runFleetCommand(['boot-params']);
    expect(printed()).toMatch(/ghost.*could not read hardware/);
    expect(process.exitCode).toBe(1);
  });
});

// ─── --execute ─────────────────────────────────────────────────────────────────────────────────────

describe('fleet boot-params --execute', () => {
  it('writes on the allowed nodes only, never on the gated one, and exits 1 for the refusals', async () => {
    await runFleetCommand(['boot-params', '--execute']);
    // core-1 (edit) and core-6 (edit: staged absent) are written; core-10 (gate), core-13 (quoting) are not.
    expect(sudoHosts().sort()).toEqual(['10.0.0.1', '10.0.0.6']);
    const [, script] = sudoCalls()[0] as [SshTarget, string];
    expect(script).toContain(`GRUB_CMDLINE_LINUX_DEFAULT="quiet splash ${target.tokens.join(' ')}"`);
    expect(script).toContain(`echo "${SHA}  $f" | sha256sum -c --status`);
    expect(script).toContain('update-grub');
    expect(printed()).toMatch(/staged \(\d+s\) — backup at \/etc\/default\/grub\.bak-20260910-120000/);
    // core-1 now needs a reboot; core-6 was already running the target.
    expect(printed()).toMatch(/Reboot required on: core-1$/m);
    expect(process.exitCode).toBe(1);
    noRebootEverSent();
  });

  it('exits 0 when every selected node was staged or already at target', async () => {
    await runFleetCommand(['boot-params', '--execute', '--nodes=core-1,core-6']);
    expect(sudoHosts().sort()).toEqual(['10.0.0.1', '10.0.0.6']);
    expect(process.exitCode).toBeUndefined();
  });

  it('writes on core-10 once the operator asserts a console, and says that is the only reason', async () => {
    await runFleetCommand(['boot-params', '--execute', '--nodes=core-10', '--i-have-console']);
    expect(sudoHosts()).toEqual(['10.0.0.10']);
    expect(printed()).toMatch(/proceeding on --i-have-console/);
    expect(printed()).toMatch(/Reboot required on: core-10$/m);
    expect(process.exitCode).toBeUndefined();
    noRebootEverSent();
  });

  it('writes on core-10 when the roster records its console, naming it', async () => {
    mocks.nodes = [{ name: 'core-10', ip: '10.0.0.10', oob: 'nanokvm 192.168.0.115' }];
    await runFleetCommand(['boot-params', '--execute']);
    expect(sudoHosts()).toEqual(['10.0.0.10']);
    expect(printed()).toContain('nanokvm 192.168.0.115');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a file that changed underneath as a failure and lists no reboot for it', async () => {
    applyResponse = 'boot-params-changed-underneath: /etc/default/grub no longer matches';
    await runFleetCommand(['boot-params', '--execute', '--nodes=core-1']);
    expect(printed()).toMatch(/changed-underneath/);
    expect(printed()).not.toMatch(/Reboot required/);
    expect(process.exitCode).toBe(1);
  });

  it('refuses a node under load before writing', async () => {
    facts['10.0.0.1'] = strixFacts({ load1: 110, cpuCount: 32 });
    try {
      await runFleetCommand(['boot-params', '--execute', '--nodes=core-1']);
      expect(sudoCalls()).toHaveLength(0);
      expect(printed()).toMatch(/refusing to write: load 110/);
      expect(process.exitCode).toBe(1);
    } finally {
      facts['10.0.0.1'] = strixFacts();
    }
  });
});
