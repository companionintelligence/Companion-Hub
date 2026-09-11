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
 *   · `scan` only treats a tailnet peer as a candidate when it carries `tag:ci-server`, the tag
 *     CI-Engineering's classifier uses to separate appliances from everything else on the tailnet.
 *     `--all-tailnet` widens the probe, and even then an untagged peer is saved as `skip: excluded`.
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
  tailnetPeers: () => ({ peers: mocks.peers }),
  probeNode: mocks.probeNode,
}));

vi.mock('../lib/fleet-ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-ssh.js')>()),
  sshCapture: mocks.sshCapture,
}));

import { parseFleetArgs, runFleetCommand } from '../lib/cli-fleet.js';
import { CI_SERVER_TAG, isFleetTagged, parseTailnetStatus } from '../lib/fleet-discover.js';

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
  tags: [] as string[],
  ...over,
});

/** A tailnet the shape of the real one: appliances tagged, everything else not. */
function sharedTailnet() {
  mocks.peers = [
    peer('core-1', '192.0.2.1', { tags: [CI_SERVER_TAG] }),
    peer('core-2', '192.0.2.2', { tags: [CI_SERVER_TAG, 'ssh'], online: false }),
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
const scannedByName = () => new Map<string, ScannedNode>(scanJson().nodes.map((n) => [n.name, n]));

beforeEach(() => {
  process.exitCode = undefined;
  mocks.roster = { nodes: [], source: 'test-roster', dropped: [] };
  mocks.peers = [];
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

  it('reads each peer’s ACL tags with the tag: prefix stripped, and no tags as an empty list', () => {
    const { peers } = parseTailnetStatus(
      status({
        a: { HostName: 'core-1', TailscaleIPs: ['192.0.2.1'], Tags: ['tag:ci-server', 'tag:ssh'] },
        b: { HostName: 'Quest 3', TailscaleIPs: ['198.51.100.9'] },
        c: { HostName: 'odd', TailscaleIPs: ['198.51.100.10'], Tags: 'tag:not-an-array' },
      }),
    );
    expect(peers.map((p) => [p.name, p.tags])).toEqual([
      ['core-1', ['ci-server', 'ssh']],
      ['odd', []],
      ['Quest 3', []],
    ]);
    expect(peers.map(isFleetTagged)).toEqual([true, false, false]);
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
      expect(errored()).toContain('fleet scan --write-roster');
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

  it('parses --all-tailnet, off by default', () => {
    expect(parseFleetArgs(['scan']).allTailnet).toBe(false);
    expect(parseFleetArgs(['scan', '--all-tailnet']).allTailnet).toBe(true);
  });

  it('probes only the peers tagged ci-server by default, and counts the rest without dialling them', async () => {
    absent();
    sharedTailnet();
    await runFleetCommand(['scan', '--json']);
    expect(probedNames()).toEqual(['core-1', 'core-2']);
    const doc = scanJson();
    expect(doc.nodes.map((n) => n.name)).toEqual(['core-1', 'core-2']);
    expect(doc.notes.join('\n')).toContain('4 peer(s) enumerated, 2 tagged ci-server');
    expect(doc.notes.join('\n')).toContain('2 untagged peer(s) not probed');
    expect(doc.notes.join('\n')).toContain('--all-tailnet');
  });

  it('with --all-tailnet probes every peer, and marks the untagged ones excluded rather than as targets', async () => {
    absent();
    sharedTailnet();
    await runFleetCommand(['scan', '--all-tailnet', '--json']);
    expect(probedNames()).toEqual(["Bennett's MacBook Pro", 'Quest 3', 'core-1', 'core-2']);
    const byName = scannedByName();
    expect(byName.get('core-1')?.skip).toBeUndefined();
    expect(byName.get('core-2')).toMatchObject({ note: 'tailnet reports offline' });
    expect(byName.get("Bennett's MacBook Pro")).toMatchObject({ skip: 'excluded' });
    expect(byName.get("Bennett's MacBook Pro")?.note).toContain('no tag:ci-server');
    expect(byName.get('Quest 3')).toMatchObject({ skip: 'excluded' });
  });

  it('--write-roster saves only the tagged peers by default', async () => {
    absent();
    sharedTailnet();
    await runFleetCommand(['scan', '--write-roster']);
    expect(mocks.saveFleetRoster).toHaveBeenCalledTimes(1);
    const saved = mocks.saveFleetRoster.mock.calls[0]?.[0] as { name: string; skip?: string }[];
    expect(saved.map((n) => n.name).sort()).toEqual(['core-1', 'core-2']);
    expect(saved.every((n) => n.skip === undefined)).toBe(true);
  });

  it('--all-tailnet --write-roster saves untagged peers as excluded, so no later command dials them', async () => {
    absent();
    sharedTailnet();
    await runFleetCommand(['scan', '--all-tailnet', '--write-roster']);
    const saved = mocks.saveFleetRoster.mock.calls[0]?.[0] as { name: string; ip: string; skip?: string }[];
    expect(saved.map((n) => [n.name, n.skip ?? null]).sort()).toEqual([
      ["Bennett's MacBook Pro", 'excluded'],
      ['Quest 3', 'excluded'],
      ['core-1', null],
      ['core-2', null],
    ]);
    expect(logged()).toContain('2 of them excluded');
    expect(logged()).toContain("Bennett's MacBook Pro, Quest 3");
  });

  it('still probes an untagged peer the roster already lists, and names it as one to review', async () => {
    // A roster row is operator intent. The old scan wrote these rows without asking, so the scan
    // says which rostered nodes the tailnet does not tag, and how to mark them.
    mocks.roster = {
      nodes: [
        { name: "Eric's MacBook Pro", ip: '198.51.100.11' },
        { name: 'demo-1-kvm', ip: '198.51.100.12', skip: 'excluded' },
      ],
      source: ROSTER_PATH,
      dropped: [],
    };
    mocks.peers = [
      peer('core-1', '192.0.2.1', { tags: [CI_SERVER_TAG] }),
      peer("Eric's MacBook Pro", '198.51.100.11'),
      peer('demo-1-kvm', '198.51.100.12'),
    ];
    await runFleetCommand(['scan', '--json']);
    // Eric's row is unmarked, so it is probed; demo-1-kvm is marked excluded, so it is not.
    expect(probedNames()).toEqual(["Eric's MacBook Pro", 'core-1']);
    const notes = scanJson().notes.join('\n');
    expect(notes).toContain("1 rostered node(s) carry no tag:ci-server on the tailnet: Eric's MacBook Pro");
    expect(notes).toContain('"skip": "excluded"');
    // Already marked: nothing to nag about.
    expect(notes).not.toContain('demo-1-kvm');
    // And the roster's own marker is what the scan reports, not a synthesised one.
    const byName = scannedByName();
    expect(byName.get("Eric's MacBook Pro")?.skip).toBeUndefined();
  });

  it('does not re-probe a rostered node marked excluded, unless --all-tailnet asks for everything', async () => {
    // The row `--all-tailnet --write-roster` leaves behind for a colleague's laptop. Probing it on
    // every later scan would be the SSH attempt in their auth log the tag gate exists to stop.
    mocks.roster = {
      nodes: [
        { name: 'core-1', ip: '192.0.2.1' },
        { name: "Bennett's MacBook Pro", ip: '198.51.100.7', skip: 'excluded', note: 'no tag:ci-server' },
      ],
      source: ROSTER_PATH,
      dropped: [],
    };
    sharedTailnet();
    await runFleetCommand(['scan', '--json']);
    expect(probedNames()).toEqual(['core-1', 'core-2']);
    expect(scanJson().notes.join('\n')).toContain('1 node(s) marked excluded not probed');

    mocks.probeNode.mockClear();
    await runFleetCommand(['scan', '--all-tailnet', '--write-roster']);
    expect(probedNames()).toEqual(["Bennett's MacBook Pro", 'Quest 3', 'core-1', 'core-2']);
    // The roster's own row survives the merge untouched: still excluded, still its note.
    const saved = mocks.saveFleetRoster.mock.calls[0]?.[0] as { name: string; skip?: string; note?: string }[];
    expect(saved.find((n) => n.name === "Bennett's MacBook Pro")).toMatchObject({ skip: 'excluded', note: 'no tag:ci-server' });
  });

  it('says what to do when the tailnet has nothing tagged', async () => {
    absent();
    mocks.peers = [peer('Quest 3', '198.51.100.9')];
    await runFleetCommand(['scan']);
    expect(mocks.probeNode).not.toHaveBeenCalled();
    expect(logged()).toContain('tagged ci-server');
    expect(logged()).toContain('--all-tailnet');
  });
});
