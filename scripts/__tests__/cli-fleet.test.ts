/**
 * `cihub fleet` — argument parsing, roster handling, and SSH failure classification.
 *
 * The cases below are not hypothetical. Each one encodes a way a real fleet has already misled its
 * operators:
 *
 *   · Two nodes served models for an unknown period while granting no SSH, and every tool called
 *     them healthy because it only ever probed the inference port.
 *   · A roster row's name and IP disagreed — its `core-5` entry was a machine the tailnet calls
 *     `core-4-kvm` — so per-node numbers were attributed to the wrong box.
 *   · Four permanently-unfixable nodes were re-attempted on every run at a 30-second timeout each,
 *     landing in the report indistinguishable from a machine that broke that morning.
 */

import { describe, expect, it } from 'vitest';
import { FleetArgError, parseFleetArgs, resolvePairingCodeStrategy } from '../lib/cli-fleet.js';
import { mergeFleetRoster, parseFleetRoster, partitionForRun, type FleetNode } from '../lib/fleet-roster.js';
import { classifySshFailure, sshDestination, type SshResult } from '../lib/fleet-ssh.js';

const sshResult = (over: Partial<SshResult> = {}): SshResult => ({ ok: false, out: '', err: '', code: 255, ms: 10, ...over });

describe('parseFleetArgs', () => {
  it('defaults to a read-only scan of the roster that writes nothing', () => {
    const args = parseFleetArgs([]);
    expect(args.subcommand).toBe('scan');
    // Neither discovery source is on by default. A LAN sweep touches every address on the operator's
    // subnet, and the tailnet is shared with people who are not the fleet; both must be asked for.
    expect(args.allTailnet).toBe(false);
    expect(args.lan).toBe(false);
    expect(args.writeRoster).toBe(false);
    expect(args.execute).toBe(false);
  });

  it('rejects an unknown subcommand by naming the valid ones', () => {
    expect(() => parseFleetArgs(['instal'])).toThrow(FleetArgError);
    expect(() => parseFleetArgs(['instal'])).toThrow(/scan, list, status/);
  });

  it('accepts both --flag value and --flag=value', () => {
    expect(parseFleetArgs(['scan', '--user', 'root']).user).toBe('root');
    expect(parseFleetArgs(['scan', '--user=root']).user).toBe('root');
    expect(parseFleetArgs(['status', '--nodes=a,b']).nodes).toEqual(['a', 'b']);
  });

  it('defaults the Ollama bind to the tailnet address and accepts the two alternatives', () => {
    expect(parseFleetArgs(['backends']).bind).toBe('tailnet');
    expect(parseFleetArgs(['backends', '--bind', 'all']).bind).toBe('all');
    expect(parseFleetArgs(['backends', '--bind=local']).bind).toBe('local');
    // Anything else is a typo, not a fourth policy.
    expect(() => parseFleetArgs(['backends', '--bind', 'everywhere'])).toThrow(/--bind must be one of tailnet, all, local/);
  });

  it('refuses a flag that swallows the next flag as its value', () => {
    // `--user --json` must not silently set user to "--json" and drop the json flag.
    expect(() => parseFleetArgs(['scan', '--user', '--json'])).toThrow(/--user needs a value/);
  });

  it('bounds timeout and concurrency rather than accepting nonsense', () => {
    expect(() => parseFleetArgs(['scan', '--timeout=10'])).toThrow(/between 250 and 120000/);
    expect(() => parseFleetArgs(['scan', '--concurrency=0'])).toThrow(/between 1 and 32/);
    expect(() => parseFleetArgs(['scan', '--concurrency=2.5'])).toThrow(/integer/);
  });

  it('accepts cert as a subcommand, read-only until --execute', () => {
    expect(parseFleetArgs(['cert']).subcommand).toBe('cert');
    expect(parseFleetArgs(['cert']).execute).toBe(false);
    expect(parseFleetArgs(['cert', '--execute', '--nodes=a', '--user=root'])).toMatchObject({
      subcommand: 'cert',
      execute: true,
      nodes: ['a'],
      user: 'root',
    });
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    // Silently ignoring would let `--dry-run` (which this group does not have) read as accepted.
    expect(() => parseFleetArgs(['scan', '--dry-run'])).toThrow(/Unknown flag/);
  });

  /**
   * The chain matched flags with `startsWith`, so no misspelling ever reached the unknown-flag
   * error — each one landed on whichever real flag it happened to begin with. `--codeword xyz` is
   * the one that matters: `--code` is the Portal pairing credential `install` enrolls a device with,
   * and an invented flag was quietly supplying it.
   */
  it('refuses a flag that merely begins with a real one', () => {
    expect(() => parseFleetArgs(['scan', '--username', 'bob'])).toThrow(/Unknown flag '--username'/);
    expect(() => parseFleetArgs(['install', '--codeword', 'xyz'])).toThrow(/Unknown flag '--codeword'/);
    expect(() => parseFleetArgs(['install', '--codeword=xyz'])).toThrow(/Unknown flag/);
    expect(() => parseFleetArgs(['install', '--pool-pinned=123456'])).toThrow(/Unknown flag/);
    expect(() => parseFleetArgs(['install', '--claim-emails=a@b.co'])).toThrow(/Unknown flag/);
    expect(() => parseFleetArgs(['status', '--nodes-only=a'])).toThrow(/Unknown flag/);
    expect(() => parseFleetArgs(['scan', '--timeouts=500'])).toThrow(/Unknown flag/);
  });

  it('still takes every value flag in both spellings', () => {
    expect(parseFleetArgs(['install', '--code', 'ABC123']).code).toBe('ABC123');
    expect(parseFleetArgs(['install', '--code=ABC123']).code).toBe('ABC123');
    // Registering a node is not the same as claiming it: without this the fleet stands up Hubs that
    // are paired, keyed, and unable to authenticate anybody.
    expect(parseFleetArgs(['install', '--claim-email', 'owner@example.com']).claimEmail).toBe('owner@example.com');
    expect(parseFleetArgs(['install', '--claim-email=owner@example.com']).claimEmail).toBe('owner@example.com');
    expect(parseFleetArgs(['install', '--pool-pin', '123456']).poolPin).toBe('123456');
    expect(parseFleetArgs(['install', '--pool-pin=123456']).poolPin).toBe('123456');
    expect(parseFleetArgs(['install', '--join-pool=hub.tail.ts.net']).joinPool).toBe('hub.tail.ts.net');
    expect(parseFleetArgs(['backends', '--data-dir', '/srv/hub']).dataDir).toBe('/srv/hub');
    expect(parseFleetArgs(['apps', '--endpoint=local']).endpoint).toBe('local');
    expect(parseFleetArgs(['update', '--models', 'llama3,qwen3']).models).toEqual(['llama3', 'qwen3']);
    expect(parseFleetArgs(['backends', '--backends=ollama']).backends).toEqual(['ollama']);
    expect(parseFleetArgs(['scan', '--timeout=500']).timeoutMs).toBe(500);
    expect(parseFleetArgs(['scan', '--concurrency', '8']).concurrency).toBe(8);
  });

  /**
   * Pinning the Hub image. Every node runs the floating `:dev` tag, so an update pass can land two
   * different builds on a fleet depending on when each node's turn came, and nothing says which.
   * These flags name the build; the parser refuses the shapes that only look like they do.
   */
  describe('--pin-digest and --to-majority', () => {
    const sha = `sha256:${'a'.repeat(64)}`;

    it('takes a full repo@digest and a bare digest, completing the latter against the Hub repo', () => {
      expect(parseFleetArgs(['update', '--hub', `--pin-digest=ghcr.io/companionintelligence/ci-hub@${sha}`]).pinDigest).toBe(
        `ghcr.io/companionintelligence/ci-hub@${sha}`,
      );
      expect(parseFleetArgs(['update', '--hub', '--pin-digest', sha]).pinDigest).toBe(`ghcr.io/companionintelligence/ci-hub@${sha}`);
    });

    it('refuses a tag as a pin, since a tag is the mutable thing being escaped', () => {
      expect(() => parseFleetArgs(['update', '--hub', '--pin-digest=ghcr.io/companionintelligence/ci-hub:v0.2.70'])).toThrow(/mutable/);
      expect(() => parseFleetArgs(['update', '--hub', '--pin-digest=d5ff45d9'])).toThrow(/--pin-digest/);
    });

    it('refuses either flag without --hub, and refuses both together', () => {
      expect(() => parseFleetArgs(['update', `--pin-digest=${sha}`])).toThrow(/only apply to `fleet update --hub`/);
      expect(() => parseFleetArgs(['update', '--to-majority'])).toThrow(/only apply to `fleet update --hub`/);
      expect(() => parseFleetArgs(['update', '--hub', '--to-majority', `--pin-digest=${sha}`])).toThrow(/one or the other/);
    });

    it('parses --to-majority as a plain switch', () => {
      const args = parseFleetArgs(['update', '--hub', '--to-majority']);
      expect(args.toMajority).toBe(true);
      expect(args.pinDigest).toBeUndefined();
    });
  });

  it('accepts preflight as a read-only subcommand with no --execute', () => {
    const args = parseFleetArgs(['preflight', '--nodes=core-10', '--touches-boot']);
    expect(args.subcommand).toBe('preflight');
    expect(args.execute).toBe(false);
    expect(args.touchesBoot).toBe(true);
  });

  it('defaults --force and --touches-boot off: a block is a block until somebody says otherwise', () => {
    const args = parseFleetArgs(['install', '--execute']);
    expect(args.force).toBe(false);
    expect(args.touchesBoot).toBe(false);
    expect(parseFleetArgs(['update', '--execute', '--hub', '--force']).force).toBe(true);
  });

  it('refuses a flag that merely begins with --force', () => {
    expect(() => parseFleetArgs(['install', '--forced'])).toThrow(/Unknown flag '--forced'/);
  });
});

describe('resolvePairingCodeStrategy', () => {
  it('mints per node when a device:pair login is stored', () => {
    expect(resolvePairingCodeStrategy({ canMint: true, nodeCount: 12 })).toEqual({ kind: 'mint' });
  });

  it('honours an explicit --code for the single node it can enroll', () => {
    // Naming a code means that code. Minting one instead would enroll a device
    // the operator did not ask for and leave theirs unused.
    expect(resolvePairingCodeStrategy({ code: 'ABC123', canMint: true, nodeCount: 1 })).toEqual({ kind: 'given' });
  });

  it('mints across a fleet even when a --code was passed, since one cannot cover it', () => {
    expect(resolvePairingCodeStrategy({ code: 'ABC123', canMint: true, nodeCount: 12 })).toEqual({ kind: 'mint' });
  });

  it('accepts one --code for exactly one node', () => {
    expect(resolvePairingCodeStrategy({ code: 'ABC123', canMint: false, nodeCount: 1 })).toEqual({ kind: 'given' });
  });

  it('refuses one --code across several nodes, rather than burning it on the first', () => {
    const strategy = resolvePairingCodeStrategy({ code: 'ABC123', canMint: false, nodeCount: 3 });

    expect(strategy.kind).toBe('refuse');
    if (strategy.kind !== 'refuse') return;
    expect(strategy.why).toMatch(/3 nodes are selected/);
    expect(strategy.fix.join(' ')).toMatch(/--scope device:pair/);
  });

  it('refuses with no code and no login, naming both ways out', () => {
    const strategy = resolvePairingCodeStrategy({ canMint: false, nodeCount: 1 });

    expect(strategy.kind).toBe('refuse');
    if (strategy.kind !== 'refuse') return;
    expect(strategy.fix.join(' ')).toMatch(/--scope device:pair/);
    expect(strategy.fix.join(' ')).toMatch(/--code/);
  });
});

describe('classifySshFailure', () => {
  it('separates the two tailnet refusals, which mean opposite things', () => {
    // "as user X" is fixable from this side with --user; the node is administrable.
    expect(classifySshFailure(sshResult({ err: 'tailscale: tailnet policy does not permit you to SSH as user "liam"' }))).toBe('acl-wrong-user');
    // "to this node" is an account-level grant. No flag helps, and this is the state that hid two
    // unadministrable machines behind a healthy-looking inference port.
    expect(classifySshFailure(sshResult({ err: 'tailscale: tailnet policy does not permit you to SSH to this node' }))).toBe('acl-denied');
  });

  it('does not confuse an unreachable host with a denied one', () => {
    expect(classifySshFailure(sshResult({ err: 'ssh: connect to host 100.0.0.1 port 22: No route to host' }))).toBe('unreachable');
    expect(classifySshFailure(sshResult({ err: 'Connection timed out' }))).toBe('unreachable');
  });

  it('reports our own timeout kill as a timeout, not a failure of the node', () => {
    // code null is the signature of the SIGTERM we sent. A node under heavy load lands here, and
    // calling that "unreachable" would send an operator looking for a dead machine.
    expect(classifySshFailure(sshResult({ code: null, err: 'Timed out after 20000ms' }))).toBe('timeout');
  });

  it('reports a connected-but-failed command distinctly from a connection problem', () => {
    expect(classifySshFailure(sshResult({ code: 1, err: 'docker: command not found' }))).toBe('command-failed');
  });

  it('treats success as success regardless of stderr noise', () => {
    // Warnings on stderr are common and must not be read as failure.
    expect(classifySshFailure(sshResult({ ok: true, code: 0, err: 'Warning: Permanently added a host key.' }))).toBe('ok');
  });
});

describe('sshDestination', () => {
  it('omits the user when none is given, deferring to ssh config', () => {
    expect(sshDestination({ host: '100.0.0.1' })).toBe('100.0.0.1');
    expect(sshDestination({ host: '100.0.0.1', user: 'root' })).toBe('root@100.0.0.1');
  });
});

describe('parseFleetRoster', () => {
  it('accepts a bare array or a { nodes } object', () => {
    expect(parseFleetRoster([{ name: 'a', ip: '10.0.0.1' }]).nodes).toHaveLength(1);
    expect(parseFleetRoster({ nodes: [{ name: 'a', ip: '10.0.0.1' }] }).nodes).toHaveLength(1);
  });

  it('drops undialable rows but keeps the rest, and says which it dropped', () => {
    // One bad row in a twenty-node file should cost that row, not the fleet — and never silently,
    // or the operator runs against nineteen nodes believing it is twenty.
    const parsed = parseFleetRoster([{ name: 'good', ip: '10.0.0.1' }, { name: 'no-ip' }, { name: 'bad-ip', ip: '999.1.1.1' }]);
    expect(parsed.nodes.map((n) => n.name)).toEqual(['good']);
    expect(parsed.dropped).toHaveLength(2);
    expect(parsed.dropped.join(' ')).toMatch(/no-ip/);
    expect(parsed.dropped.join(' ')).toMatch(/not a dialable address/);
  });

  it('rejects a duplicate address rather than picking one arbitrarily', () => {
    // The IP is the identity. Two rows for one machine is a real ambiguity, not a harmless repeat.
    const parsed = parseFleetRoster([
      { name: 'core-5', ip: '100.105.166.78' },
      { name: 'core-4-kvm', ip: '100.105.166.78' },
    ]);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.dropped.join(' ')).toMatch(/duplicate/);
  });

  it('ignores a skip value it does not recognise instead of trusting it', () => {
    const parsed = parseFleetRoster([{ name: 'a', ip: '10.0.0.1', skip: 'maybe-later' }]);
    expect(parsed.nodes[0]?.skip).toBeUndefined();
  });

  it('keeps an out-of-band console, which only the roster can know about', () => {
    // A NanoKVM on the HDMI port is invisible from inside the machine. Its presence is what the
    // boot-recovery preflight reads.
    const parsed = parseFleetRoster([
      { name: 'razer', ip: '10.0.0.1', oob: 'nanokvm 192.168.0.115' },
      { name: 'core-10', ip: '10.0.0.2', oob: '   ' },
      { name: 'core-2', ip: '10.0.0.3', oob: 42 },
    ]);
    expect(parsed.nodes[0]?.oob).toBe('nanokvm 192.168.0.115');
    expect(parsed.nodes[1]?.oob).toBeUndefined();
    expect(parsed.nodes[2]?.oob).toBeUndefined();
  });
});

describe('mergeFleetRoster', () => {
  const existing: FleetNode[] = [{ name: 'my-name-for-it', ip: '10.0.0.1', skip: 'llm-only', note: 'ACL gap, see #242', oob: 'ipmi 10.0.9.1' }];

  it('never overwrites operator intent with a discovery result', () => {
    // A scan that cleared `skip` would quietly re-enable a node somebody deliberately excluded.
    const merged = mergeFleetRoster(existing, [{ name: 'tailnet-name', ip: '10.0.0.1' }]);
    expect(merged.nodes[0]?.skip).toBe('llm-only');
    expect(merged.nodes[0]?.note).toBe('ACL gap, see #242');
    expect(merged.nodes[0]?.oob).toBe('ipmi 10.0.9.1');
    expect(merged.nodes[0]?.name).toBe('my-name-for-it');
    expect(merged.added).toHaveLength(0);
  });

  it('does fill in facts about the network', () => {
    const merged = mergeFleetRoster(existing, [{ name: 'x', ip: '10.0.0.1', tailnetName: 'box.tail.ts.net' }]);
    expect(merged.nodes[0]?.tailnetName).toBe('box.tail.ts.net');
  });

  it('adds genuinely new nodes and reports them', () => {
    const merged = mergeFleetRoster(existing, [{ name: 'new', ip: '10.0.0.2' }]);
    expect(merged.nodes).toHaveLength(2);
    expect(merged.added.map((n) => n.ip)).toEqual(['10.0.0.2']);
  });
});

describe('partitionForRun', () => {
  const nodes: FleetNode[] = [
    { name: 'ok', ip: '10.0.0.1' },
    { name: 'here', ip: '127.0.0.1', local: true },
    { name: 'no-ssh', ip: '10.0.0.3', skip: 'llm-only' },
    { name: 'dark', ip: '10.0.0.4', skip: 'unreachable' },
  ];

  it('skips with a reason instead of failing the same nodes every run', () => {
    const { run, skipped } = partitionForRun(nodes);
    expect(run.map((n) => n.name)).toEqual(['ok']);
    expect(skipped.map((s) => s.node.name).sort()).toEqual(['dark', 'here', 'no-ssh']);
    // The reason has to be legible — "skipped: 3" is what made a permanent condition look like
    // today's outage.
    expect(skipped.find((s) => s.node.name === 'no-ssh')?.why).toMatch(/grants no SSH/);
    expect(skipped.find((s) => s.node.name === 'dark')?.why).toMatch(/known down/);
  });

  it('never dials the local node over SSH', () => {
    const { run } = partitionForRun(nodes);
    expect(run.some((n) => n.local)).toBe(false);
  });

  it('matches --nodes on either the name or the address', () => {
    // An operator types whichever identifier they remember.
    expect(partitionForRun(nodes, ['ok']).run.map((n) => n.ip)).toEqual(['10.0.0.1']);
    expect(partitionForRun(nodes, ['10.0.0.1']).run.map((n) => n.name)).toEqual(['ok']);
  });

  it('still honours a skip marker for an explicitly named node', () => {
    // Naming a node is not an override of a recorded reason it cannot work.
    expect(partitionForRun(nodes, ['no-ssh']).run).toHaveLength(0);
  });
});
