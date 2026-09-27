/**
 * `cihub fleet install` and Portal's pairing rate limit, at the level of the whole run.
 *
 * Portal allows ten pairings per ten minutes from one network address, and a fleet behind one NAT is
 * one address. The rebuild on 2026-09-26 paired ten nodes back to back and lost the next three to
 * "Too many attempts". These tests pin the run's half of the fix: one pacer shared by every node,
 * spaced by `--pairing-gap` (default from Portal's own limit), a mint refused for rate handed back
 * to `installNode` intact so it can be waited out, and the plan saying what the spacing costs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  installNode: vi.fn(),
  mintPairingCode: vi.fn(),
  nodes: [] as import('../lib/fleet-roster.js').FleetNode[],
}));

vi.mock('../lib/fleet-roster.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-roster.js')>()),
  loadFleetRoster: () => ({ nodes: mocks.nodes, source: 'test-roster', dropped: [] }),
}));

vi.mock('../lib/catalog-submit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/catalog-submit.js')>()),
  readStoredLogin: () => ({ orgSlug: 'demopool1', orgId: 'org-1', token: 't', portalOrigin: 'https://portal.test', scope: 'device:pair' }),
  loginScope: () => 'device:pair',
  mintPairingCode: mocks.mintPairingCode,
}));

vi.mock('../lib/fleet-install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-install.js')>()),
  installNode: mocks.installNode,
}));

const { describePairingPacing, FleetArgError, parseFleetArgs, runFleetCommand } = await import('../lib/cli-fleet.js');
const { stripAnsi } = await import('../lib/cli-ui.js');
const { PairingPacer, PortalRateLimitedError } = await import('../lib/portal-rate-limit.js');
const { readPendingPairingCode } = await import('../lib/fleet-pairing-codes.js');

type InstallOpts = import('../lib/fleet-install.js').InstallOptions;

let configHome: string;
const savedXdg = process.env.XDG_CONFIG_HOME;
const savedTokens = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
const savedGap = process.env.CIHUB_PAIRING_GAP;
const printed = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => stripAnsi(String(c[0]))).join('\n');

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'cihub-xdg-'));
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.CIHUB_POSTGRES_PASSWORD = 'a-long-enough-password';
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.CIHUB_PAIRING_GAP;
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.installNode.mockReset().mockImplementation(async (node: { name: string }) => ({ node: node.name, ok: true, steps: [] }));
  mocks.mintPairingCode.mockReset().mockResolvedValue({ pairingCode: 'ABC123', deviceId: 'dev-1', slug: 'core-2', name: 'core-2' });
  mocks.nodes = [
    { name: 'core-2', ip: '10.0.0.2' },
    { name: 'core-4', ip: '10.0.0.4' },
    { name: 'core-5', ip: '10.0.0.5' },
  ];
});

afterEach(() => {
  process.exitCode = undefined;
  delete process.env.CIHUB_POSTGRES_PASSWORD;
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  if (savedGap === undefined) delete process.env.CIHUB_PAIRING_GAP;
  else process.env.CIHUB_PAIRING_GAP = savedGap;
  for (const [name, value] of Object.entries(savedTokens)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(configHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('--pairing-gap', () => {
  it("defaults to Portal's window over its budget, plus a margin", () => {
    expect(parseFleetArgs(['install']).pairingGapMs).toBe(65_000);
  });

  it('takes whole seconds from the flag or CIHUB_PAIRING_GAP, the flag winning; 0 turns the spacing off', () => {
    expect(parseFleetArgs(['install', '--pairing-gap', '90']).pairingGapMs).toBe(90_000);
    expect(parseFleetArgs(['install', '--pairing-gap=0']).pairingGapMs).toBe(0);
    process.env.CIHUB_PAIRING_GAP = '120';
    expect(parseFleetArgs(['install']).pairingGapMs).toBe(120_000);
    expect(parseFleetArgs(['install', '--pairing-gap', '70']).pairingGapMs).toBe(70_000);
  });

  it('refuses what is not whole seconds between 0 and an hour, naming where it came from', () => {
    expect(() => parseFleetArgs(['install', '--pairing-gap', 'soon'])).toThrow(FleetArgError);
    expect(() => parseFleetArgs(['install', '--pairing-gap=-5'])).toThrow(/--pairing-gap must be whole seconds/);
    expect(() => parseFleetArgs(['install', '--pairing-gap', '6500'])).toThrow(/between 0 and 3600/);
    expect(() => parseFleetArgs(['install', '--pairing-gap', '65.5'])).toThrow(FleetArgError);
    process.env.CIHUB_PAIRING_GAP = 'lots';
    expect(() => parseFleetArgs(['install'])).toThrow(/CIHUB_PAIRING_GAP must be whole seconds/);
  });

  it('leaves every other subcommand alone when CIHUB_PAIRING_GAP is malformed, and the flag still wins over it', () => {
    // Read with the defaults, a stray `90s` in a shell profile refused `fleet status` and the rest,
    // none of which pair, and `--pairing-gap` could not override it: the env was read before argv.
    process.env.CIHUB_PAIRING_GAP = '90s';
    for (const argv of [['status'], ['update', '--hub'], ['list'], ['preflight'], ['scan']]) {
      expect(() => parseFleetArgs(argv), argv.join(' ')).not.toThrow();
    }
    expect(parseFleetArgs(['install', '--pairing-gap', '5']).pairingGapMs).toBe(5_000);
    expect(() => parseFleetArgs(['install'])).toThrow(/CIHUB_PAIRING_GAP must be whole seconds .*got '90s'/);
  });
});

describe('fleet install --execute', () => {
  it('hands every node the same pacer, spaced by the gap, and a way to say it is waiting', async () => {
    await runFleetCommand(['install', '--execute', '--pairing-gap', '90']);

    const given = mocks.installNode.mock.calls.map(([, opts]) => opts as InstallOpts);
    expect(given).toHaveLength(3);
    expect(given[0]?.pairingPacer).toBeInstanceOf(PairingPacer);
    expect(given[0]?.pairingPacer?.gapMs).toBe(90_000);
    expect(given.every((opts) => opts.pairingPacer === given[0]?.pairingPacer)).toBe(true);

    given[0]?.onProgress?.('waiting 47s before pairing');
    expect(printed()).toContain('  … waiting 47s before pairing');
    expect(printed()).toContain('pairings go out 90s apart');
  });

  it('hands back a mint Portal refused for rate as it came, and keeps nothing for it', async () => {
    const refusal = new PortalRateLimitedError({ retryAfterSeconds: 30, said: 'Too many requests' }, 'Portal is rate-limiting device registration');
    mocks.mintPairingCode.mockRejectedValueOnce(refusal);
    let thrown: unknown;
    mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
      try {
        await opts.mintPairingCode?.();
      } catch (error) {
        thrown = error;
      }
      return { node: node.name, ok: false, steps: [] };
    });
    mocks.nodes = [{ name: 'core-2', ip: '10.0.0.2' }];
    await runFleetCommand(['install', '--execute']);

    // The same object, not a message re-wrapped in a plain Error: installNode waits only on the type.
    expect(thrown).toBe(refusal);
    expect(readPendingPairingCode('10.0.0.2', 'org-1')).toBeUndefined();
  });

  it('stops dialling once two nodes in a row gave up on Portal refusing them, and names the rest to rerun', async () => {
    // What installNode does when a node runs out of waits: tell the run's pacer. Without a stop, a
    // run whose every pairing is refused spent about half an hour per node — nine hours or more for
    // seventeen — before it reported anything.
    mocks.nodes = ['core-2', 'core-4', 'core-5', 'core-6'].map((name, i) => ({ name, ip: `10.0.0.${i + 2}` }));
    mocks.installNode.mockImplementation(async (node: { name: string }, opts: InstallOpts) => {
      opts.pairingPacer?.gaveUp(node.name);
      return { node: node.name, ok: false, steps: [{ name: 'hub up + register', ok: false, detail: 'Too many attempts. Try again in 51 seconds.' }] };
    });
    await runFleetCommand(['install', '--execute', '--json']);

    expect(mocks.installNode.mock.calls.map(([node]) => (node as { name: string }).name)).toEqual(['core-2', 'core-4']);
    expect(mocks.mintPairingCode).not.toHaveBeenCalled();
    expect(printed()).toMatch(/not attempted — Portal kept refusing core-2, core-4, one after the other.*so this run stopped pairing/);
    expect(printed()).toContain('0/4 node(s) installed.');
    expect(printed()).toContain('not attempted: core-5, core-6');
    expect(printed()).toContain('rerun with --nodes core-5,core-6');
    expect(process.exitCode).toBe(1);
  });

  it('keeps going when a node registers between two that gave up', async () => {
    mocks.nodes = ['core-2', 'core-4', 'core-5', 'core-6'].map((name, i) => ({ name, ip: `10.0.0.${i + 2}` }));
    mocks.installNode.mockImplementation(async (node: { name: string }, opts: InstallOpts) => {
      if (node.name === 'core-4') {
        opts.pairingPacer?.redeemed({ registered: true });
        return { node: node.name, ok: true, steps: [] };
      }
      opts.pairingPacer?.gaveUp(node.name);
      return { node: node.name, ok: false, steps: [] };
    });
    await runFleetCommand(['install', '--execute']);

    // core-2 gave up, core-4 registered, core-5 gave up, core-6 gave up: only then two in a row, and
    // nothing was left to stop.
    expect(mocks.installNode).toHaveBeenCalledTimes(4);
    expect(printed()).not.toContain('not attempted');
  });
});

describe('the dry run', () => {
  it('says how far apart the pairings go, the most waiting the spacing adds, and the ceiling on waiting out refusals', async () => {
    mocks.nodes = Array.from({ length: 17 }, (_, i) => ({ name: `core-${i + 1}`, ip: `10.0.0.${i + 1}` }));
    await runFleetCommand(['install']);
    expect(printed()).toMatch(
      /pairings go out 65s apart — Portal allows 10 pairings per 10 minutes from one network address.*the spacing alone adds at most ~18 min of waiting across 17 nodes/,
    );
    // "At most ~18 min" once read as the whole run's ceiling; the retries have their own.
    expect(printed()).toMatch(/at most 3 times per pairing and 600s each; once 2 nodes in a row are still refused, the run stops pairing/);
    expect(mocks.installNode).not.toHaveBeenCalled();
  });
});

describe('describePairingPacing', () => {
  it('says nothing for one node, and warns when the gap is under what Portal allows', () => {
    expect(describePairingPacing(65_000, 1)).toBeUndefined();
    expect(describePairingPacing(0, 3)).toMatch(/back to back \(--pairing-gap 0\).*waited out/);
    expect(describePairingPacing(30_000, 3)).toMatch(/30s apart.*closer than the 60s that keeps under Portal's limit/);
  });
});
