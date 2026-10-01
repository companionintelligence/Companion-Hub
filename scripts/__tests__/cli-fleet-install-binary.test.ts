/**
 * `cihub fleet install` and where its `cihub` binary comes from: decided once per run, and pinned
 * to a version before any node is dialled.
 *
 * `--cihub-version` defaults to `latest`, and `latest` handed straight to each node's adopt-or-replace
 * decision is not a version: on 2026-09-20 a node kept a July 0.2.36 with a current release in hand.
 * The run now asks GitHub which tag `latest` is, once, and every node compares against that.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  installNode: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../lib/fleet-roster.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-roster.js')>()),
  loadFleetRoster: () => ({ nodes: [{ name: 'core-1', ip: '10.0.0.1' }], source: 'test-roster', dropped: [] }),
}));

vi.mock('../lib/catalog-submit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/catalog-submit.js')>()),
  readStoredLogin: () => ({ orgSlug: 'bill-co', orgId: 'org-1', token: 't', portalOrigin: 'https://portal.test', scope: 'device:pair' }),
  loginScope: () => 'device:pair',
}));

vi.mock('../lib/fleet-install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-install.js')>()),
  installNode: mocks.installNode,
}));

const { runFleetCommand } = await import('../lib/cli-fleet.js');

type InstallOpts = import('../lib/fleet-install.js').InstallOptions;

const savedEnv = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
let logged: string[];

const release = (tag: string) => async (url: string | URL) => {
  expect(String(url)).toBe('https://api.github.com/repos/companionintelligence/CI-Hub/releases/latest');
  return new Response(JSON.stringify({ tag_name: tag, assets: [] }), { status: 200 });
};

beforeEach(() => {
  process.env.CIHUB_POSTGRES_PASSWORD = 'a-long-enough-password';
  process.env.GH_TOKEN = 'ghp_test';
  delete process.env.GITHUB_TOKEN;
  process.exitCode = undefined;
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockReset().mockImplementation(release('v0.2.72'));
  mocks.installNode.mockReset().mockImplementation(async (node: { name: string }) => ({ node: node.name, ok: true, steps: [] }));
});

afterEach(() => {
  process.exitCode = undefined;
  delete process.env.CIHUB_POSTGRES_PASSWORD;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fleet install and the cihub binary source', () => {
  it('resolves `latest` to a tag once, before the first node, and hands every node that tag', async () => {
    await runFleetCommand(['install', '--execute']);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const opts = mocks.installNode.mock.calls[0]?.[1] as InstallOpts;
    expect(opts.cihubBinary).toEqual({ kind: 'release', token: 'ghp_test', version: 'v0.2.72', resolvedFrom: 'latest' });
    expect(logged.join('\n')).toContain('release v0.2.72 (latest)');
  });

  it('says which tag a dry run would install, not just "latest"', async () => {
    await runFleetCommand(['install']);
    expect(mocks.installNode).not.toHaveBeenCalled();
    expect(logged.join('\n')).toContain('release v0.2.72 (latest)');
  });

  it('turns a lookup the token cannot do into an adopt-only run, said once on the summary line', async () => {
    mocks.fetch.mockImplementation(async () => new Response('{"message":"Not Found"}', { status: 404 }));
    await runFleetCommand(['install', '--execute']);
    const opts = mocks.installNode.mock.calls[0]?.[1] as InstallOpts;
    expect(opts.cihubBinary?.kind).toBe('unavailable');
    if (opts.cihubBinary?.kind === 'unavailable') expect(opts.cihubBinary.why).toMatch(/HTTP 404/);
    expect(logged.join('\n')).toMatch(/HTTP 404.*adopted without a version check/);
  });

  it('asks nothing of GitHub when a file is named', async () => {
    // A file that exists but is no binary: its version is unreadable, and the run says what to do.
    const dir = mkdtempSync(join(tmpdir(), 'cihub-bin-'));
    const file = join(dir, 'cihub-linux-arm64');
    writeFileSync(file, 'not an executable');
    try {
      await runFleetCommand(['install', '--execute', '--cihub-binary', file]);
      expect(mocks.fetch).not.toHaveBeenCalled();
      const opts = mocks.installNode.mock.calls[0]?.[1] as InstallOpts;
      expect(opts.cihubBinary).toMatchObject({ kind: 'local', path: file });
      expect(opts.cihubBinary?.kind === 'local' && opts.cihubBinary.version).toBeUndefined();
      expect(logged.join('\n')).toContain('version unknown');

      // --cihub-version then says what the file is, and the node compares against it.
      mocks.installNode.mockClear();
      await runFleetCommand(['install', '--execute', '--cihub-binary', file, '--cihub-version', '0.2.72']);
      expect((mocks.installNode.mock.calls[0]?.[1] as InstallOpts | undefined)?.cihubBinary).toMatchObject({
        kind: 'local',
        path: file,
        version: '0.2.72',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
