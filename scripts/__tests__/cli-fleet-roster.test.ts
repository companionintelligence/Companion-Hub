/**
 * `cihub fleet` — where the list of machines comes from, and where it must not.
 *
 * Measured 2026-09-11 on the shared tailnet: a roster written by `fleet scan --write-roster` held 57
 * rows with no `skip` on any of them, and among them `Aine`, `AlexThinkPad`, `Beam Pro`, `Bennett's
 * MacBook Pro` and `Eric's MacBook Pro` — colleagues' personal devices, seeded from the peer list
 * because every peer was a candidate. From then on every fleet subcommand inherited them, and the
 * mutating ones (`boot-params`, `cert`, `rdp`, `update`, `install`, `backends`) were one `--execute`
 * from writing to whatever the tailnet happened to enumerate.
 *
 * Three rules, each pinned below:
 *
 *   · No roster is a refusal, not a fallback. It names the file and the command that creates it,
 *     exits 1, and dials nothing.
 *   · `scan` re-probes the roster by default. Enumerating the tailnet is `--all-tailnet`, asked for
 *     by name, and the scan lists every peer it would add before `--write-roster` makes them targets.
 *     No ACL tag stands in for that judgement — `tag:ci-server` is an internal test tag.
 *   · `list` and `scan` keep working without a roster, because producing one is their job.
 *
 * Every address here is TEST-NET (RFC 5737). Nothing is dialled: SSH and the HTTP probes are mocked.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  roster: { nodes: [], source: 'test-roster', dropped: [] } as import('../lib/fleet-roster.js').LoadedFleetRoster,
  peers: [] as import('../lib/fleet-discover.js').TailnetPeer[],
  tailnetPeers: vi.fn(),
  saveFleetRoster: vi.fn(),
  sshCapture: vi.fn(),
  probeNode: vi.fn(),
}));

const ROSTER_PATH = '/scratch/companion-hub/fleet.json';

vi.mock('../lib/fleet-roster.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-roster.js')>()),
  loadFleetRoster: () => mocks.roster,
  saveFleetRoster: mocks.saveFleetRoster,
  fleetRosterPath: () => ROSTER_PATH,
}));

vi.mock('../lib/fleet-discover.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-discover.js')>()),
  resolveTailscaleCli: () => '/fake/tailscale',
  tailnetPeers: mocks.tailnetPeers,
  probeNode: mocks.probeNode,
}));

vi.mock('../lib/fleet-ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-ssh.js')>()),
  sshCapture: mocks.sshCapture,
}));

import { parseFleetArgs, runFleetCommand } from '../lib/cli-fleet.js';
import { parseTailnetStatus } from '../lib/fleet-discover.js';

/** The unmocked loader, for the filesystem cases below. */
let realLoadFleetRoster: typeof import('../lib/fleet-roster.js').loadFleetRoster;
beforeAll(async () => {
  realLoadFleetRoster = (await vi.importActual<typeof import('../lib/fleet-roster.js')>('../lib/fleet-roster.js')).loadFleetRoster;
});

/** Every subcommand that dials a machine. `scan` and `list` are deliberately not here. */
const DIALLING = ['status', 'preflight', 'backends', 'install', 'update --hub', 'apps', 'boot-params', 'cert', 'rdp'] as const;

const peer = (name: string, ip: string, over: Partial<import('../lib/fleet-discover.js').TailnetPeer> = {}) => ({
  name,
  ip,
  dnsName: `${name.toLowerCase()}.example.ts.net`,
  online: true,
  ...over,
});

/** A tailnet the shape of the real one: appliances and personal devices side by side, nothing to tell them apart. */
function sharedTailnet() {
  mocks.peers = [
    peer('core-1', '192.0.2.1'),
    peer('core-2', '192.0.2.2', { online: false }),
    peer("Bennett's MacBook Pro", '198.51.100.7'),
    peer('Quest 3', '198.51.100.9'),
  ];
}

let logSpy: MockInstance<typeof console.log>;
let errorSpy: MockInstance<typeof console.error>;
const logged = () => logSpy.mock.calls.map((call) => String(call[0])).join('\n');
const errored = () => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');

type ScannedNode = { name: string; skip?: string; note?: string };
/** The `--json` document a scan printed. */
const scanJson = (): { nodes: ScannedNode[]; notes: string[] } =>
  JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).find((line) => line.startsWith('{')) ?? 'null');

beforeEach(() => {
  process.exitCode = undefined;
  mocks.roster = { nodes: [], source: 'test-roster', dropped: [] };
  mocks.peers = [];
  mocks.tailnetPeers.mockReset().mockImplementation(() => ({ peers: mocks.peers }));
  mocks.saveFleetRoster.mockReset();
  mocks.sshCapture.mockReset().mockResolvedValue({ ok: false, out: '', err: '', code: 255, ms: 1 });
  mocks.probeNode.mockReset().mockResolvedValue({ ssh: true, sshFailure: 'ok', hub: false, hubProbe: 'refused', engines: [] });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('parseTailnetStatus', () => {
  const status = (peers: Record<string, unknown>) =>
    JSON.stringify({ BackendState: 'Running', Self: { HostName: 'me', TailscaleIPs: ['192.0.2.100'] }, Peer: peers });

  it('lists every peer with an IPv4, sorted by name, with the MagicDNS dot trimmed', () => {
    const { peers } = parseTailnetStatus(
      status({
        a: { HostName: 'core-1', DNSName: 'core-1.example.ts.net.', TailscaleIPs: ['192.0.2.1'], Online: true, Tags: ['tag:ci-server'] },
        b: { HostName: 'Quest 3', TailscaleIPs: ['198.51.100.9'], Online: false },
        c: { HostName: 'v6-only', TailscaleIPs: ['fd7a:115c:a1e0::1'] },
      }),
    );
    expect(peers).toEqual([
      { name: 'core-1', ip: '192.0.2.1', dnsName: 'core-1.example.ts.net', os: undefined, online: true },
      { name: 'Quest 3', ip: '198.51.100.9', dnsName: undefined, os: undefined, online: false },
    ]);
  });

  it('never lists Self as a peer', () => {
    const { peers } = parseTailnetStatus(status({}));
    expect(peers).toEqual([]);
  });
});

describe('loadFleetRoster on the real filesystem', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cihub-roster-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports an absent file as a problem naming the path, with no nodes', () => {
    const path = join(dir, 'fleet.json');
    const roster = realLoadFleetRoster(path);
    expect(roster.nodes).toEqual([]);
    expect(roster.problem).toEqual({ kind: 'absent', path });
  });

  it('reports a file that is not JSON as unreadable, with no nodes', () => {
    const path = join(dir, 'fleet.json');
    writeFileSync(path, '{ not json');
    const roster = realLoadFleetRoster(path);
    expect(roster.nodes).toEqual([]);
    expect(roster.problem).toMatchObject({ kind: 'unreadable', path });
  });

  it('treats a file that lists nobody as a loaded roster, not a problem', () => {
    const path = join(dir, 'fleet.json');
    writeFileSync(path, '[]');
    const roster = realLoadFleetRoster(path);
    expect(roster.nodes).toEqual([]);
    expect(roster.problem).toBeUndefined();
  });

  it('refuses the whole file, with no nodes, when any row carries a skip no command honours', () => {
    const path = join(dir, 'fleet.json');
    writeFileSync(
      path,
      JSON.stringify([
        { name: 'core-1', ip: '192.0.2.1' },
        { name: 'core-2', ip: '192.0.2.2', skip: 'excluded-tmp' },
      ]),
    );
    const roster = realLoadFleetRoster(path);
    // Not core-1 alone: a partial fleet is exactly what the operator did not ask for.
    expect(roster.nodes).toEqual([]);
    expect(roster.problem).toEqual({ kind: 'invalid-skip', path, rows: ['row 1 (core-2, 192.0.2.2): "skip": "excluded-tmp"'] });
  });
});

describe('a roster with a skip no command honours', () => {
  // 2026-09-26: 22 of 23 rows were marked "skip": "excluded-tmp" to narrow an install to one node.
  // Every reader here once treated the unknown value as "attempt it", and the install ran on all 23.
  const invalid = () => {
    mocks.roster = {
      nodes: [],
      source: ROSTER_PATH,
      dropped: [],
      problem: { kind: 'invalid-skip', path: ROSTER_PATH, rows: ['row 1 (core-2, 192.0.2.2): "skip": "excluded-tmp"'] },
    };
  };

  for (const command of [...DIALLING, 'install --execute', 'scan', 'scan --all-tailnet --write-roster', 'list', 'list --json']) {
    it(`${command}: refuses, names the row and the values it accepts, exits 1, dials and writes nothing`, async () => {
      invalid();
      sharedTailnet();
      await runFleetCommand(command.split(' '));
      expect(process.exitCode).toBe(1);
      expect(errored()).toContain(ROSTER_PATH);
      expect(errored()).toContain('row 1 (core-2, 192.0.2.2): "skip": "excluded-tmp"');
      expect(errored()).toContain('"llm-only", "unreachable", "excluded"');
      expect(errored()).toContain('--nodes');
      expect(logged()).not.toContain('192.0.2.2');
      expect(mocks.sshCapture).not.toHaveBeenCalled();
      expect(mocks.probeNode).not.toHaveBeenCalled();
      expect(mocks.tailnetPeers).not.toHaveBeenCalled();
      expect(mocks.saveFleetRoster).not.toHaveBeenCalled();
    });
  }

  it('reproduces the 2026-09-26 roster through the real loader, and installs on nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cihub-roster-'));
    try {
      const path = join(dir, 'fleet.json');
      const rows = Array.from({ length: 23 }, (_, i) => ({
        name: `core-${i + 1}`,
        ip: `192.0.2.${i + 1}`,
        ...(i === 5 ? {} : { skip: 'excluded-tmp' }),
      }));
      writeFileSync(path, JSON.stringify(rows));
      mocks.roster = realLoadFleetRoster(path);
      await runFleetCommand(['install', '--execute']);
      expect(process.exitCode).toBe(1);
      expect(errored()).toContain('has 22 row(s) with a "skip" no fleet command recognises');
      expect(errored()).toContain('row 0 (core-1, 192.0.2.1): "skip": "excluded-tmp"');
      expect(errored()).not.toContain('core-6,');
      expect(mocks.sshCapture).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fleet install dry run', () => {
  let configHome: string;
  const saved = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    CI_PORTAL_TOKEN: process.env.CI_PORTAL_TOKEN,
  };
  beforeEach(() => {
    // No Portal login and no GitHub token of the developer's may leak in: the plan reads the one and
    // would resolve a release with the other.
    configHome = mkdtempSync(join(tmpdir(), 'cihub-xdg-'));
    process.env.XDG_CONFIG_HOME = configHome;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.CI_PORTAL_TOKEN;
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(configHome, { recursive: true, force: true });
  });

  it('leads with the count against the roster, one row per node, and lists what the roster holds back', async () => {
    // The old plan was "would install on 23 node(s): …" on one line among ten; an operator who meant
    // one node read past it. "N of M" reads as the whole fleet when it is.
    mocks.roster = {
      nodes: [
        { name: 'core-1', ip: '192.0.2.1' },
        { name: 'core-2', ip: '192.0.2.2' },
        { name: "Bennett's MacBook Pro", ip: '198.51.100.7', skip: 'excluded' },
      ],
      source: ROSTER_PATH,
      dropped: [],
    };
    await runFleetCommand(['install']);
    const lines = logged().split('\n');
    expect(lines).toContain('Would install on 2 of 3 rostered node(s):');
    expect(lines.some((line) => /^ {2}core-1\s+192\.0\.2\.1/.test(line))).toBe(true);
    expect(lines.some((line) => /^ {2}core-2\s+192\.0\.2\.2/.test(line))).toBe(true);
    expect(lines).toContain('Not attempted (1):');
    expect(lines).toContain("  Bennett's MacBook Pro: marked excluded from fleet operations");
    expect(logged()).toContain('--nodes <name,...> narrows this run');
    expect(mocks.sshCapture).not.toHaveBeenCalled();
  });

  it('drops the narrowing hint once --nodes has narrowed it', async () => {
    mocks.roster = {
      nodes: [
        { name: 'core-1', ip: '192.0.2.1' },
        { name: 'core-2', ip: '192.0.2.2' },
      ],
      source: ROSTER_PATH,
      dropped: [],
    };
    await runFleetCommand(['install', '--nodes', 'core-2']);
    expect(logged()).toContain('Would install on 1 of 2 rostered node(s):');
    expect(logged()).not.toMatch(/^ {2}core-1\s/m);
    expect(logged()).not.toContain('narrows this run');
  });
});

describe('a fleet command with no roster', () => {
  for (const command of DIALLING) {
    it(`${command}: refuses, names the file and how to create it, exits 1, dials nothing`, async () => {
      mocks.roster = { nodes: [], source: 'absent', dropped: [], problem: { kind: 'absent', path: ROSTER_PATH } };
      await runFleetCommand(command.split(' '));
      expect(process.exitCode).toBe(1);
      expect(errored()).toContain(ROSTER_PATH);
      expect(errored()).toContain('fleet scan --all-tailnet --write-roster');
      expect(errored()).toContain('"skip": "excluded"');
      expect(mocks.sshCapture).not.toHaveBeenCalled();
      expect(mocks.probeNode).not.toHaveBeenCalled();
    });
  }

  it('refuses on a roster it cannot read, and says why', async () => {
    mocks.roster = { nodes: [], source: 'broken', dropped: ['x'], problem: { kind: 'unreadable', path: ROSTER_PATH, why: 'SyntaxError: bad' } };
    await runFleetCommand(['preflight']);
    expect(process.exitCode).toBe(1);
    expect(errored()).toContain('SyntaxError: bad');
    expect(mocks.sshCapture).not.toHaveBeenCalled();
  });

  it('does not treat an existing roster that lists nobody as an error', async () => {
    // A state the operator arrived at, not a missing file: report it, exit 0, dial nothing.
    mocks.roster = { nodes: [], source: ROSTER_PATH, dropped: ['row 0: no ip'] };
    await runFleetCommand(['preflight']);
    expect(process.exitCode).toBeUndefined();
    expect(logged()).toContain('lists no nodes');
    expect(logged()).toContain('row 0: no ip');
    expect(mocks.sshCapture).not.toHaveBeenCalled();
  });

  it('list still works, and says where it looked', async () => {
    mocks.roster = { nodes: [], source: `${ROSTER_PATH} (not created yet)`, dropped: [], problem: { kind: 'absent', path: ROSTER_PATH } };
    await runFleetCommand(['list']);
    expect(process.exitCode).toBeUndefined();
    expect(logged()).toContain(ROSTER_PATH);
  });
});

describe('fleet scan on a shared tailnet', () => {
  const absent = () => {
    mocks.roster = { nodes: [], source: 'absent', dropped: [], problem: { kind: 'absent', path: ROSTER_PATH } };
  };
  const probedNames = () => mocks.probeNode.mock.calls.map((call) => (call[0] as { name: string }).name).sort();
  const savedRows = () => mocks.saveFleetRoster.mock.calls[0]?.[0] as { name: string; skip?: string; note?: string }[];

  it('parses --all-tailnet, off by default', () => {
    expect(parseFleetArgs(['scan']).allTailnet).toBe(false);
    expect(parseFleetArgs(['scan', '--all-tailnet']).allTailnet).toBe(true);
  });

  it('with no roster and no discovery flag, probes nothing and says which flag enumerates the tailnet', async () => {
    absent();
    sharedTailnet();
    await runFleetCommand(['scan']);
    expect(mocks.tailnetPeers).not.toHaveBeenCalled();
    expect(mocks.probeNode).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(logged()).toContain(ROSTER_PATH);
    expect(logged()).toContain('--all-tailnet');
    expect(logged()).toContain('"skip": "excluded"');
  });

  it('re-probes the roster by default, and never reads the tailnet for it', async () => {
    mocks.roster = { nodes: [{ name: 'core-1', ip: '192.0.2.1' }], source: ROSTER_PATH, dropped: [] };
    sharedTailnet();
    await runFleetCommand(['scan', '--json']);
    expect(mocks.tailnetPeers).not.toHaveBeenCalled();
    expect(probedNames()).toEqual(['core-1']);
    expect(scanJson().nodes.map((n) => n.name)).toEqual(['core-1']);
  });

  it('--all-tailnet probes every peer, and names the ones the roster does not know', async () => {
    mocks.roster = { nodes: [{ name: 'core-1', ip: '192.0.2.1' }], source: ROSTER_PATH, dropped: [] };
    sharedTailnet();
    await runFleetCommand(['scan', '--all-tailnet']);
    expect(probedNames()).toEqual(["Bennett's MacBook Pro", 'Quest 3', 'core-1', 'core-2']);
    expect(logged()).toContain('3 tailnet peer(s) are not in the roster:');
    expect(logged()).toContain("Bennett's MacBook Pro, core-2, Quest 3");
    expect(logged()).not.toContain('being added as targets');
    expect(logged()).toContain(`"skip": "excluded" in ${ROSTER_PATH}`);
    expect(mocks.saveFleetRoster).not.toHaveBeenCalled();
  });

  it('--all-tailnet --write-roster saves every peer as a target and says so', async () => {
    // This is the opt-in the old default did silently. What it writes is targets, so the scan says
    // that in those words and lists them — pruning is the operator's next step, not the scan's guess.
    absent();
    sharedTailnet();
    await runFleetCommand(['scan', '--all-tailnet', '--write-roster']);
    expect(
      savedRows()
        .map((n) => `${n.name}|${n.skip ?? ''}|${n.note ?? ''}`)
        .sort(),
    ).toEqual(["Bennett's MacBook Pro||", 'Quest 3||', 'core-1||', 'core-2||']);
    // core-2 is offline in this fixture. That is the scan's observation, printed in the report and
    // never written into the roster as a note — a note is an operator's, and one the scan wrote
    // once outlived the outage on thirty rows.
    expect(logged()).toContain('4 tailnet peer(s) are not in the roster and are being added as targets:');
    expect(logged()).toContain('Roster written');
  });

  it('does not re-probe a rostered node marked excluded, unless --all-tailnet asks for everything', async () => {
    // The row the operator adds for a colleague's laptop or a KVM dongle. Probing it on every later
    // scan would be the SSH attempt in their auth log the roster exists to stop.
    mocks.roster = {
      nodes: [
        { name: 'core-1', ip: '192.0.2.1' },
        { name: "Bennett's MacBook Pro", ip: '198.51.100.7', skip: 'excluded', note: 'personal device' },
      ],
      source: ROSTER_PATH,
      dropped: [],
    };
    sharedTailnet();
    await runFleetCommand(['scan', '--json']);
    expect(probedNames()).toEqual(['core-1']);
    expect(scanJson().notes.join('\n')).toContain('1 node(s) marked excluded not probed');

    mocks.probeNode.mockClear();
    logSpy.mockClear();
    await runFleetCommand(['scan', '--all-tailnet', '--write-roster']);
    expect(probedNames()).toEqual(["Bennett's MacBook Pro", 'Quest 3', 'core-1', 'core-2']);
    // The roster's own row survives the merge untouched: still excluded, still its note.
    expect(savedRows().find((n) => n.name === "Bennett's MacBook Pro")).toMatchObject({ skip: 'excluded', note: 'personal device' });
    // And it is not among the "not in the roster" names — it was.
    expect(logged()).toContain('2 tailnet peer(s) are not in the roster and are being added as targets:');
    expect(logged()).toContain('core-2, Quest 3');
  });

  it('says so when every rostered node is excluded', async () => {
    mocks.roster = { nodes: [{ name: 'pikvm', ip: '198.51.100.20', skip: 'excluded' }], source: ROSTER_PATH, dropped: [] };
    await runFleetCommand(['scan']);
    expect(mocks.probeNode).not.toHaveBeenCalled();
    expect(logged()).toContain('every rostered node is marked excluded');
  });

  // 2026-09-20: beta-1, beta-nas, core-5 and core-6 read `—` under HUB while serving a Hub under
  // load. A probe that ran out of budget must not print the glyph that means "nothing listening".
  it('renders a timed-out Hub probe as timeout and a slow Hub as slow, and keeps — for a refused port', async () => {
    mocks.roster = {
      nodes: [
        { name: 'beta-1', ip: '192.0.2.11' },
        { name: 'core-5', ip: '192.0.2.5' },
        { name: 'core-9', ip: '192.0.2.9' },
      ],
      source: ROSTER_PATH,
      dropped: [],
    };
    const portal = { phase: 'locally_ready', registered: true, checkIn: 200 };
    mocks.probeNode.mockImplementation(async (node: { name: string }) => {
      if (node.name === 'beta-1') return { ssh: true, sshFailure: 'ok', hub: false, hubProbe: 'timeout', engines: ['ollama:11434'] };
      if (node.name === 'core-5') return { ssh: true, sshFailure: 'ok', hub: true, hubProbe: 'slow', portal, engines: ['ollama:11434'] };
      return { ssh: true, sshFailure: 'ok', hub: false, hubProbe: 'refused', engines: [] };
    });
    await runFleetCommand(['scan']);
    const row = (name: string) =>
      logged()
        .split('\n')
        .find((line) => line.startsWith(name)) ?? '';
    expect(row('beta-1')).toMatch(/^beta-1\s+192\.0\.2\.11\s+yes\s+timeout\s+1\s+reachable, but the Hub probe timed out/);
    expect(row('core-5')).toMatch(/^core-5\s+192\.0\.2\.5\s+yes\s+yes, slow\s+1\s+Hub reachable and administrable/);
    expect(row('core-9')).toMatch(/^core-9\s+192\.0\.2\.9\s+yes\s+—\s+—\s+reachable, no Hub and no engine yet/);
    expect(logged()).toContain('1 node(s) answered nothing on the Hub port within 4000 ms — not the same as no Hub:');
    expect(logged()).toContain('1 Hub(s) answered their phase route but not their backend summary within 10000 ms');
    expect(logged()).toContain('Re-run with a longer --timeout (phase route: 4000 ms, summary: 10000 ms)');

    logSpy.mockClear();
    await runFleetCommand(['scan', '--json']);
    const byName = Object.fromEntries(
      (scanJson().nodes as unknown as { name: string; probe: { hubProbe: string } }[]).map((n) => [n.name, n.probe.hubProbe]),
    );
    expect(byName).toEqual({ 'beta-1': 'timeout', 'core-5': 'slow', 'core-9': 'refused' });
  });
});
