import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type McpConfig, SAFE_PROBES, buildDockerArgs, discoverMcpApps, missingHostSoftware, resolveEnv, scoreHandshake } from '../qa-mcp';

// Importing the module at all proves the CLI IIFE is guarded — an unguarded `process.exit` in the
// module body would abort the test process before any assertion runs.

describe('resolveEnv', () => {
  const scratch = '/tmp/qa-mcp-scratch';

  it('uses a provided secret over everything else', () => {
    expect(resolveEnv({ key: 'GITHUB_TOKEN', required: true, secret: true }, scratch, { GITHUB_TOKEN: 'real' })).toEqual({ value: 'real' });
  });

  it('mounts a scratch dir for a non-secret path-like arg', () => {
    expect(resolveEnv({ key: 'ALLOWED_PATH', required: true, secret: false }, scratch, {})).toEqual({ value: '/qa', mount: scratch });
    expect(resolveEnv({ key: 'GIT_REPO_DIR', required: false, secret: false }, scratch, {})).toEqual({ value: '/qa', mount: scratch });
  });

  it('injects a placeholder for a required secret with no value (auth is enforced at tools/call)', () => {
    expect(resolveEnv({ key: 'NOTION_TOKEN', required: true, secret: true }, scratch, {})).toEqual({ value: 'ci-qa-placeholder' });
  });

  it('leaves an optional unset var unset', () => {
    expect(resolveEnv({ key: 'USER_AGENT', required: false, secret: false }, scratch, {})).toEqual({});
  });

  it('injects a parseable dummy URL for a required connection-string env (so startup URL parsing passes)', () => {
    const pg = resolveEnv({ key: 'POSTGRES_URL', required: true, secret: true }, scratch, {});
    expect(pg.value).toBe('postgres://qa:qa@127.0.0.1:5432/qa');
    expect(() => new URL(pg.value as string)).not.toThrow();
    // a generic *_URI still gets a valid URL, not the bare placeholder
    expect(() => new URL(resolveEnv({ key: 'SERVICE_URI', required: true, secret: false }, scratch, {}).value as string)).not.toThrow();
  });
});

describe('buildDockerArgs', () => {
  const scratch = '/tmp/qa-mcp-scratch';

  it('wraps a compose main image + command in `docker run -i`', () => {
    const mcp: McpConfig = { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] };
    const compose = { services: [{ image: 'node:22', command: ['node', 'server.js'], isMain: true }] };
    const { dockerArgs, needsSecret } = buildDockerArgs('demo', mcp, compose, scratch, {}, 'qa-stream-demo');
    expect(dockerArgs.slice(0, 6)).toEqual(['run', '-i', '--rm', '--name', 'qa-stream-demo', 'node:22']);
    expect(dockerArgs).toContain('node:22');
    expect(dockerArgs.slice(-2)).toEqual(['node', 'server.js']);
    expect(needsSecret).toBeNull();
  });

  it('passes -e flags + a -v mount and flags a needed secret', () => {
    const mcp: McpConfig = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'fs'],
      env: [
        { key: 'ALLOWED_PATH', required: true, secret: false },
        { key: 'API_TOKEN', required: true, secret: true },
      ],
    };
    const compose = { services: [{ image: 'fs:latest', isMain: true }] };
    const { dockerArgs, env, needsSecret } = buildDockerArgs('fs-app', mcp, compose, scratch, {}, 'qa-stream-fs-app');
    expect(env.ALLOWED_PATH).toBe('/qa');
    expect(env.API_TOKEN).toBe('ci-qa-placeholder');
    expect(dockerArgs).toContain('-v');
    expect(dockerArgs).toContain(`${scratch}:/qa`);
    expect(dockerArgs).toContain('-e');
    expect(needsSecret).toBe('API_TOKEN'); // required + secret + only the placeholder → flagged
  });

  it('reuses a `command: "docker"` app\'s own `docker run` argv, injecting -i/--rm/--name', () => {
    const mcp: McpConfig = {
      transport: 'stdio',
      command: 'docker',
      args: ['run', '-e', 'GITHUB_TOKEN', 'ghcr.io/github/github-mcp-server'],
    };
    const { dockerArgs } = buildDockerArgs('github-mcp', mcp, {}, scratch, {}, 'qa-stream-github-mcp');
    expect(dockerArgs[0]).toBe('run');
    expect(dockerArgs).toContain('-i');
    expect(dockerArgs).toContain('--rm');
    expect(dockerArgs).toContain('--name');
    expect(dockerArgs).toContain('qa-stream-github-mcp');
    expect(dockerArgs).toContain('ghcr.io/github/github-mcp-server');
    // the original `-e GITHUB_TOKEN ghcr.io/...` tail is preserved after the injected flags
    expect(dockerArgs.indexOf('ghcr.io/github/github-mcp-server')).toBeGreaterThan(dockerArgs.indexOf('--name'));
  });
});

describe('scoreHandshake', () => {
  it('passes when the live set is a superset of the declared manifest', () => {
    const r = scoreHandshake(['a', 'b'], ['a', 'b', 'c']);
    expect(r.score).toBe('pass');
    expect(r.notes).toContain('⊇ 2 declared');
  });

  it('warns on tool drift (a declared tool missing from the live list)', () => {
    const r = scoreHandshake(['a', 'b', 'gone'], ['a', 'b']);
    expect(r.score).toBe('warn');
    expect(r.notes).toContain('drift');
    expect(r.notes).toContain('gone');
  });

  it('warns when the server advertises no tools', () => {
    const r = scoreHandshake(['a'], []);
    expect(r.score).toBe('warn');
    expect(r.notes).toContain('EMPTY');
  });

  it('passes a server with no declared manifest as long as it advertises something', () => {
    const r = scoreHandshake([], ['x', 'y']);
    expect(r.score).toBe('pass');
  });
});

describe('missingHostSoftware', () => {
  it('filters out runtimes the fleet container already provides (case-insensitive substring)', () => {
    const mcp: McpConfig = {
      requires: { host_software: ['Node.js 18 or newer', 'uv (pip install uv)', 'Python 3.11 or newer', 'Docker', 'npm'] },
    };
    expect(missingHostSoftware(mcp)).toEqual([]);
  });

  it('surfaces real host software the headless fleet can never provide', () => {
    expect(missingHostSoftware({ requires: { host_software: ['blender>=3.0', 'uv (pip install uv)'] } })).toEqual(['blender>=3.0']);
    expect(missingHostSoftware({ requires: { host_software: ['Unity Editor 2022.3 LTS or newer', 'uv (pip install uv)'] } })).toEqual([
      'Unity Editor 2022.3 LTS or newer',
    ]);
    expect(missingHostSoftware({ requires: { host_software: ['A supported smart TV or Home Assistant integration'] } })).toEqual([
      'A supported smart TV or Home Assistant integration',
    ]);
  });

  it('returns empty for an app with no requires block at all', () => {
    expect(missingHostSoftware({})).toEqual([]);
    expect(missingHostSoftware({ requires: {} })).toEqual([]);
  });
});

describe('SAFE_PROBES', () => {
  it('only curates read-only tools; filesystem probes the mounted scratch path', () => {
    expect(SAFE_PROBES['filesystem-mcp']).toEqual({ tool: 'list_directory', args: { path: '/qa' } });
    // every curated probe targets a tool name and an args object (self-guarded against live schema at call time)
    for (const [, p] of Object.entries(SAFE_PROBES)) {
      expect(typeof p.tool).toBe('string');
      expect(typeof p.args).toBe('object');
    }
  });

  it('curates an offline read-only probe for each headless-executable app (verified probe→ok against live containers)', () => {
    // These run in the DEFAULT sweep — no network, no creds. Each was confirmed to return a result.
    expect(SAFE_PROBES['git-mcp']).toEqual({ tool: 'git_status', args: { repo_path: '/qa' } });
    expect(SAFE_PROBES['sqlite-mcp']).toEqual({ tool: 'list_tables', args: {} });
    expect(SAFE_PROBES['n8n-mcp']).toEqual({ tool: 'tools_documentation', args: {} });
    expect(SAFE_PROBES['chess-mcp']).toEqual({ tool: 'new_game', args: {} });
    for (const id of ['filesystem-mcp', 'chess-mcp', 'brewers-almanack-mcp', 'git-mcp', 'sqlite-mcp', 'n8n-mcp']) {
      expect(SAFE_PROBES[id].net).toBeFalsy(); // offline → default sweep
    }
  });

  it('points brewers-almanack at a real tool (regression: lookup_style does not exist on the live server)', () => {
    expect(SAFE_PROBES['brewers-almanack-mcp'].tool).toBe('search_styles');
    expect(SAFE_PROBES['brewers-almanack-mcp'].tool).not.toBe('lookup_style');
    expect(SAFE_PROBES['brewers-almanack-mcp'].args).toHaveProperty('query'); // search_styles requires `query`
  });

  it('gates network-touching execution proofs behind net:true (skipped unless QA_MCP_PROBE_NET=1)', () => {
    for (const id of ['fetch-mcp', 'youtube-transcript-mcp', 'lego-oracle-mcp']) {
      expect(SAFE_PROBES[id].net).toBe(true);
    }
  });

  it('does NOT probe apps whose every tool requires credentials (no clean no-cred verdict)', () => {
    // reddit-mcp: get_trending_subreddits → tool-error without Reddit API creds; handshake is its ceiling.
    expect(SAFE_PROBES['reddit-mcp']).toBeUndefined();
  });
});

describe('discoverMcpApps', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-mcp-discover-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const writeApp = (name: string, cfg: unknown) => {
    mkdirSync(join(root, name), { recursive: true });
    if (cfg !== undefined) writeFileSync(join(root, name, 'config.json'), JSON.stringify(cfg));
  };

  it('returns only the app dirs whose config.json declares an .mcp block, sorted', () => {
    writeApp('zeta-mcp', { mcp: { transport: 'stdio' } });
    writeApp('alpha-mcp', { mcp: { transport: 'stdio' } });
    writeApp('web-app', { no_gui: false }); // not an MCP app → excluded
    writeApp('no-config', undefined); // dir without config.json → excluded
    writeApp('broken-mcp', '{ this is not json'); // unparseable → excluded, not thrown
    writeFileSync(join(root, 'broken-mcp', 'config.json'), '{ this is not json');
    expect(discoverMcpApps(root)).toEqual(['alpha-mcp', 'zeta-mcp']);
  });

  it('returns [] for a missing store dir instead of throwing', () => {
    expect(discoverMcpApps(join(root, 'does-not-exist'))).toEqual([]);
  });
});
