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
  mocks.probeNode.mockReset().mockResolvedValue({ ssh: true, sshFailure: 'ok', hub: false, engines: [] });
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
    ).toEqual(["Bennett's MacBook Pro||", 'Quest 3||', 'core-1||', 'core-2||tailnet reports offline']);
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
});
