import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.fn();
const parseEnvFile = vi.fn();
const existsSync = vi.fn();
const readFileSync = vi.fn();
const statSync = vi.fn();
const dnsLookup = vi.fn();
const readHubApiKey = vi.fn();
const runBridgeDoctorSection = vi.fn();
const isHubContainerRunning = vi.fn();
const resolveHubContainerName = vi.fn();
const probeHostPort = vi.fn();

vi.mock('node:child_process', () => ({ spawnSync: (...args: unknown[]) => spawnSync(...args) }));
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSync(...args),
  readFileSync: (...args: unknown[]) => readFileSync(...args),
  statSync: (...args: unknown[]) => statSync(...args),
}));
vi.mock('node:dns', () => {
  const lookup = (...args: unknown[]) => dnsLookup(...args);
  return { default: { lookup }, lookup };
});
vi.mock('../env-file', () => ({ parseEnvFile: (...args: unknown[]) => parseEnvFile(...args) }));
vi.mock('../public-web-cli', () => ({ readHubApiKey: (...args: unknown[]) => readHubApiKey(...args) }));
vi.mock('../bridge-diagnostics-cli', () => ({
  runBridgeDoctorSection: (...args: unknown[]) => runBridgeDoctorSection(...args),
  isHubContainerRunning: (...args: unknown[]) => isHubContainerRunning(...args),
  resolveHubContainerName: (...args: unknown[]) => resolveHubContainerName(...args),
  probeHostPort: (...args: unknown[]) => probeHostPort(...args),
}));

const {
  checkBackendDns,
  checkCapabilityBudget,
  checkComposeDrift,
  checkDataDirOwnership,
  checkEnvFoundation,
  checkHubHealth,
  checkNonStreamingHeadroom,
  checkContextCaps,
  checkPeerIdentities,
  checkPoolCommandParity,
  checkPoolProtocol,
  checkRepoVersusImage,
  checkTailnet,
  checkTailscaleServe,
  checkUpstreamVisibility,
  composeShortFormTarget,
  countPoolFailures,
  countPoolIssues,
  formatPoolCheckLines,
  measureColdCapabilityBuild,
  modelParameterBillions,
  parseComposeService,
  readComposeDeclarations,
  parseHubContainerInspect,
  inspectHubDataDirs,
  parseTailscaleServeConfig,
  parseTailscaleStatus,
  pathWritableBy,
  POOL_ROUTE_COMMANDS,
  pickLargestLoadedModel,
  probeDnsFromContainer,
  probeDnsFromHost,
  readBackendVarsFromContainer,
  readTailscaleServeTarget,
  readUpstreamProbe,
  resolveBackendUrlSpecs,
  resolveDataDir,
  resolveNodeConfig,
  resolveNodeConfigForRun,
  runPoolDoctorSection,
  scrubGitError,
  summarisePoolChecks,
} = await import('../pool-diagnostics-cli');

const { stripAnsi } = await import('../lib/cli-ui');
const { POOL_SUBCOMMANDS } = await import('../lib/cli-pool');

/** An `HttpProbe`, shaped the way `timedFetch` returns one. */
function probe(overrides: Partial<{ ok: boolean; status: number | null; ms: number; body: string; error: string | null }> = {}) {
  return { ok: true, status: 200, ms: 12, body: '{}', error: null, ...overrides } as never;
}

function text(lines: string[]): string {
  return stripAnsi(lines.join('\n'));
}

const NO_TAILSCALE = { available: false, backendState: null, dnsName: null };
// Placeholder tailnet name only — docs/README.md tip-scrub policy.
const SELF = { available: true, backendState: 'Running', dnsName: 'hub-a.example-tailnet.ts.net' };

beforeEach(() => {
  spawnSync.mockReset();
  parseEnvFile.mockReset().mockReturnValue({});
  existsSync.mockReset().mockReturnValue(false);
  readFileSync.mockReset().mockReturnValue('');
  statSync.mockReset();
  dnsLookup.mockReset();
  readHubApiKey.mockReset().mockReturnValue(undefined);
  runBridgeDoctorSection
    .mockReset()
    .mockResolvedValue({ lines: ['Docker bridge  skipped'], issueCount: 0, failureCount: 0, remediationCommands: [] });
  isHubContainerRunning.mockReset().mockReturnValue(false);
  resolveHubContainerName.mockReset().mockReturnValue(undefined);
  probeHostPort.mockReset().mockResolvedValue(false);
});

// ─── A1 ──────────────────────────────────────────────────────────────────────

describe('A1 env foundation', () => {
  const foundation = (overrides: Record<string, unknown> = {}) => ({
    envFileName: '.env.prod',
    exists: true,
    apiPort: 5002,
    rootFolderHost: '/data/hub',
    containerUid: 1000,
    containerGid: 1000,
    ...overrides,
  });

  /** A `ResolvedNodeConfig`, as `resolveNodeConfig` hands one to A1. */
  const config = (overrides: Record<string, unknown> = {}) =>
    ({
      envFile: '.env.prod',
      exists: true,
      source: 'checkout',
      origin: "this CI-Hub checkout's .env.prod",
      notes: [],
      container: null,
      defaultRootFolderHost: '/default/root',
      ...overrides,
    }) as never;

  it('fails with appendable lines when the env file is absent entirely', () => {
    const check = checkEnvFoundation(foundation({ exists: false, apiPort: null, rootFolderHost: null }) as never, config());
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('does not exist');
    expect(check.commands).toEqual(["printf 'API_PORT=%s\\n' 5002 >> '.env.prod'", "printf 'ROOT_FOLDER_HOST=%s\\n' '/default/root' >> '.env.prod'"]);
  });

  it('fails on the stub env four fleet nodes shipped with, naming both missing keys', () => {
    const check = checkEnvFoundation(foundation({ apiPort: null, rootFolderHost: null }) as never, config());
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('API_PORT');
    expect(check.detail).toContain('ROOT_FOLDER_HOST');
    expect(check.commands).toHaveLength(2);
  });

  it('reports only the key that is actually missing', () => {
    const check = checkEnvFoundation(foundation({ rootFolderHost: null }) as never, config());
    expect(check.detail).toContain('ROOT_FOLDER_HOST');
    expect(check.detail).not.toContain('API_PORT,');
    expect(check.commands).toEqual(["printf 'ROOT_FOLDER_HOST=%s\\n' '/default/root' >> '.env.prod'"]);
  });

  it('passes and echoes both values back when the env file is complete', () => {
    const check = checkEnvFoundation(foundation() as never, config());
    expect(check.verdict).toBe('ok');
    expect(check.detail).toContain('API_PORT=5002');
    expect(check.detail).toContain('/data/hub');
  });

  /**
   * beta-max: a hybrid node whose Hub is healthy and serving pool protocol 2, whose appliance env
   * file has ROOT_FOLDER_HOST but no API_PORT — compose sets `API_PORT: 5002` in the service
   * `environment:` block — and which this check called unconfigured. A variable the running
   * container carries is a variable this node has.
   */
  it('passes on a value the env file lacks but the running container carries', () => {
    const check = checkEnvFoundation(
      foundation({ envFileName: '/data/companion-hub/.env', apiPort: null }) as never,
      config({ envFile: '/data/companion-hub/.env', source: 'container', container: { apiPort: 5002, rootFolderHost: '/data/companion-hub' } }),
    );
    expect(check.verdict).toBe('ok');
    expect(check.detail).toContain('API_PORT=5002');
    expect(text(check.notes ?? [])).toContain('API_PORT is not in that file');
  });

  it('names the file it read and where that came from, on the line itself', () => {
    const check = checkEnvFoundation(
      foundation({ envFileName: '/data/companion-hub/.env' }) as never,
      config({
        envFile: '/data/companion-hub/.env',
        source: 'container',
        origin: 'the running container ci-os-hub, which was created from /data/companion-hub/docker-compose.prod.yml — this file sits beside it',
      }),
    );
    expect(check.detail).toContain('/data/companion-hub/.env');
    expect(text(check.notes ?? [])).toContain('Read from the running container ci-os-hub');
    expect(text(check.notes ?? [])).toContain('/data/companion-hub/docker-compose.prod.yml');
  });

  it('appends its remediation to the resolved file, never to a repo path the Hub does not read', () => {
    const check = checkEnvFoundation(
      foundation({ envFileName: '/data/companion-hub/.env', apiPort: null, rootFolderHost: null }) as never,
      config({ envFile: '/data/companion-hub/.env', source: 'appliance', defaultRootFolderHost: '/data/companion-hub' }),
    );
    expect(check.verdict).toBe('fail');
    expect(check.commands).toEqual([
      "printf 'API_PORT=%s\\n' 5002 >> '/data/companion-hub/.env'",
      "printf 'ROOT_FOLDER_HOST=%s\\n' '/data/companion-hub' >> '/data/companion-hub/.env'",
    ]);
    expect(check.commands?.join(' ')).not.toContain('.env.prod');
  });

  /**
   * The Hub runs on configuration no file still carries: not "unconfigured" (it is serving) and not
   * "fine" (the next `cihub up` has no ROOT_FOLDER_HOST to interpolate and stops).
   */
  it('warns rather than failing when the file is gone but the container still has both values', () => {
    const check = checkEnvFoundation(
      foundation({ envFileName: '/data/companion-hub/.env', exists: false, apiPort: null, rootFolderHost: null }) as never,
      config({ source: 'container', container: { apiPort: 5002, rootFolderHost: '/data/companion-hub' } }),
    );
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('does not exist, but the running container has');
    expect(check.detail).toContain('API_PORT=5002');
    // The values it restores are the ones the Hub is running on, not the module's defaults.
    expect(check.commands).toContain("printf 'ROOT_FOLDER_HOST=%s\\n' '/data/companion-hub' >> '/data/companion-hub/.env'");
  });
});

// ─── the resolver every check reads its configuration through ────────────────

describe('resolveNodeConfig', () => {
  const probes = (overrides: Record<string, unknown> = {}) =>
    ({
      env: 'prod',
      container: null,
      hubContext: null,
      applianceInstall: null,
      checkoutEnvFile: '.env.prod',
      envRootFolderHost: null,
      exists: () => false,
      cwd: '/home/ci/devel/CI-Hub',
      ...overrides,
    }) as never;

  const containerProbe = (composeFiles: string[], config: Record<string, unknown> = { apiPort: 5002, rootFolderHost: '/data/companion-hub' }) => ({
    name: 'ci-os-hub',
    composeFiles,
    config,
  });

  /**
   * beta-max, the whole reason this resolver exists: a repo checkout AND an appliance install on one
   * box. `resolveHubContext` sees the checkout and resolves `.env.prod` in the repo — a file that
   * has never existed there — while the running Hub reads the appliance's `.env`.
   */
  it('reads the env file beside the compose the running container was created from', () => {
    const resolved = resolveNodeConfig(
      probes({
        container: containerProbe(['/data/companion-hub/docker-compose.prod.yml']),
        hubContext: { appliance: false, envFile: '.env.prod' },
        exists: (target: string) => target === '/data/companion-hub/.env',
      }),
    );
    expect(resolved.envFile).toBe('/data/companion-hub/.env');
    expect(resolved.source).toBe('container');
    expect(resolved.exists).toBe(true);
    expect(resolved.origin).toContain('ci-os-hub');
    expect(resolved.origin).toContain('/data/companion-hub/docker-compose.prod.yml');
  });

  /**
   * core-2 and core-10: source installs started with `--env-file .env.prod`. A bare `.env` beside
   * the same compose must not win, or the fix for the hybrid trades one false report for another.
   */
  it('prefers the env-specific name over a bare .env beside the same compose', () => {
    const resolved = resolveNodeConfig(
      probes({
        container: containerProbe(['/home/ci/devel/CI-Hub/docker-compose.prod.yml']),
        exists: () => true,
      }),
    );
    expect(resolved.envFile).toBe('/home/ci/devel/CI-Hub/.env.prod');
  });

  it('does not claim a file beside the compose that is not there, and says so', () => {
    const resolved = resolveNodeConfig(
      probes({
        container: containerProbe(['/data/companion-hub/docker-compose.prod.yml']),
        hubContext: { appliance: false, envFile: '.env.prod' },
        exists: (target: string) => target === '/home/ci/devel/CI-Hub/.env.prod',
      }),
    );
    expect(resolved.envFile).toBe('/home/ci/devel/CI-Hub/.env.prod');
    expect(resolved.source).toBe('checkout');
    expect(text(resolved.notes)).toContain('holds none of: .env.prod, .env');
  });

  it('falls back to the appliance context when no container answers, and says why', () => {
    const resolved = resolveNodeConfig(
      probes({
        hubContext: { appliance: true, envFile: '/data/companion-hub/.env.dev', dataDir: '/data/companion-hub' },
        exists: () => true,
      }),
    );
    expect(resolved.envFile).toBe('/data/companion-hub/.env.dev');
    expect(resolved.source).toBe('appliance');
    expect(text(resolved.notes)).toContain('No running Hub container answered');
  });

  it('falls back to the checkout last, as an absolute path', () => {
    const resolved = resolveNodeConfig(probes({ hubContext: { appliance: false, envFile: '.env.prod' }, exists: () => true }));
    expect(resolved.envFile).toBe('/home/ci/devel/CI-Hub/.env.prod');
    expect(resolved.source).toBe('checkout');
  });

  /**
   * `resolveProdApplianceContext` answers for the desktop, which seeds `.env.dev` as primary and
   * `.env` as an identical compat copy — the reverse of the doctor's `.env.<env>` then `.env`. An
   * install holding both must hand back the one the rest of the run reads, or A1 names a file
   * nothing else opens. This is the only case that exercises the wiring rather than the pure
   * resolver, so it goes through `resolveNodeConfigForRun`.
   */
  it('picks the appliance env file by the doctor order, not the desktop seeding order', () => {
    const cwd = process.cwd();
    const dataDir = '/data/companion-hub';
    const present = new Set([
      `${cwd}/package.json`,
      `${cwd}/scripts`,
      `${dataDir}/docker-compose.prod.yml`,
      `${dataDir}/.env.dev`,
      `${dataDir}/.env`,
    ]);
    existsSync.mockImplementation((target: string) => present.has(String(target)));
    readFileSync.mockImplementation((target: string) => (String(target).endsWith('package.json') ? '{"name":"ci-hub"}' : ''));
    vi.stubEnv('CI_HUB_DATA_DIR', dataDir);

    // A real checkout with no `.env.prod` of its own, so the run reaches the appliance rescue.
    const resolved = resolveNodeConfigForRun('prod', '.env.prod', null);

    expect(resolved.source).toBe('appliance');
    expect(resolved.envFile).toBe(`${dataDir}/.env`);
    vi.unstubAllEnvs();
  });

  /** The hybrid with its Hub stopped: the checkout never had an env file, the install does. */
  it('uses the appliance install when the checkout has no env file of its own', () => {
    const resolved = resolveNodeConfig(
      probes({
        hubContext: { appliance: false, envFile: '.env.prod' },
        applianceInstall: { exists: true, envFilePath: '/data/companion-hub/.env', dataDir: '/data/companion-hub' },
        exists: (target: string) => target !== '/home/ci/devel/CI-Hub/.env.prod',
      }),
    );
    expect(resolved.envFile).toBe('/data/companion-hub/.env');
    expect(resolved.source).toBe('appliance');
    expect(resolved.origin).toContain('because this checkout has no .env.prod');
  });

  it('keeps the checkout when its env file exists, even beside an appliance install', () => {
    const resolved = resolveNodeConfig(
      probes({
        hubContext: { appliance: false, envFile: '.env.prod' },
        applianceInstall: { exists: true, envFilePath: '/data/companion-hub/.env', dataDir: '/data/companion-hub' },
        exists: () => true,
      }),
    );
    expect(resolved.envFile).toBe('/home/ci/devel/CI-Hub/.env.prod');
    expect(resolved.source).toBe('checkout');
  });

  it('takes the data-dir default from the running container before any path-shaped guess', () => {
    const fromContainer = resolveNodeConfig(
      probes({
        container: containerProbe(['/data/companion-hub/docker-compose.prod.yml'], { apiPort: 5002, rootFolderHost: '/srv/hub-state' }),
        exists: (target: string) => target === '/data/companion-hub/.env',
      }),
    );
    expect(fromContainer.defaultRootFolderHost).toBe('/srv/hub-state');

    const fromCompose = resolveNodeConfig(
      probes({
        container: containerProbe(['/data/companion-hub/docker-compose.prod.yml'], { apiPort: null, rootFolderHost: null }),
        exists: (target: string) => target === '/data/companion-hub/.env',
      }),
    );
    expect(fromCompose.defaultRootFolderHost).toBe('/data/companion-hub');

    // The checkout's historical fallback, which `resolveRootFolderHost` also lands on.
    expect(resolveNodeConfig(probes()).defaultRootFolderHost).toBe('/home/ci/devel/CI-Hub/.internal');
  });

  it('degrades to the checkout when nothing at all answers, without throwing', () => {
    const resolved = resolveNodeConfig(probes({ container: { name: 'ci-hub', composeFiles: [], config: { apiPort: null, rootFolderHost: null } } }));
    expect(resolved.source).toBe('checkout');
    expect(resolved.exists).toBe(false);
    expect(text(resolved.notes)).toContain('carries no compose label');
  });
});

// ─── A2 ──────────────────────────────────────────────────────────────────────

describe('A2 hub health', () => {
  it('tells "nothing is listening" apart from "listening but unhealthy"', () => {
    const dead = checkHubHealth(probe({ ok: false, status: null, error: 'fetch failed' }), 'http://127.0.0.1:5002', false, 'prod');
    expect(dead.detail).toContain('nothing is listening');
    expect(dead.commands).toEqual(['cihub up prod']);

    const wrong = checkHubHealth(probe({ ok: false, status: 503 }), 'http://127.0.0.1:5002', true, 'prod');
    expect(wrong.detail).toContain('503');
    expect(wrong.commands).toEqual(['cihub logs prod']);
  });

  it('passes with the measured latency when the Hub answers', () => {
    expect(checkHubHealth(probe({ ms: 21 }), 'http://127.0.0.1:5002', true, 'prod')).toMatchObject({ verdict: 'ok' });
  });
});

// ─── A3 ──────────────────────────────────────────────────────────────────────

describe('A3 pool protocol', () => {
  it('reads a 404 as a build that predates Hub Pool', () => {
    const check = checkPoolProtocol(probe({ ok: false, status: 404 }), 'http://127.0.0.1:5002');
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('predates Hub Pool');
    expect(check.commands).toEqual(['cihub update']);
  });

  it('reads 200 with no poolProtocol field as protocol 1, not as success', () => {
    const check = checkPoolProtocol(probe({ body: JSON.stringify({ isCiHub: true }) }), 'http://127.0.0.1:5002');
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('pool protocol 1');
    expect(text(check.notes ?? [])).toContain('pairing by address');
  });

  it('reports the protocol number when the field is present', () => {
    const check = checkPoolProtocol(probe({ body: JSON.stringify({ isCiHub: true, poolProtocol: 2 }) }), 'http://127.0.0.1:5002');
    expect(check.verdict).toBe('ok');
    expect(check.detail).toBe('pool protocol 2');
  });

  it('does not claim a build has no Hub Pool when the Hub simply did not answer', () => {
    const check = checkPoolProtocol(probe({ ok: false, status: null, error: 'fetch failed' }), 'http://127.0.0.1:5002');
    expect(check.verdict).toBe('unknown');
  });
});

// ─── A4 ──────────────────────────────────────────────────────────────────────

describe('A4 data dir ownership', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    name: 'state',
    present: true,
    unreadable: false,
    uid: 1000,
    gid: 1000,
    mode: 0o755,
    ...overrides,
  });
  const unreadable = (name: string) => entry({ name, present: false, unreadable: true, uid: null, gid: null, mode: null });

  /**
   * A4 has to inspect the tree the Hub actually uses. On the hybrid node it reported a clean pass
   * over `<checkout>/.internal` — ten directories that had nothing to do with the running Hub —
   * because it derived ROOT_FOLDER_HOST from the checkout instead of from the resolved config.
   */
  describe('data dir source', () => {
    const foundation = (rootFolderHost: string | null) => ({ envFileName: '/data/companion-hub/.env', rootFolderHost }) as never;
    const config = (container: Record<string, unknown> | null, defaultRootFolderHost = '/fallback/root') =>
      ({ container, defaultRootFolderHost }) as never;

    it('prefers ROOT_FOLDER_HOST from the resolved env file', () => {
      const resolved = resolveDataDir(foundation('/data/companion-hub'), config({ apiPort: 5002, rootFolderHost: '/somewhere/else' }));
      expect(resolved.root).toBe('/data/companion-hub');
      expect(resolved.origin).toContain('/data/companion-hub/.env');
    });

    it('falls back to the running container before any guessed path', () => {
      const resolved = resolveDataDir(foundation(null), config({ apiPort: 5002, rootFolderHost: '/data/companion-hub' }));
      expect(resolved.root).toBe('/data/companion-hub');
      expect(resolved.origin).toContain('running Hub container');
    });

    it('says the path is a default when neither the file nor a container declares one', () => {
      const resolved = resolveDataDir(foundation(null), config(null));
      expect(resolved.root).toBe('/fallback/root');
      expect(resolved.origin).toContain('default');
    });
  });

  it('decides writability from owner, group and other bits', () => {
    expect(pathWritableBy(entry() as never, 1000, 1000)).toBe(true);
    // The real failure: Docker created it root:root 0755 and the container runs as 1000.
    expect(pathWritableBy(entry({ uid: 0, gid: 0 }) as never, 1000, 1000)).toBe(false);
    expect(pathWritableBy(entry({ uid: 0, gid: 1000, mode: 0o775 }) as never, 1000, 1000)).toBe(true);
    expect(pathWritableBy(entry({ uid: 0, gid: 0, mode: 0o777 }) as never, 1000, 1000)).toBe(true);
    expect(pathWritableBy(entry({ uid: 1000, mode: 0o555 }) as never, 1000, 1000)).toBe(false);
    expect(pathWritableBy(entry({ present: false, mode: null }) as never, 1000, 1000)).toBe(false);
    // A container running as root writes anywhere, so a root-owned tree is not a finding for it.
    expect(pathWritableBy(entry({ uid: 0, gid: 0 }) as never, 0, 0)).toBe(true);
  });

  it('fails on the root:root state dir that kills the Hub with EACCES', () => {
    const check = checkDataDirOwnership([entry({ uid: 0, gid: 0 }) as never], '/data/hub', 1000, 1000);
    expect(check.verdict).toBe('fail');
    expect(text(check.notes ?? [])).toContain('settings.json');
    expect(check.commands).toEqual(['sudo chown -R 1000:1000 /data/hub']);
  });

  it('warns rather than fails when dirs are merely absent, and says why that becomes the failure', () => {
    const check = checkDataDirOwnership([entry({ present: false, uid: null, gid: null, mode: null }) as never], '/data/hub', 1000, 1000);
    expect(check.verdict).toBe('warn');
    expect(text(check.notes ?? [])).toContain('root:root');
  });

  it('passes a tree the container user owns', () => {
    expect(checkDataDirOwnership([entry() as never], '/data/hub', 1000, 1000).verdict).toBe('ok');
  });

  /**
   * Reproduced with ROOT_FOLDER_HOST=/root (0700, not the operator's): `existsSync` is true so the
   * absent-root branch is skipped, then every `statSync` under it throws EACCES. Read as absence,
   * that printed `10 absent` and `sudo chown -R 1000:1000 /root` — a recursive chown of a tree whose
   * state was never observed. Those directories may exist and be perfectly correct.
   */
  it('tells a directory it was not allowed to read from one that is not there', () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    statSync.mockImplementation((target: string) => {
      if (target.endsWith('/state')) throw eacces;
      throw enoent;
    });

    const entries = inspectHubDataDirs('/root');
    const state = entries.find((dir) => dir.name === 'state');
    expect(state).toMatchObject({ present: false, unreadable: true });
    // Everything else really is absent, and absence is still a finding.
    expect(entries.filter((dir) => dir.unreadable)).toHaveLength(1);
    expect(entries.filter((dir) => !dir.present && !dir.unreadable).length).toBeGreaterThan(0);
  });

  it('reaches no verdict, and prints no chown, for a tree it could not stat at all', () => {
    const check = checkDataDirOwnership([unreadable('state'), unreadable('media')] as never, '/root', 1000, 1000);
    expect(check.verdict).toBe('unknown');
    // The whole point: "I could not look" must not be counted, and must not hand over a command.
    expect(countPoolIssues([check])).toBe(0);
    expect(check.commands).toBeUndefined();
    // Rendered, because a remediation reaches the operator as a `$ ...` line and as an entry in the
    // aggregated remediation list; neither may carry a chown for a tree this run never read.
    expect(text(formatPoolCheckLines([check]))).not.toContain('$ sudo chown');
    expect(check.detail).toContain('could be read');
    expect(check.detail).not.toContain('absent');
  });

  it('keeps a decided failure decided, but narrows the chown to what it actually observed', () => {
    const check = checkDataDirOwnership([entry({ uid: 0, gid: 0 }), unreadable('media')] as never, '/root', 1000, 1000);
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('1 unwritable');
    expect(check.detail).toContain('1 unreadable');
    // Scoped to the directory that was seen — never `chown -R` over the parent that was not.
    expect(check.commands).toEqual(['sudo chown -R 1000:1000 /root/state']);
    expect(check.commands).not.toContain('sudo chown -R 1000:1000 /root');
    expect(text(check.notes ?? [])).toContain('Could not be read at all');
  });
});

// ─── B1 ──────────────────────────────────────────────────────────────────────

/** `docker inspect` output in the exact shape the module's own --format string produces. */
function inspectOutput(overrides: { revision?: string; imageCreated?: string; service?: string; composeFiles?: string; extra?: string[] } = {}) {
  return [
    `revision=${overrides.revision ?? 'b59aa52f643c35f2a023bc5f21b1eb8ca7f0446d'}`,
    `imageCreated=${overrides.imageCreated ?? '2026-09-08T04:55:34.695Z'}`,
    `service=${overrides.service ?? 'ci-hub'}`,
    `composeFiles=${overrides.composeFiles ?? '/home/ci/devel/CI-Hub/docker-compose.prod.yml'}`,
    'mount=/data/state',
    'mount=/var/run/tailscale',
    'env=CI_HUB_VERSION=0.2.62',
    'env=POSTGRES_PASSWORD=hunter2-not-a-real-password',
    'env=OLLAMA_URL=http://host.docker.internal:11434',
    ...(overrides.extra ?? []),
    '',
  ].join('\n');
}

const IMAGE = {
  container: 'ci-hub',
  revision: 'b59aa52f643c35f2a023bc5f21b1eb8ca7f0446d',
  imageCreatedIso: '2026-09-08T04:55:34.695Z',
  version: '0.2.62',
  service: 'ci-hub',
  composeFiles: ['/home/ci/devel/CI-Hub/docker-compose.prod.yml'],
  mountTargets: ['/data/state', '/var/run/tailscale', '/usr/bin/tailscale'],
  envNames: ['CI_HUB_VERSION', 'OLLAMA_URL'],
};
/** beta-max's shape: a July checkout under a container built from dev tip. */
const JULY_REPO = { root: '/home/ci/devel/CI-Hub', head: '57ae8ce4450431632e979bd4b532be2f0a73a5a0', headIso: '2026-07-02T17:33:33-07:00' };
const NO_REPO = { root: null, head: null, headIso: null };

describe('B1 repo vs image', () => {
  it('reads the commit label, the mounts and the env NAMES — and no env value but the version', () => {
    const image = parseHubContainerInspect('ci-hub', inspectOutput());
    expect(image.revision).toBe('b59aa52f643c35f2a023bc5f21b1eb8ca7f0446d');
    expect(image.imageCreatedIso).toBe('2026-09-08T04:55:34.695Z');
    expect(image.composeFiles).toEqual(['/home/ci/devel/CI-Hub/docker-compose.prod.yml']);
    expect(image.mountTargets).toEqual(['/data/state', '/var/run/tailscale']);
    expect(image.envNames).toEqual(['CI_HUB_VERSION', 'POSTGRES_PASSWORD', 'OLLAMA_URL']);
    // CI_HUB_VERSION is the only VALUE carried out of a block that also holds every secret the Hub has.
    expect(image.version).toBe('0.2.62');
    expect(JSON.stringify(image)).not.toContain('hunter2-not-a-real-password');
  });

  /**
   * A1 and A4 read these two off the container, so the parse has to carry them — and carry nothing
   * else. The env block beside them is where every password, token and key the Hub has lives.
   */
  it('carries API_PORT and ROOT_FOLDER_HOST out of the container env, and still no secret', () => {
    const image = parseHubContainerInspect('ci-os-hub', inspectOutput({ extra: ['env=API_PORT=5002', 'env=ROOT_FOLDER_HOST=/data/companion-hub'] }));
    expect(image.config).toEqual({ apiPort: 5002, rootFolderHost: '/data/companion-hub' });
    expect(JSON.stringify(image)).not.toContain('hunter2-not-a-real-password');
  });

  it('reports an absent or unusable API_PORT as unknown rather than as a port', () => {
    expect(parseHubContainerInspect('ci-hub', inspectOutput()).config).toEqual({ apiPort: null, rootFolderHost: null });
    expect(parseHubContainerInspect('ci-hub', inspectOutput({ extra: ['env=API_PORT=not-a-port'] })).config.apiPort).toBeNull();
  });

  it('never turns a missing label into a commit sha', () => {
    // Docker renders an absent label as `<no value>` on some daemons and as empty on others.
    expect(parseHubContainerInspect('ci-hub', inspectOutput({ revision: '<no value>' })).revision).toBeNull();
    expect(parseHubContainerInspect('ci-hub', inspectOutput({ revision: '' })).revision).toBeNull();
  });

  it('cannot determine anything with no container or no checkout, and neither is an issue', () => {
    const noContainer = checkRepoVersusImage(JULY_REPO as never, null, null);
    expect(noContainer.verdict).toBe('unknown');
    expect(noContainer.detail).toContain('cannot determine, because no running Hub container');

    const noRepo = checkRepoVersusImage(NO_REPO as never, IMAGE as never, null);
    expect(noRepo.verdict).toBe('unknown');
    expect(noRepo.detail).toContain('not running from a git checkout');
    expect(countPoolIssues([noContainer, noRepo])).toBe(0);
  });

  /**
   * The precision rule for the whole section. Two dates prove exactly one thing — an image built
   * BEFORE a commit cannot contain it — and nothing in the other direction. Reporting the other
   * direction as a version comparison is the failure mode this pair of tests pins down.
   */
  it('claims only what two dates can prove when the image carries no commit label', () => {
    const unlabelled = { ...IMAGE, revision: null };
    const stale = checkRepoVersusImage(JULY_REPO as never, { ...unlabelled, imageCreatedIso: '2026-06-01T00:00:00Z' } as never, null);
    expect(stale.verdict).toBe('warn');
    expect(stale.detail).toContain('the repo has commits the image cannot contain');

    // Image built AFTER HEAD: consistent with a match AND with a stale checkout, so neither is claimed.
    const undecidable = checkRepoVersusImage(JULY_REPO as never, unlabelled as never, null);
    expect(undecidable.verdict).toBe('unknown');
    expect(undecidable.detail).toContain('cannot correlate');
    expect(undecidable.detail).not.toContain('behind');
    expect(countPoolIssues([undecidable])).toBe(0);
  });

  it('passes when the image was built from HEAD', () => {
    const repo = { ...JULY_REPO, head: IMAGE.revision };
    const check = checkRepoVersusImage(repo as never, IMAGE as never, { relation: 'same', count: 0 } as never);
    expect(check.verdict).toBe('ok');
    expect(check.detail).toContain('built from this checkout');
  });

  it('fails a checkout behind its own container, and names the operator-visible symptom', () => {
    const check = checkRepoVersusImage(JULY_REPO as never, IMAGE as never, { relation: 'repo-behind', count: 825 } as never);
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('825 commit(s) behind b59aa52');
    expect(text(check.notes ?? [])).toContain('Unknown command: pool');
    expect(check.commands).toEqual(['git -C /home/ci/devel/CI-Hub pull --ff-only && pnpm install']);
  });

  it('warns the other way round, where the fix is an image and not a pull', () => {
    const check = checkRepoVersusImage(JULY_REPO as never, IMAGE as never, { relation: 'repo-ahead', count: 12 } as never);
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('12 commit(s) behind this checkout');
    expect(check.commands).toEqual(['cihub update']);
  });

  /**
   * An image commit that is not in this object store is measured on the healthy control node
   * (core-2: HEAD 6e47b2c, image b59aa52, `cat-file -e` fails). Two readings fit it — the image is
   * ahead of a node that has not fetched, or the node is genuinely stale — and the checkout cannot
   * tell them apart, so this must not be the section's top severity. `fail` stays reserved for a
   * checkout provably behind its own container, the state that produces `Unknown command: pool`.
   */
  it('warns, and claims no direction, for an image commit the checkout has never seen', () => {
    const check = checkRepoVersusImage(JULY_REPO as never, IMAGE as never, { relation: 'absent', count: null } as never);
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('a commit this checkout does not have');
    expect(check.detail).not.toMatch(/\d+ commit\(s\) behind/);
    const notes = text(check.notes ?? []);
    expect(notes).toContain('see B2');
    // Neither direction may be asserted: the distance is unmeasurable, so naming a stale half is a guess.
    expect(notes).toContain('WHICH is ahead cannot be said');
    expect(text([check.detail, ...(check.notes ?? [])])).not.toContain('behind this checkout');
    expect(check.commands).toEqual(['git -C /home/ci/devel/CI-Hub fetch origin']);
    // ...and it is still a finding, not a shrug.
    expect(countPoolIssues([check])).toBe(1);
  });

  it('keeps fail for the one skew it can prove, so absent and repo-behind stay distinguishable', () => {
    const absent = checkRepoVersusImage(JULY_REPO as never, IMAGE as never, { relation: 'absent', count: null } as never);
    const behind = checkRepoVersusImage(JULY_REPO as never, IMAGE as never, { relation: 'repo-behind', count: 825 } as never);
    expect([absent.verdict, behind.verdict]).toEqual(['warn', 'fail']);
  });

  it('carries both identities into the notes, so a verdict shows what decided it', () => {
    const check = checkRepoVersusImage(JULY_REPO as never, IMAGE as never, { relation: 'repo-behind', count: 825 } as never);
    const notes = text(check.notes ?? []);
    expect(notes).toContain('HEAD 57ae8ce (2026-07-02)');
    expect(notes).toContain('image b59aa52 built 2026-09-08');
    expect(notes).toContain('CI_HUB_VERSION 0.2.62');
  });
});

// ─── B2 ──────────────────────────────────────────────────────────────────────

describe('B2 upstream visibility', () => {
  /** Answer git by subcommand, so what the probe actually runs is what it is judged on. */
  function git(handler: (args: string[]) => { status?: number; stdout?: string; stderr?: string }) {
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command !== 'git') return { status: 1, stdout: '', stderr: '' };
      const answer = handler(args);
      return { status: answer.status ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    });
  }

  it('asks the remote with ls-remote and never runs a command that would move a ref', () => {
    git((args) => (args.includes('ls-remote') ? { stdout: 'fdb75c5c26a13ccb20e040ed747b58c736a3b865\trefs/heads/dev' } : { stdout: '3' }));
    const probe = readUpstreamProbe('/repo');
    expect(probe.remoteHead).toBe('fdb75c5c26a13ccb20e040ed747b58c736a3b865');

    const invocations = spawnSync.mock.calls.map(([, args]) => (args as string[]).join(' '));
    expect(invocations.some((line) => line.includes('ls-remote'))).toBe(true);
    // A fetch would move origin/<branch> and repair the exact condition this check exists to find —
    // on a command the operator ran only to LOOK at the node.
    expect(invocations.some((line) => /\bfetch\b|\bpull\b|\bcheckout\b|\bremote update\b/.test(line))).toBe(false);
  });

  it('reports behind as UNKNOWN, never as the frozen cached number, when the remote cannot be read', () => {
    const check = checkUpstreamVisibility(
      { root: '/repo', head: 'abc', headIso: null } as never,
      {
        ref: 'origin/dev',
        remote: 'origin',
        branch: 'dev',
        reachable: false,
        error: 'fatal: Authentication failed',
        remoteHead: null,
        behind: null,
        // The measured beta-nas state: auth failed, the cached ref answered 0, HEAD was two months old.
        cachedBehind: 0,
      } as never,
    );
    expect(check.verdict).toBe('unknown');
    expect(check.detail).toContain('behind is UNKNOWN, not 0');
    expect(check.detail).toContain('Authentication failed');
    // The bug being prevented: printing the frozen 0 as though it were a measurement.
    expect(check.detail).not.toMatch(/\b0 commit/);
    expect(text(check.notes ?? [])).toContain('FROZEN');
    expect(countPoolIssues([check])).toBe(0);
  });

  it('names the frozen ref explicitly when the remote proves the cached 0 was a lie', () => {
    const check = checkUpstreamVisibility(
      { root: '/repo', head: 'abc', headIso: null } as never,
      {
        ref: 'origin/dev',
        remote: 'origin',
        branch: 'dev',
        reachable: true,
        error: null,
        remoteHead: 'fdb75c5c26a13ccb20e040ed747b58c736a3b865',
        behind: 825,
        cachedBehind: 0,
      } as never,
    );
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('825 commit(s) behind origin/dev');
    // Not just "the cached ref said 0" — the note has to call out that a node reading only that ref
    // would have called itself current, which is the whole finding.
    expect(text(check.notes ?? [])).toContain('would have reported itself current');
    expect(check.commands).toEqual(['git -C /repo pull --ff-only']);
  });

  it('will not count a distance to a commit it does not have, and says so', () => {
    const check = checkUpstreamVisibility(
      { root: '/repo', head: 'abc', headIso: null } as never,
      {
        ref: 'origin/dev',
        remote: 'origin',
        branch: 'dev',
        reachable: true,
        error: null,
        remoteHead: 'fdb75c5c26a13ccb20e040ed747b58c736a3b865',
        behind: null,
        cachedBehind: 3,
      } as never,
    );
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('never fetched');
    expect(check.detail).toContain('behind by an unknown number');
    expect(check.commands).toEqual(['git -C /repo fetch origin dev']);
  });

  it('passes only when the remote head is this checkout', () => {
    const at = (remoteHead: string, behind: number | null) =>
      checkUpstreamVisibility(
        { root: '/repo', head: 'abc1234def', headIso: null } as never,
        {
          ref: 'origin/dev',
          remote: 'origin',
          branch: 'dev',
          reachable: true,
          error: null,
          remoteHead,
          behind,
          cachedBehind: 0,
        } as never,
      );
    expect(at('abc1234def', 0).verdict).toBe('ok');
    expect(at('abc1234def', 0).detail).toContain('up to date');
    // Ahead of the remote is not behind it, and must not be reported as a staleness finding.
    expect(at('999999999', 0).verdict).toBe('ok');
    expect(at('999999999', 0).detail).toContain('ahead of origin/dev');
    expect(at('999999999', 4).verdict).toBe('warn');
  });

  /**
   * `HEAD..<remote>` counts one side of the symmetric difference, so a checkout carrying local
   * commits reads as plainly "behind" and gets `pull --ff-only` — which git refuses outright ("Not
   * possible to fast-forward"). Reproduced by running the doctor in this very worktree, 7 behind
   * origin/dev and 1 ahead of it. `--left-right` answers both halves in the same call.
   */
  it('counts both sides of the difference, so ahead is never invisible', () => {
    git((args) => {
      if (args.includes('ls-remote')) return { stdout: 'fdb75c5c26a13ccb20e040ed747b58c736a3b865\trefs/heads/dev' };
      if (args.includes('--left-right')) return { stdout: '1\t7\n' };
      return { stdout: '7' };
    });
    const probe = readUpstreamProbe('/repo');
    expect([probe.ahead, probe.behind]).toEqual([1, 7]);

    const asked = spawnSync.mock.calls.map(([, args]) => (args as string[]).join(' '));
    // Both numbers off one range: two separate counts can disagree with each other after a
    // concurrent fetch, and this pair is compared as a pair.
    expect(asked.some((line) => line.includes('--left-right') && line.includes('HEAD...fdb75c5c'))).toBe(true);
  });

  it('calls a diverged checkout diverged, and does not prescribe a pull that cannot apply', () => {
    const check = checkUpstreamVisibility(
      { root: '/repo', head: 'abc', headIso: null } as never,
      {
        ref: 'origin/dev',
        remote: 'origin',
        branch: 'dev',
        reachable: true,
        error: null,
        remoteHead: 'fdb75c5c26a13ccb20e040ed747b58c736a3b865',
        behind: 7,
        ahead: 1,
        cachedBehind: 7,
      } as never,
    );
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('diverged from origin/dev');
    // Both halves named. "7 behind" alone is what makes --ff-only sound like it will work.
    expect(check.detail).toContain('7 commit(s) behind');
    expect(check.detail).toContain('1 ahead');
    expect(check.commands?.join(' ')).not.toContain('--ff-only');
    expect(check.commands).toEqual(['git -C /repo log --oneline fdb75c5..HEAD']);
  });

  it('still prescribes the fast-forward when the checkout really can take one', () => {
    const check = checkUpstreamVisibility(
      { root: '/repo', head: 'abc', headIso: null } as never,
      {
        ref: 'origin/dev',
        remote: 'origin',
        branch: 'dev',
        reachable: true,
        error: null,
        remoteHead: 'fdb75c5c26a13ccb20e040ed747b58c736a3b865',
        behind: 7,
        ahead: 0,
        cachedBehind: 0,
      } as never,
    );
    expect(check.detail).toContain('7 commit(s) behind origin/dev');
    expect(check.detail).not.toContain('diverged');
    expect(check.commands).toEqual(['git -C /repo pull --ff-only']);
  });

  it('scrubs a credential out of anything git echoed back', () => {
    expect(scrubGitError('fatal: could not read https://ci:ghp_secrettoken@github.com/x/y.git\nsecond line')).toBe(
      'fatal: could not read https://***@github.com/x/y.git',
    );
    expect(scrubGitError('remote: Invalid username or password')).toContain('Invalid username');
  });
});

// ─── B3 ──────────────────────────────────────────────────────────────────────

/** Trimmed to the two blocks the parser reads, in the shapes both real compose files use. */
const COMPOSE = `services:
  ci-hub-db:
    image: postgres:14
    volumes:
      - ci_hub_pgdata:/var/lib/postgresql/data
  ci-os-hub:
    container_name: ci-os-hub
    volumes:
      # A comment, and an interpolation whose default holds a colon of its own.
      - \${ROOT_FOLDER_HOST:-.internal}/state:/data/state
      - \${DOCKER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock:ro
      - type: bind
        source: \${ENV_FILE:-.env}
        target: /data/.env
        bind:
          create_host_path: false
      - \${TAILSCALE_SOCKET_DIR:-/var/run/tailscale}:/var/run/tailscale
      - \${TAILSCALE_BINARY:-/usr/bin/tailscale}:/usr/bin/tailscale:ro
    dns_opt:
      - attempts:5
    environment:
      OLLAMA_URL: http://host.docker.internal:11434
      MTPLX_URL: \${MTPLX_URL:-http://host.docker.internal:8000}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-postgres}
volumes:
  ci_hub_pgdata:
`;

describe('B3 compose drift', () => {
  it('takes the container-side path off a short-form volume, colons in the default and all', () => {
    expect(composeShortFormTarget('${ROOT_FOLDER_HOST:-.internal}/state:/data/state')).toBe('/data/state');
    // The whole reason interpolations are masked first: splitting naively lands inside `:-/var/run/...`.
    expect(composeShortFormTarget('${DOCKER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock:ro')).toBe('/var/run/docker.sock');
    expect(composeShortFormTarget('/proc/meminfo:/host/proc/meminfo:ro')).toBe('/host/proc/meminfo');
    // An anonymous volume and an interpolated target are undecidable, and a guess here reports a
    // mount that is plainly present as missing.
    expect(composeShortFormTarget('/data/scratch')).toBeNull();
    expect(composeShortFormTarget('./src:${TARGET_DIR}/src')).toBeNull();
  });

  it('reads the named service, both volume syntaxes, and env NAMES only', () => {
    const spec = parseComposeService(COMPOSE, ['ci-os-hub']);
    expect(spec?.service).toBe('ci-os-hub');
    expect(spec?.mountTargets).toEqual(['/data/state', '/var/run/docker.sock', '/data/.env', '/var/run/tailscale', '/usr/bin/tailscale']);
    expect(spec?.envNames).toEqual(['OLLAMA_URL', 'MTPLX_URL', 'POSTGRES_PASSWORD']);
    // Values are never read out of `environment:` — that block is where compose keeps the passwords.
    expect(JSON.stringify(spec)).not.toContain('postgres}');
    // `dns_opt:` sits between the two blocks and its `- attempts:5` must not be read as a mount.
    expect(spec?.mountTargets).not.toContain('5');
  });

  it('resolves the older ci-os-hub topology as readily as the canonical one, and neither by accident', () => {
    expect(parseComposeService(COMPOSE, ['ci-hub', 'ci-os-hub'])?.service).toBe('ci-os-hub');
    expect(parseComposeService(COMPOSE, ['ci-hub'])).toBeNull();
    // The db service's volumes must not leak into the Hub's block.
    expect(parseComposeService(COMPOSE, ['ci-hub-db'])?.mountTargets).toEqual(['/var/lib/postgresql/data']);
  });

  const declared = { path: '/home/ci/.local/share/companion-hub/docker-compose.prod.yml', spec: parseComposeService(COMPOSE, ['ci-os-hub']) };

  it('fails a container missing the host Tailscale mounts its own compose declares', () => {
    // The measured beta-max failure: a dev-tip image under an appliance compose written months
    // earlier, so /identify answered nodeFqdn:null and pairing could never complete.
    const image = { ...IMAGE, mountTargets: ['/data/state', '/var/run/docker.sock', '/data/.env'], envNames: ['OLLAMA_URL', 'MTPLX_URL'] };
    const check = checkComposeDrift({ image, created: declared, createdReason: null, repo: null } as never, 'prod');
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('missing 2 mount(s)');
    const notes = text(check.notes ?? []);
    expect(notes).toContain('/var/run/tailscale, /usr/bin/tailscale');
    expect(notes).toContain('nodeFqdn:null');
    expect(check.commands).toEqual(['cihub up prod']);
  });

  it('names a backend URL var the compose declares and the container does not have', () => {
    const image = { ...IMAGE, mountTargets: declared.spec?.mountTargets ?? [], envNames: ['OLLAMA_URL'] };
    const check = checkComposeDrift({ image, created: declared, createdReason: null, repo: null } as never, 'prod');
    expect(check.verdict).toBe('fail');
    expect(text(check.notes ?? [])).toContain('Variables declared but not set: MTPLX_URL');
    // POSTGRES_PASSWORD is declared too and is deliberately not compared — no secret name is fished for.
    expect(text(check.notes ?? [])).not.toContain('POSTGRES_PASSWORD');
  });

  it('warns when the compose the container was created from lags this checkout', () => {
    const image = { ...IMAGE, mountTargets: ['/data/state'], envNames: ['OLLAMA_URL', 'MTPLX_URL'] };
    const applianceSpec = { service: 'ci-os-hub', mountTargets: ['/data/state'], envNames: ['OLLAMA_URL'] };
    const check = checkComposeDrift(
      {
        image,
        created: { path: '/home/ci/.local/share/companion-hub/docker-compose.prod.yml', spec: applianceSpec },
        createdReason: null,
        repo: { path: '/home/ci/devel/CI-Hub/docker-compose.prod.yml', spec: declared.spec },
      } as never,
      'prod',
    );
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('missing 4 mount(s) this checkout declares');
    expect(text(check.notes ?? [])).toContain('/var/run/tailscale');
    expect(check.commands).toEqual(['cihub update']);
  });

  it('cannot determine anything without a container or a readable compose, and inflates nothing', () => {
    const noContainer = checkComposeDrift({ image: null, created: null, createdReason: null, repo: null } as never, 'prod');
    const noCompose = checkComposeDrift({ image: IMAGE, created: null, createdReason: 'the file is not on this host', repo: null } as never, 'prod');
    expect(noContainer.verdict).toBe('unknown');
    expect(noCompose.verdict).toBe('unknown');
    expect(noCompose.detail).toContain('cannot determine, because the file is not on this host');
    expect(countPoolIssues([noContainer, noCompose])).toBe(0);
  });

  it('passes a container that matches its compose', () => {
    const image = { ...IMAGE, mountTargets: declared.spec?.mountTargets ?? [], envNames: ['OLLAMA_URL', 'MTPLX_URL'] };
    const check = checkComposeDrift({ image, created: declared, createdReason: null, repo: declared } as never, 'prod');
    expect(check.verdict).toBe('ok');
    expect(check.detail).toContain('5 mount(s) and 2 backend URL var(s)');
  });
});

// ─── B4 ──────────────────────────────────────────────────────────────────────

describe('B4 CLI vs Hub routes', () => {
  const route = (name: string, subcommand: string, servedByHub: boolean | null) => ({ route: name, subcommand, servedByHub });

  /**
   * This branch only fires for a caller that declares a partial subcommand list. It cannot fire
   * under `cihub pool doctor`, which passes POOL_SUBCOMMANDS from the same build as
   * POOL_ROUTE_COMMANDS — so it must not claim the CLI is older than its Hub. A CLI that old cannot
   * run this check at all; B1 is where that skew is measured.
   */
  it('reports a route the declared command list misses without claiming a version skew', () => {
    const check = checkPoolCommandParity(
      [route('status', 'status', true), route('peers/discoverable', 'discover', true)] as never,
      ['status'],
      '/home/ci/devel/CI-Hub',
    );
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('1 pool route(s) the declared CLI command list does not cover');
    const notes = text(check.notes ?? []);
    expect(notes).toContain('/api/inference/pool/peers/discoverable');
    expect(notes).toContain('cihub pool discover');
    expect(notes).toContain('Not a version skew');
    expect(notes).toContain('B1');
    expect(notes).not.toContain('This CLI is older than the Hub');
    expect(check.commands).toEqual(['git -C /home/ci/devel/CI-Hub pull --ff-only && pnpm install']);
  });

  /**
   * And the reason that branch is unreachable in the real command, asserted where it belongs: every
   * route this module probes has a `cihub pool` subcommand in the same build. Mutation-checked by
   * adding a route with no subcommand — this fails, the doctor's own output does not change.
   */
  it('ships a pool subcommand for every route it probes, in this build', () => {
    for (const entry of POOL_ROUTE_COMMANDS) {
      expect(POOL_SUBCOMMANDS).toContain(entry.subcommand);
    }
  });

  it('tells an appliance with no checkout to update the image instead of pulling', () => {
    const check = checkPoolCommandParity([route('routing-log', 'log', true)] as never, ['status'], null);
    expect(check.commands).toEqual(['cihub update']);
  });

  it('warns the other direction, where the Hub is the stale half', () => {
    const check = checkPoolCommandParity([route('status', 'status', true), route('routing-log', 'log', false)] as never, ['status', 'log'], null);
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('1 pool route(s) the Hub does not serve');
    expect(text(check.notes ?? [])).toContain('answers 404');
    expect(check.commands).toEqual(['cihub update']);
  });

  it('says nothing about a Hub that did not answer, and nothing about a build with no pool at all', () => {
    const silent = checkPoolCommandParity([route('status', 'status', null)] as never, ['status'], null);
    expect(silent.verdict).toBe('unknown');
    expect(silent.detail).toContain('the Hub is not reachable locally (see A2)');

    // Every route 404s: that is A3's finding — a build predating Hub Pool — not a CLI skew.
    const noPool = checkPoolCommandParity([route('status', 'status', false), route('peers', 'peers', false)] as never, ['status', 'peers'], null);
    expect(noPool.verdict).toBe('unknown');
    expect(noPool.detail).toContain('see A3');
    expect(countPoolIssues([silent, noPool])).toBe(0);
  });

  it('cannot compare when the caller declared no subcommand list', () => {
    const check = checkPoolCommandParity([route('status', 'status', true)] as never, null, null);
    expect(check.verdict).toBe('unknown');
    expect(countPoolIssues([check])).toBe(0);
  });

  it('passes only when every probed route matched, and holds back on a partial answer', () => {
    expect(checkPoolCommandParity([route('status', 'status', true), route('peers', 'peers', true)] as never, ['status', 'peers'], null).verdict).toBe(
      'ok',
    );
    const partial = checkPoolCommandParity([route('status', 'status', true), route('peers', 'peers', null)] as never, ['status', 'peers'], null);
    expect(partial.verdict).toBe('unknown');
    expect(partial.detail).toContain('1 did not answer');
  });
});

// ─── C ───────────────────────────────────────────────────────────────────────

/** A serve config that was read successfully and publishes nothing, unless told otherwise. */
function serveState(overrides: Partial<{ readable: boolean; configured: boolean; publishesHub: boolean; mounts: string[] }> = {}) {
  return { readable: true, configured: false, publishesHub: false, mounts: [], ...overrides } as never;
}
/** core-2's real config: one handler at / on the :443 listener, proxying to the Hub. */
const PUBLISHING = serveState({ configured: true, publishesHub: true, mounts: ['hub-a.example-tailnet.ts.net:443/ -> http://localhost:5002'] });

describe('C tailnet reachability', () => {
  it('strips the trailing dot off the MagicDNS name', () => {
    const parsed = parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'hub-a.example-tailnet.ts.net.' } }));
    expect(parsed).toEqual({ available: true, backendState: 'Running', dnsName: 'hub-a.example-tailnet.ts.net' });
  });

  it('cannot determine the tailnet with no CLI, and does not call that a failure', () => {
    const check = checkTailnet(NO_TAILSCALE as never);
    expect(check.verdict).toBe('unknown');
    expect(countPoolIssues([check])).toBe(0);
  });

  it('fails a disconnected tailnet and an unnamed node separately', () => {
    expect(checkTailnet({ available: true, backendState: 'Stopped', dnsName: null } as never)).toMatchObject({
      verdict: 'fail',
      commands: ['sudo tailscale up'],
    });
    const unnamed = checkTailnet({ available: true, backendState: 'Running', dnsName: null } as never);
    expect(unnamed.verdict).toBe('fail');
    expect(text(unnamed.notes ?? [])).toContain('no fallback');
  });

  /**
   * The shapes below are real `tailscale serve status --json` output. The check used to regex the
   * TEXT output for `localhost:<port>` anywhere in it, and all three of the negative cases here
   * matched it — each rendering as `serve publishes http://localhost:5002 on https://<name>/` while
   * every peer callback to `https://<name>/api/inference/pool/identify` failed.
   */
  describe('C2 serve config', () => {
    // core-2, read live: the one shape a peer callback can actually take.
    const CORE_2 = JSON.stringify({
      TCP: { '443': { HTTPS: true } },
      Web: { 'hub-a.example-tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://localhost:5002' } } } },
    });

    it('accepts a root mount on the 443 listener, which is what a peer callback needs', () => {
      const serve = parseTailscaleServeConfig(CORE_2, 5002);
      expect(serve).toMatchObject({ readable: true, configured: true, publishesHub: true });
      expect(serve.mounts).toEqual(['hub-a.example-tailnet.ts.net:443/ -> http://localhost:5002']);
      // 127.0.0.1 and [::1] are the same target by another name.
      expect(parseTailscaleServeConfig(CORE_2.replace('localhost', '127.0.0.1'), 5002).publishesHub).toBe(true);
    });

    it('refuses a path mount: /api/inference/pool/identify is not under /hub', () => {
      const serve = parseTailscaleServeConfig(
        JSON.stringify({ Web: { 'hub-a.example-tailnet.ts.net:443': { Handlers: { '/hub': { Proxy: 'http://localhost:5002' } } } } }),
        5002,
      );
      expect(serve.publishesHub).toBe(false);
      expect(serve.configured).toBe(true);
      // And says what it does publish, or the operator cannot tell what to change.
      expect(serve.mounts).toEqual(['hub-a.example-tailnet.ts.net:443/hub -> http://localhost:5002']);
    });

    it('refuses a listener on any port but 443, because peers dial 443 and nothing else', () => {
      const serve = parseTailscaleServeConfig(
        JSON.stringify({ Web: { 'hub-a.example-tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://localhost:5002' } } } } }),
        5002,
      );
      expect(serve.publishesHub).toBe(false);
    });

    it('refuses a raw TCP forward and accepts a TLS-terminated one', () => {
      const raw = parseTailscaleServeConfig(JSON.stringify({ TCP: { '443': { TCPForward: 'localhost:5002' } } }), 5002);
      // Nothing on the node speaks TLS at the far end, so the HTTPS handshake never completes.
      expect(raw.publishesHub).toBe(false);
      expect(raw.configured).toBe(true);
      expect(raw.mounts[0]).toContain('raw TCP');

      const terminated = parseTailscaleServeConfig(
        JSON.stringify({ TCP: { '443': { TCPForward: '127.0.0.1:5002', TerminateTLS: 'hub-a.example-tailnet.ts.net' } } }),
        5002,
      );
      expect(terminated.publishesHub).toBe(true);
    });

    it('refuses a root mount that proxies to some other port', () => {
      expect(parseTailscaleServeConfig(CORE_2, 5010).publishesHub).toBe(false);
    });

    it('reads core-10 — an empty config — as configured:false, and garbage as unreadable', () => {
      // core-10, read live: `tailscale serve status --json` answers `{}` with exit 0.
      expect(parseTailscaleServeConfig('{}', 5002)).toEqual({ readable: true, configured: false, publishesHub: false, mounts: [] });
      // Anything else is "could not look", which must never be reported as "not configured".
      expect(parseTailscaleServeConfig('Access denied.', 5002).readable).toBe(false);
      expect(parseTailscaleServeConfig('', 5002).readable).toBe(false);
    });

    it('asks tailscale for the machine-readable config, not the drawing meant for humans', () => {
      spawnSync.mockReturnValue({ status: 0, stdout: CORE_2 });
      expect(readTailscaleServeTarget(5002).publishesHub).toBe(true);
      const [command, args] = spawnSync.mock.calls[0] as [string, string[]];
      expect([command, ...args]).toEqual(['tailscale', 'serve', 'status', '--json']);
    });

    it('does not claim a node is unserved when the tailscale CLI itself failed', () => {
      spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'permission denied' });
      const serve = readTailscaleServeTarget(5002);
      expect(serve.readable).toBe(false);
      const check = checkTailscaleServe(probe({ ok: false, status: null, error: 'fetch failed' }), SELF as never, 5002, true, serve);
      expect(check.verdict).toBe('unknown');
      expect(countPoolIssues([check])).toBe(0);
      expect(check.commands).toBeUndefined();
    });
  });

  it('prints the operator-grant + serve remediation verbatim, bound to the real API port', () => {
    const check = checkTailscaleServe(probe({ ok: false, status: null, error: 'fetch failed' }), SELF as never, 5010, true, serveState());
    expect(check.verdict).toBe('fail');
    expect(check.commands).toEqual(['sudo tailscale set --operator=$USER && tailscale serve --bg --yes --https=443 http://localhost:5010']);
    expect(check.detail).toContain('no `tailscale serve` config');
  });

  /**
   * The self-probe cannot succeed even on a healthy node: `tailscale serve` listens for tailnet
   * peers, and a request to our own MagicDNS name does not loop back through it. Measured — the same
   * URL answered 200 from a peer and failed outright from the node itself. Before this, C2 reported
   * a working node as totally unreachable and printed a fix the operator had already applied.
   */
  it('does not fail a healthy node just because it cannot reach its own serve listener', () => {
    const check = checkTailscaleServe(probe({ ok: false, status: null, error: 'fetch failed' }), SELF as never, 5002, true, PUBLISHING);
    expect(check.verdict).toBe('ok');
    expect(check.detail).toContain('serve publishes');
    expect(check.commands).toBeUndefined();
  });

  it('still fails when serve is configured but publishes something other than the Hub at /', () => {
    const check = checkTailscaleServe(
      probe({ ok: false, status: null, error: 'fetch failed' }),
      SELF as never,
      5002,
      true,
      serveState({ configured: true, mounts: ['hub-a.example-tailnet.ts.net:443/hub -> http://localhost:5002'] }),
    );
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('nothing publishes http://localhost:5002 at / on :443');
    // The operator has to be told what it publishes instead, or the fix is a guess.
    expect(text(check.notes ?? [])).toContain(':443/hub -> http://localhost:5002');
  });

  /**
   * The skip path runs on a node whose Hub is down. It already holds the serve config — and used to
   * ignore it and attach the config-WRITING remediation unconditionally, so a node whose serve is
   * correct and whose Hub merely stopped was handed `tailscale serve --bg --yes ...` for something
   * that is not broken, and it landed in the aggregated remediation list as a to-do.
   */
  it('does not hand over a serve-rewriting command for a serve config that is already correct', () => {
    const skip = 'not probed — the Hub is not answering locally (see A2), so serve has nothing to publish';
    const correct = checkTailscaleServe(null, SELF as never, 5002, false, PUBLISHING, skip);
    expect(correct.verdict).toBe('unknown');
    expect(correct.detail).toBe(skip);
    expect(correct.commands).toBeUndefined();
    expect(text(correct.notes ?? [])).toContain('nothing here needs changing');

    // ...and still hands it over when the config genuinely does not publish this Hub.
    const wrong = checkTailscaleServe(null, SELF as never, 5002, false, serveState({ configured: true }), skip);
    expect(wrong.commands).toEqual(['sudo tailscale set --operator=$USER && tailscale serve --bg --yes --https=443 http://localhost:5002']);
    expect(countPoolIssues([correct, wrong])).toBe(0);
  });

  it('passes when serve publishes /identify, and says the first attempt waited on the cert', () => {
    const check = checkTailscaleServe(probe({ ms: 240 }), SELF as never, 5002, true, PUBLISHING);
    expect(check.verdict).toBe('ok');
    expect(check.detail).toContain('cert issuance');
  });
});

// ─── D1 ──────────────────────────────────────────────────────────────────────

describe('D1 capabilities budget', () => {
  const perBackend = [
    { backend: 'ollama', ms: 120, ok: true, detail: '8 model(s)' },
    { backend: 'mtplx', ms: 5010, ok: false, detail: 'no answer' },
  ];

  it('fails over the 8s peer probe budget and names the slowest backend', () => {
    // 10.02s: the figure measured on the node that went `unreachable` fleet-wide.
    const check = checkCapabilityBudget(10_020, ['getStatus() 10020ms'], perBackend, true);
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('10020ms');
    expect(check.detail).toContain('OVER');
    const notes = text(check.notes ?? []);
    // `toContain('mtplx')` matched the per-backend breakdown, which is printed whatever the ranking
    // says — so reversing the sort, or deleting the guidance line outright, passed. The claim in the
    // title is that the SLOWEST backend is named as the place to start, so that is what is asserted.
    expect(notes).toContain('Start with mtplx at 5010ms');
    expect(notes).not.toContain('Start with ollama');
    expect(notes).toContain('unreachable');
  });

  it('warns inside the budget but under 2x margin', () => {
    expect(checkCapabilityBudget(5_000, [], [], true).verdict).toBe('warn');
    expect(checkCapabilityBudget(4_000, [], [], true).verdict).toBe('warn');
  });

  it('passes with margin, and still shows the breakdown', () => {
    const check = checkCapabilityBudget(21, ['getStatus() 21ms'], perBackend, true);
    expect(check.verdict).toBe('ok');
    expect(text(check.notes ?? [])).toContain('ollama');
  });

  it('says so when only one of the two concurrent fan-outs could be measured', () => {
    expect(text(checkCapabilityBudget(21, [], [], false).notes ?? [])).toContain('at least this slow');
    expect(text(checkCapabilityBudget(21, [], [], true).notes ?? [])).not.toContain('at least this slow');
  });
});

// ─── D1 measurement ──────────────────────────────────────────────────────────
//
// `checkCapabilityBudget` above is the pure classifier; it is handed the number. These cover the
// code that PRODUCES the number, which is the part the 10.02s-vs-8s finding actually rests on: a
// measurement that quietly warmed the path, timed one route, or returned a constant would classify
// perfectly and still be wrong.

describe('D1 cold capabilities measurement', () => {
  const HEALTH = 'http://127.0.0.1:5002/api/inference/health';
  const MODELS = 'http://127.0.0.1:5002/api/inference/v1/models';

  /**
   * A stand-in for `timedFetch` that sleeps a planned amount and records when each call ran.
   *
   * Per-call start/end rather than a peak in-flight counter: a peak of 2 is reached by the first
   * pair alone, so it cannot tell whether a LATER pair overlapped. Asserting that two named calls
   * overlap each other is what actually pins each Promise.all down.
   */
  function fakeFetcher(plan: (url: string, nth: number) => { ms: number; ok?: boolean; status?: number | null; body?: string }) {
    const calls: { url: string; from: number; to: number }[] = [];
    const seen = new Map<string, number>();
    const fetchProbe = async (url: string) => {
      const nth = (seen.get(url) ?? 0) + 1;
      seen.set(url, nth);
      const step = plan(url, nth);
      const started = performance.now();
      const call = { url, from: started, to: Number.POSITIVE_INFINITY };
      calls.push(call);
      await new Promise((resolve) => setTimeout(resolve, step.ms));
      call.to = performance.now();
      return {
        ok: step.ok ?? true,
        status: step.status === undefined ? 200 : step.status,
        ms: call.to - started,
        body: step.body ?? '{}',
        error: null,
      };
    };
    /** True when calls `a` and `b` were in flight at the same time. */
    const overlap = (a: number, b: number) =>
      calls[a] !== undefined && calls[b] !== undefined && calls[a].from < calls[b].to && calls[b].from < calls[a].to;
    return { fetchProbe, overlap, urls: () => calls.map((call) => call.url) };
  }

  it('times the two halves concurrently, as one wall clock rather than a sum', async () => {
    // getOwnInventory awaits Promise.all([getStatus(), listModels()]), so the node pays for the
    // SLOWER of the two, not both. Timing them one after the other would over-report every node.
    const fake = fakeFetcher((url) => ({ ms: url === HEALTH ? 120 : 220 }));
    const { totalMs, measuredBothHalves } = await measureColdCapabilityBuild('http://127.0.0.1:5002', fake.fetchProbe);

    // The two halves were genuinely in flight together, not one after the other.
    expect(fake.overlap(0, 1)).toBe(true);
    // Real elapsed time, so a constant cannot pass...
    expect(totalMs).toBeGreaterThanOrEqual(200);
    // ...and genuinely overlapped, so a sequential 340ms cannot either.
    expect(totalMs).toBeLessThan(320);
    expect(measuredBothHalves).toBe(true);
  });

  it('measures exactly the two routes the peer build calls, and nothing before them', async () => {
    const fake = fakeFetcher(() => ({ ms: 5 }));
    const { halves } = await measureColdCapabilityBuild('http://127.0.0.1:5002', fake.fetchProbe);

    // Exactly two: a warm-up request ahead of the timed window would prime the fan-out being timed,
    // and every cited number would then be the warm path the peer never sees.
    expect(fake.urls()).toEqual([HEALTH, MODELS]);
    expect(halves[0]).toContain('/api/inference/health');
    expect(halves[1]).toContain('/api/inference/v1/models');
  });

  it('stands in two concurrent getStatus() calls when the build has no /v1/models route', async () => {
    // 250ms first, 40ms after: enough of a gap that returning the FIRST window or the cumulative
    // elapsed time instead of the re-measured one is visible in the number.
    const fake = fakeFetcher((url, nth) => (url === MODELS ? { ms: 10, ok: false, status: 404 } : { ms: nth === 1 ? 250 : 40 }));
    const { totalMs, halves, statusProbe, measuredBothHalves } = await measureColdCapabilityBuild('http://127.0.0.1:5002', fake.fetchProbe);

    expect(fake.urls()).toEqual([HEALTH, MODELS, HEALTH, HEALTH]);
    // The stand-in pair is a Promise.all too — run sequentially it would double the number it reports.
    expect(fake.overlap(2, 3)).toBe(true);
    expect(measuredBothHalves).toBe(true);
    // The re-measured window only — not the 250ms first attempt, not the ~290ms of both.
    expect(totalMs).toBeGreaterThanOrEqual(25);
    expect(totalMs).toBeLessThan(150);
    expect(statusProbe.ms).toBeLessThan(150);
    expect(halves[1]).toContain('stand-in');
    expect(halves[1]).toContain('no /v1/models route');
  });

  it('does not re-measure when the Hub itself is not answering', async () => {
    // Both halves down is A2's finding, not D1's. Spending a second full window on it would
    // double the wait on the one node that is simply not running.
    const fake = fakeFetcher(() => ({ ms: 5, ok: false, status: 503 }));
    const { statusProbe, measuredBothHalves, halves } = await measureColdCapabilityBuild('http://127.0.0.1:5002', fake.fetchProbe);

    expect(fake.urls()).toEqual([HEALTH, MODELS]);
    expect(statusProbe.ok).toBe(false);
    expect(measuredBothHalves).toBe(false);
    expect(halves[1]).toContain('HTTP 503');
  });
});

// ─── D2 ──────────────────────────────────────────────────────────────────────

describe('D2 backend DNS', () => {
  it('reads the backend URL vars, with SPECULATIVE_INFERENCE_URL winning over LUCEBOX_URL', () => {
    const specs = resolveBackendUrlSpecs({
      OLLAMA_URL: 'http://127.0.0.1:11434',
      MTPLX_URL: 'http://mtplx:8000',
      LUCEBOX_URL: 'http://lucebox:8080',
      SPECULATIVE_INFERENCE_URL: 'http://spec:8080',
      VLLM_URL: 'not a url',
    });
    expect(specs.map((spec) => [spec.variable, spec.hostname, spec.isIpLiteral, spec.malformed])).toEqual([
      ['OLLAMA_URL', '127.0.0.1', true, false],
      ['VLLM_URL', null, false, true],
      ['MTPLX_URL', 'mtplx', false, false],
      ['SPECULATIVE_INFERENCE_URL', 'spec', false, false],
    ]);
  });

  it('fails a lookup that BLOCKS, and prints both halves of the dns_opt fix', () => {
    const specs = resolveBackendUrlSpecs({ MTPLX_URL: 'http://mtplx:8000' });
    const check = checkBackendDns(specs, [{ host: 'mtplx', ms: 5_010, code: 'EAI_AGAIN' }], 'container', 'container');
    expect(check.verdict).toBe('fail');
    const notes = text(check.notes ?? []);
    expect(notes).toContain('blocks then fails EAI_AGAIN');
    expect(notes).toContain('MTPLX_URL=http://127.0.0.1:1');
    expect(notes).toContain('attempts:5');
    expect(notes).toContain('timeout:2');
  });

  it('treats a fast failure as a real finding from the container and undecidable from the host', () => {
    const specs = resolveBackendUrlSpecs({ MTPLX_URL: 'http://mtplx:8000' });
    const results = [{ host: 'mtplx', ms: 3, code: 'EAI_AGAIN' }];
    expect(checkBackendDns(specs, results, 'container', 'container').verdict).toBe('fail');

    const fromHost = checkBackendDns(specs, results, 'host', 'file');
    expect(fromHost.verdict).toBe('unknown');
    expect(countPoolIssues([fromHost])).toBe(0);
    expect(text(fromHost.notes ?? [])).toContain('undecidable');
  });

  it('fails a slow lookup even from the host, because a block costs the budget from any vantage', () => {
    const specs = resolveBackendUrlSpecs({ MTPLX_URL: 'http://mtplx:8000' });
    expect(checkBackendDns(specs, [{ host: 'mtplx', ms: 5_010, code: 'EAI_AGAIN' }], 'host', 'file').verdict).toBe('fail');
  });

  it('needs no lookup for an IP literal, and passes a name that resolves fast', () => {
    const specs = resolveBackendUrlSpecs({ OLLAMA_URL: 'http://127.0.0.1:11434', MTPLX_URL: 'http://mtplx:8000' });
    const check = checkBackendDns(specs, [{ host: 'mtplx', ms: 4, code: null }], 'container', 'container');
    expect(check.verdict).toBe('ok');
    expect(text(check.notes ?? [])).toContain('IP literal, no lookup');
  });

  it('fails a variable that is not a URL at all', () => {
    expect(checkBackendDns(resolveBackendUrlSpecs({ VLLM_URL: 'nope' }), [], 'container', 'container').verdict).toBe('fail');
  });

  it('names the variable but never the value when a backend URL is malformed', () => {
    // D2 reads the env file the Hub was actually started from, so a malformed value here is the
    // operator's real configuration rather than a repo placeholder — and a URL that fails to parse
    // very often fails because of the `user:password@` in it. The variable name is enough to fix it.
    const secret = 'http://admin:hunter2@';
    const check = checkBackendDns(resolveBackendUrlSpecs({ VLLM_URL: secret }), [], 'container', 'container');
    const rendered = [check.detail, ...(check.notes ?? []), ...(check.commands ?? [])].join('\n');

    expect(check.verdict).toBe('fail');
    expect(rendered).toContain('VLLM_URL');
    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('admin');
  });

  it('probes the container with dns.lookup — never curl, never getent', () => {
    resolveHubContainerName.mockReturnValue('ci-hub');
    spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify([{ host: 'mtplx', ms: 5010, code: 'EAI_AGAIN' }]) });

    expect(probeDnsFromContainer(['mtplx'])).toEqual([{ host: 'mtplx', ms: 5010, code: 'EAI_AGAIN' }]);

    const [command, args] = spawnSync.mock.calls[0] as [string, string[]];
    const script = args[args.length - 1] as string;
    expect(command).toBe('docker');
    expect(args.slice(0, 4)).toEqual(['exec', 'ci-hub', 'node', '-e']);
    // The crux: curl fails instantly on an unresolvable compose name while getaddrinfo blocks ~5s,
    // so a curl- or getent-based probe cannot see this bug at all.
    expect(script).toContain('dns.lookup');
    expect(script).not.toContain('curl');
    expect(script).not.toContain('getent');
  });

  it('returns null rather than a verdict when there is no container to probe from', () => {
    resolveHubContainerName.mockReturnValue(undefined);
    expect(probeDnsFromContainer(['mtplx'])).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  // An empty list of backend URLs is two opposite findings wearing the same shape, and reporting
  // the wrong one as a green check silences this exact check on the install it exists for: an
  // appliance whose Hub container is stopped, where compose holds every URL and the env file none.
  it('cannot decide an empty list when the container environment was unreadable', () => {
    const check = checkBackendDns([], [], 'host', 'unreadable');
    expect(check.verdict).toBe('unknown');
    expect(countPoolIssues([check])).toBe(0);
    const rendered = text(formatPoolCheckLines([check]));
    expect(rendered).toContain('cannot determine');
    expect(rendered).toContain('environment:');
    // The tell that this is not being rendered as a pass.
    expect(rendered).not.toContain('✓');
  });

  it('passes an empty list only when something authoritative said it is empty', () => {
    expect(checkBackendDns([], [], 'container', 'container').verdict).toBe('ok');
    expect(checkBackendDns([], [], 'host', 'file').verdict).toBe('ok');
  });

  it('will not call a clean sweep of a possibly-partial list a pass', () => {
    const specs = resolveBackendUrlSpecs({ MTPLX_URL: 'http://mtplx:8000' });
    const fast = [{ host: 'mtplx', ms: 4, code: null }];
    expect(checkBackendDns(specs, fast, 'container', 'container').verdict).toBe('ok');

    const partial = checkBackendDns(specs, fast, 'container', 'unreadable');
    expect(partial.verdict).toBe('unknown');
    expect(countPoolIssues([partial])).toBe(0);
    expect(text(partial.notes ?? [])).toContain('invisible to this run');
  });

  it('still fails a blocked lookup even when the list may be partial', () => {
    const specs = resolveBackendUrlSpecs({ MTPLX_URL: 'http://mtplx:8000' });
    expect(checkBackendDns(specs, [{ host: 'mtplx', ms: 5_010, code: 'EAI_AGAIN' }], 'host', 'unreadable').verdict).toBe('fail');
  });

  /**
   * The host path is the ONLY DNS path on a machine with no Docker — the machine the whole command
   * is meant to work on. Its container sibling is well guarded; this one had nothing, so a version
   * that reported `{ ms: 0, code: null }` for every host — a probe that can never find anything —
   * passed the entire suite.
   */
  it('resolves on the host with dns.lookup, and reports the code and the time it took', async () => {
    dnsLookup.mockImplementation((host: string, done: (error: NodeJS.ErrnoException | null) => void) => {
      setTimeout(() => done(host === 'mtplx' ? Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }) : null), 25);
    });

    const results = await probeDnsFromHost(['mtplx', 'ollama']);

    expect(results.map((result) => [result.host, result.code])).toEqual([
      ['mtplx', 'EAI_AGAIN'],
      ['ollama', null],
    ]);
    // A real elapsed measurement, not a constant: DNS_SLOW_MS is decided on this number.
    expect(results[0]?.ms).toBeGreaterThanOrEqual(20);
    expect(dnsLookup).toHaveBeenCalledTimes(2);
    expect(dnsLookup.mock.calls.map(([host]) => host)).toEqual(['mtplx', 'ollama']);
  });

  it('reports a resolver error with no code as a failure rather than as a clean resolve', async () => {
    dnsLookup.mockImplementation((_host: string, done: (error: Error) => void) => done(new Error('no code on this one')));
    expect((await probeDnsFromHost(['mtplx']))[0]?.code).toBe('ERROR');
  });

  /**
   * `docker-compose.prod.yml` sets the backend URLs in the service `environment:` block, so on a
   * compose install the env file has none of them and the container has all of them. Reading only
   * the file reported "no backend URLs configured" on core-2, which runs six — inverting the finding
   * this check exists to make. Nothing called this function in a test.
   */
  it('reads the backend URLs out of the container, and nothing else in that block', () => {
    resolveHubContainerName.mockReturnValue('ci-hub');
    spawnSync.mockReturnValue({
      status: 0,
      stdout: [
        'PATH=/usr/bin',
        'OLLAMA_URL=http://host.docker.internal:11434',
        'POSTGRES_PASSWORD=hunter2-not-a-real-password',
        'MTPLX_URL=http://mtplx:8000',
        'CI_HUB_DEVICE_KEY=cihub_not_a_real_key',
        '',
      ].join('\n'),
    });

    const vars = readBackendVarsFromContainer();

    expect(vars).toEqual({ OLLAMA_URL: 'http://host.docker.internal:11434', MTPLX_URL: 'http://mtplx:8000' });
    // Everything beside them in that block is a secret, so nothing else is even carried into memory.
    expect(JSON.stringify(vars)).not.toContain('hunter2-not-a-real-password');
    expect(JSON.stringify(vars)).not.toContain('cihub_not_a_real_key');
  });

  it('says "could not read" rather than "none set" when there is no container to inspect', () => {
    resolveHubContainerName.mockReturnValue(undefined);
    expect(readBackendVarsFromContainer()).toBeNull();

    resolveHubContainerName.mockReturnValue('ci-hub');
    spawnSync.mockReturnValue({ status: 1, stdout: '' });
    expect(readBackendVarsFromContainer()).toBeNull();
  });
});

// ─── D3 ──────────────────────────────────────────────────────────────────────

describe('D3 non-streaming headroom', () => {
  it('ranks models by parameter count off the id', () => {
    expect(modelParameterBillions('gemma3:27b')).toBe(27);
    expect(modelParameterBillions('llama3.2:3b')).toBe(3);
    expect(modelParameterBillions('some-model')).toBe(0);
  });

  it('picks the heaviest model that is actually loaded', () => {
    const models = [
      { id: 'llama3.2:3b', state: 'loaded', local: true },
      { id: 'gemma3:27b', state: 'loaded', local: true },
      { id: 'qwen:72b', state: 'available', local: true },
    ];
    expect(pickLargestLoadedModel(models as never)?.id).toBe('gemma3:27b');
    expect(pickLargestLoadedModel([])).toBeNull();
  });

  /**
   * Both shapes are from the live core-2 inventory. A `pulled` model is on disk and not in VRAM, so
   * probing it times the cold LOAD and reports it as the buffering defect on a healthy node; a
   * chat-completion POST to `nomic-embed-text` answers 400, which D3 printed as a peer-budget
   * failure. Neither is a finding about the peer budget, and both were reachable before.
   */
  it('will not measure a model the engine is not actually holding', () => {
    const onDiskOnly = [
      { id: 'nomic-embed-text', state: 'pulled', local: true, modality: ['embedding'] },
      { id: 'gemma4-31b', state: 'pulled', local: true, modality: ['text'] },
      { id: 'qwen3-8-27b', state: 'available', local: true, modality: ['text'] },
      { id: 'kokoro-82m', state: 'loading', local: true, modality: ['tts'] },
    ];
    expect(pickLargestLoadedModel(onDiskOnly as never)).toBeNull();

    // `pinned` is resident too, and a build that reports no modality at all is not excluded by it.
    expect(pickLargestLoadedModel([{ id: 'gemma3:27b', state: 'pinned', local: true, modality: ['text'] }] as never)?.id).toBe('gemma3:27b');
    expect(pickLargestLoadedModel([{ id: 'gemma3:27b', state: 'loaded', local: true }] as never)?.id).toBe('gemma3:27b');
  });

  it('never picks a non-text model, however heavy it is', () => {
    // The heavier model is the transcription one, so only the modality filter can decide this: a
    // chat-completion POST to it answers 400, which D3 reported as a peer-budget failure.
    const models = [
      { id: 'qwen3-omni-30b', state: 'loaded', local: true, modality: ['stt'] },
      { id: 'llama3.2:3b', state: 'loaded', local: true, modality: ['text'] },
    ];
    expect(modelParameterBillions('qwen3-omni-30b')).toBeGreaterThan(modelParameterBillions('llama3.2:3b'));
    expect(pickLargestLoadedModel(models as never)?.id).toBe('llama3.2:3b');
  });

  it('is skipped by default, and says it costs GPU time', () => {
    const check = checkNonStreamingHeadroom(null, null, { pooled: false, servedBy: null });
    expect(check.verdict).toBe('skipped');
    expect(check.detail).toContain('--check-latency');
    expect(countPoolIssues([check])).toBe(0);
  });

  it('fails past the peer first-byte budget and explains the streaming asymmetry', () => {
    const check = checkNonStreamingHeadroom(probe({ ms: 301_400 }), { id: 'gemma3:27b' } as never, { pooled: false, servedBy: 'local' });
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('OVER the 300000ms');
    expect(text(check.notes ?? [])).toContain('streaming');
  });

  it('refuses to attribute a pooled answer to this node', () => {
    const check = checkNonStreamingHeadroom(probe({ ms: 900 }), { id: 'gemma3:27b' } as never, { pooled: true, servedBy: 'hub-b' });
    expect(check.verdict).toBe('unknown');
    expect(check.detail).toContain('may have been pooled');
  });

  it('passes a fast local answer', () => {
    expect(checkNonStreamingHeadroom(probe({ ms: 900 }), { id: 'gemma3:27b' } as never, { pooled: false, servedBy: 'local' }).verdict).toBe('ok');
  });
});

// ─── rendering / counting ────────────────────────────────────────────────────

describe('rendering', () => {
  it('counts only decided failures as issues', () => {
    const checks = [
      { id: 'X1', label: 'a', verdict: 'fail' as const, detail: '' },
      { id: 'X2', label: 'b', verdict: 'warn' as const, detail: '' },
      { id: 'X3', label: 'c', verdict: 'unknown' as const, detail: '' },
      { id: 'X4', label: 'd', verdict: 'skipped' as const, detail: '' },
      { id: 'X5', label: 'e', verdict: 'ok' as const, detail: '' },
    ];
    expect(countPoolIssues(checks)).toBe(2);
    expect(summarisePoolChecks(checks)).toBe('1 failed, 1 warned, 1 undetermined, 1 skipped');
    expect(summarisePoolChecks([checks[4] as never])).toBe('all 1 checks passed');
  });

  /**
   * `colorize` no-ops unless stdout is a TTY, so any distinction carried by colour alone vanishes
   * the moment the report is piped, redirected or pasted into a bug — which is how a fleet report
   * actually travels. warn and unknown/skipped previously shared the glyph `○` and differed only in
   * ANSI, so A4 (a counted finding with a remediation) and C2 (could not look) rendered identically.
   * Asserted on the stripped text for exactly that reason.
   */
  it('gives each of the five verdicts its own glyph, with no colour to lean on', () => {
    const verdicts = ['ok', 'warn', 'fail', 'unknown', 'skipped'] as const;
    const glyphs = verdicts.map((verdict) => {
      const [line] = formatPoolCheckLines([{ id: 'X1', label: 'Check', verdict, detail: 'detail' }]);
      const rendered = stripAnsi(line ?? '');
      expect(rendered).toContain('X1 Check');
      expect(rendered.endsWith(' detail')).toBe(true);
      return (
        rendered
          .slice(0, rendered.length - ' detail'.length)
          .trim()
          .split(' ')
          .pop() ?? ''
      );
    });

    expect(new Set(glyphs).size).toBe(5);
    expect(glyphs).toEqual(['✓', '!', '✗', '?', '-']);
  });

  it('renders the id, the label and every remediation command', () => {
    const rendered = text(
      formatPoolCheckLines([{ id: 'D2', label: 'Backend DNS', verdict: 'fail', detail: 'boom', notes: ['why'], commands: ['fix it'] }]),
    );
    expect(rendered).toContain('D2 Backend DNS');
    expect(rendered).toContain('boom');
    expect(rendered).toContain('why');
    expect(rendered).toContain('$ fix it');
  });
});

// ─── whole run ───────────────────────────────────────────────────────────────

// ─── F1 ──────────────────────────────────────────────────────────────────────

describe('F1 peers accept this node', () => {
  // Placeholder tailnet names only — docs/README.md tip-scrub policy.
  const RECREATED = 'hub-b.example-tailnet.ts.net';
  const failure = (kind: 'identity_changed' | 'unauthorized' | 'unreachable') => ({
    kind,
    httpStatus: kind === 'unreachable' ? null : 401,
    detail: 'capabilities probe returned 401',
    since: '2026-09-16T10:00:00.000Z',
    lastAttemptAt: '2026-09-17T14:00:00.000Z',
    attempts: 120,
    nextProbeAt: kind === 'unreachable' ? null : '2026-09-17T14:15:00.000Z',
    action:
      kind === 'unreachable'
        ? null
        : `Re-pair: (1) here: cihub pool unpair ${RECREATED}; (2) on ${RECREATED}: cihub pool pairing-pin; (3) here: cihub pool pair ${RECREATED} --pin <digits>`,
  });

  it('fails when a peer now answers as a different identity, and prints the re-pair steps', () => {
    // Every peer of beta-max passed every other check in this doctor while it did this for 28 hours.
    const check = checkPeerIdentities([{ nodeFqdn: RECREATED, status: 'unreachable', probeFailure: failure('identity_changed') }], null);

    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain(RECREATED);
    expect(text(formatPoolCheckLines([check]))).toContain(`cihub pool unpair ${RECREATED}`);
    // Read-only: the doctor names the commands in notes but never offers one as a fix to run here.
    expect(check.commands).toBeUndefined();
  });

  it('warns rather than fails on a bare 401, which can be clock skew', () => {
    expect(checkPeerIdentities([{ nodeFqdn: RECREATED, status: 'connected', probeFailure: failure('unauthorized') }], null).verdict).toBe('warn');
  });

  it('passes a pool whose peers are merely unreachable or healthy, since neither needs a re-pair', () => {
    const check = checkPeerIdentities(
      [
        { nodeFqdn: RECREATED, status: 'unreachable', probeFailure: failure('unreachable') },
        { nodeFqdn: 'hub-c.example-tailnet.ts.net', status: 'connected', probeFailure: null },
      ],
      null,
    );

    expect(check).toMatchObject({ verdict: 'ok', detail: '2 paired peer(s), none refusing this node' });
  });

  it('says it cannot tell on a Hub that predates the classification, instead of a false pass', () => {
    expect(checkPeerIdentities([{ nodeFqdn: RECREATED, status: 'unreachable' }], null).verdict).toBe('unknown');
  });

  it('passes a Hub with no paired peers, and does not count a pending request as one', () => {
    expect(checkPeerIdentities([], null)).toMatchObject({ verdict: 'ok', detail: 'no paired peers' });
    expect(checkPeerIdentities([{ nodeFqdn: RECREATED, status: 'pending' }], null)).toMatchObject({ verdict: 'ok' });
  });

  it('reads the Hub’s own verdict through pool status and fails the run on a changed identity', async () => {
    readHubApiKey.mockReturnValue('cihub_super_secret_device_key');
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/inference/pool/status')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ peers: [{ nodeFqdn: RECREATED, status: 'unreachable', probeFailure: failure('identity_changed') }] }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ isCiHub: true, poolProtocol: 2 }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const f1 = text(section.lines)
      .split('\n')
      .find((line) => line.includes('F1'));

    expect(f1).toContain('different Hub Pool identity');
    expect(section.failureCount).toBeGreaterThanOrEqual(1);
    // The operator key reached the authenticated route and never the report.
    expect(text(section.lines)).not.toContain('cihub_super_secret_device_key');
    vi.unstubAllGlobals();
  });

  describe('F2 — context caps', () => {
    const local = (maxNumCtx?: number | null) => ({ nodeFqdn: 'hub-a.example-tailnet.ts.net', ...(maxNumCtx === undefined ? {} : { maxNumCtx }) });
    const capped = (node: string, maxNumCtx?: number | null, rest: Record<string, unknown> = {}) => ({
      nodeFqdn: node,
      status: 'connected',
      lastCapabilities: {},
      ...(maxNumCtx === undefined ? {} : { maxNumCtx }),
      ...rest,
    });

    it('warns on a spread, naming the nodes a handout now places behind', () => {
      // The 2026-09-21 fleet: 8192 on core-14, 65536 on core-2, and nothing said so.
      const check = checkContextCaps(
        local(65_536),
        [capped('core-14.example-tailnet.ts.net', 8_192), capped('core-2.example-tailnet.ts.net', 65_536)],
        null,
      );

      expect(check.verdict).toBe('warn');
      expect(check.detail).toContain('8192 … 65536');
      expect(text(formatPoolCheckLines([check]))).toContain('core-14.example-tailnet.ts.net');
      expect(check.commands).toEqual(['cihub fleet backends --backends ollama --ollama-context <N> --execute']);
    });

    it('warns harder on an uncapped node among capped ones, which is where the large windows land', () => {
      const check = checkContextCaps(local(65_536), [capped('beta-nas.example-tailnet.ts.net', null)], null);

      expect(check.verdict).toBe('warn');
      expect(check.detail).toContain('beta-nas.example-tailnet.ts.net');
      expect(check.detail).toContain('no cap');
      expect(text(formatPoolCheckLines([check]))).toContain('takes any window');
    });

    it('passes a pool that agrees, and one where nothing is capped at all', () => {
      expect(checkContextCaps(local(65_536), [capped('hub-b.example-tailnet.ts.net', 65_536)], null)).toMatchObject({
        verdict: 'ok',
        detail: 'every node here caps at 65536',
      });
      expect(checkContextCaps(local(null), [capped('hub-b.example-tailnet.ts.net', null)], null)).toMatchObject({ verdict: 'ok' });
    });

    it('does not read an unknown cap as an uncapped one, and does not call that a pass either', () => {
      // A peer this node has never had a snapshot from is not evidence of anything. Saying "no cap"
      // for it would invent a finding; saying "capped" would hide one. `unknown` is neither, and —
      // like every other undetermined check here — it is not counted as an issue.
      const check = checkContextCaps(local(65_536), [capped('hub-b.example-tailnet.ts.net', null, { lastCapabilities: null })], null);

      expect(check.verdict).toBe('unknown');
      expect(check.detail).toContain('do not report one');
      expect(text(formatPoolCheckLines([check]))).toContain('Not read as uncapped');

      // A decided finding still stands when something else is unknown.
      const mixed = checkContextCaps(
        local(65_536),
        [capped('hub-b.example-tailnet.ts.net', null), capped('hub-c.example-tailnet.ts.net', null, { lastCapabilities: null })],
        null,
      );
      expect(mixed.verdict).toBe('warn');
      expect(text(formatPoolCheckLines([mixed]))).toContain('Not read as uncapped');
    });

    it('is silent about peers this node would not route to, and about a pool with none', () => {
      expect(checkContextCaps(local(65_536), [capped('hub-b.example-tailnet.ts.net', 8_192, { enabled: false })], null)).toMatchObject({
        verdict: 'ok',
        detail: 'no connected peers, so nothing here is placed by a cap',
      });
      expect(checkContextCaps(local(65_536), [], null).verdict).toBe('ok');
    });

    it('says it could not tell rather than passing, on an unreadable status or a Hub predating caps', () => {
      expect(checkContextCaps(null, null, 'the Hub is not answering locally (see A2)')).toMatchObject({ verdict: 'unknown' });
      const old = checkContextCaps({ nodeFqdn: 'hub-a.example-tailnet.ts.net' }, [capped('hub-b.example-tailnet.ts.net')], null);
      expect(old).toMatchObject({ verdict: 'unknown', detail: 'this Hub build does not report context caps' });
    });
  });
});

describe('runPoolDoctorSection', () => {
  it('produces a full report on a machine with no Docker, no Tailscale and no Hub', async () => {
    // Nothing answers: fetch rejects, tailscale is missing, no container, no env file.
    const failure = new Error('fetch failed');
    failure.stack = 'Error: fetch failed\n    at timedFetch (/srv/ci/scripts/pool-diagnostics-cli.ts:204:20)\n    at async collectSectionA';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
    spawnSync.mockReturnValue({ status: 1, stdout: '' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const rendered = text(section.lines);

    for (const id of ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'D1', 'D2', 'D3', 'F1', 'F2']) expect(rendered).toContain(id);
    expect(rendered).toContain('Hub Pool preflight');

    // Structure, in RENDER ORDER — the loop above is a substring check over the joined text, so it
    // is order-agnostic and duplicate-blind. Renaming section C's header to `B` (headers A,B,B,D,E,
    // no C at all) and reversing section B's checks both passed 825 tests.
    const lines = rendered.split('\n');
    const headers = lines.filter((line) => /^[A-F] {2}\w/.test(line.trim())).map((line) => line.trim()[0]);
    expect(headers).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(lines.filter((line) => /^ {2}[A-Z]\d /.test(line)).map((line) => line.trim().split(' ')[0])).toEqual([
      'A1',
      'A2',
      'A3',
      'A4',
      'B1',
      'B2',
      'B3',
      'B4',
      'C1',
      'C2',
      'D1',
      'D2',
      'D3',
      'F1',
      'F2',
    ]);
    // A reported reason ("Error: fetch failed") is the point; a stack trace is the failure mode.
    // Asserted on frame TEXT, not on indentation: sanitizeForBox collapses every whitespace run
    // before a line reaches the box, so `not.toContain('    at ')` could never fail — a stack
    // appended to every probe error survived it whitespace-collapsed and the assertion still passed.
    expect(rendered).toContain('Error: fetch failed');
    expect(rendered).not.toContain('at timedFetch');
    expect(rendered).not.toContain('pool-diagnostics-cli.ts:');
    expect(rendered).not.toMatch(/ at \S+ \(/);
    expect(rendered).not.toContain('unavailable (');
    expect(section.remediationCommands).toContain('cihub up prod');
    vi.unstubAllGlobals();
  });

  it('does not print D2 as a pass when there was no container to read the backend URLs from', async () => {
    // The wiring half of the same bug: `readBackendVarsFromContainer` returning null is "could not
    // look", and folding that into "the file is the whole configuration" prints a green D2 with 0
    // issues on exactly the appliance install — Hub container down, every URL in compose — that
    // this check exists to inspect.
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    resolveHubContainerName.mockReturnValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    spawnSync.mockReturnValue({ status: 1, stdout: '' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const rendered = text(section.lines).split('\n');
    const d2 = rendered.find((line) => line.includes('D2')) ?? '';
    expect(d2).toContain('cannot determine');
    expect(d2).not.toContain('✓');
    vi.unstubAllGlobals();
  });

  /**
   * The wiring the head commit was written for: compose sets the backend URLs on the CONTAINER, so
   * the container environment has to win over the env file. Replacing the merge with `fileVars`
   * reintroduces the exact defect — core-2 running six backends, reported as "no backend URLs
   * configured, so the capabilities build resolves nothing" — and nothing in the suite noticed.
   */
  it('resolves the backend URLs the container has, and lets them override the env file', async () => {
    // The env file names MTPLX_URL too, at a different address — an IP literal, which needs no
    // lookup at all. Whichever side wins is visible in the verdict, so precedence is pinned by it.
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub', MTPLX_URL: 'http://127.0.0.1:1' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    resolveHubContainerName.mockReturnValue('ci-hub');
    isHubContainerRunning.mockReturnValue(true);
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command !== 'docker') return { status: 1, stdout: '', stderr: '' };
      if (args[0] === 'inspect' && String(args[3]).includes('{{range .Config.Env}}')) {
        return {
          status: 0,
          stdout: ['OLLAMA_URL=http://127.0.0.1:11434', 'MTPLX_URL=http://mtplx:8000', 'POSTGRES_PASSWORD=hunter2-not-a-real-password'].join('\n'),
        };
      }
      if (args[0] === 'exec') return { status: 0, stdout: JSON.stringify([{ host: 'mtplx', ms: 5010, code: 'EAI_AGAIN' }]) };
      return { status: 1, stdout: '', stderr: '' };
    });
    /** The hostnames actually handed to the in-container probe script. */
    const dnsProbeHosts = () => {
      const exec = spawnSync.mock.calls.find(([command, args]) => command === 'docker' && (args as string[])[0] === 'exec');
      const script = String((exec?.[1] as string[])?.at(-1) ?? '');
      return JSON.parse(/const hs=(\[.*?\]);/.exec(script)?.[1] ?? '[]');
    };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const rendered = text(section.lines);
    const d2 = rendered.split('\n').find((line) => line.includes('D2 Backend DNS')) ?? '';

    // The finding it exists to make, from a file that declares nothing.
    expect(d2).toContain('1 of 2 backend URL(s) do not resolve cleanly');
    expect(rendered).toContain('MTPLX_URL');
    // The container's value, not the file's: the file's would be an IP literal and never probed.
    expect(dnsProbeHosts()).toEqual(['mtplx']);
    expect(rendered).toContain('blocks then fails EAI_AGAIN');
    expect(rendered).toContain('URLs read from the container environment');
    // ...and the rest of that env block, which is where the Hub keeps its secrets, stays out.
    expect(rendered).not.toContain('hunter2-not-a-real-password');
    vi.unstubAllGlobals();
  });

  it('falls back to the host resolver when there is no container, and says the vantage is the host', async () => {
    // The Docker-less box: the env file is all there is, and dns.lookup on the host is the only probe.
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub', MTPLX_URL: 'http://mtplx:8000' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    dnsLookup.mockImplementation((_host: string, done: (error: NodeJS.ErrnoException) => void) =>
      done(Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' })),
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const rendered = text(section.lines);

    expect(dnsLookup.mock.calls.map(([host]) => host)).toEqual(['mtplx']);
    expect(rendered).toContain('Measured on the HOST with dns.lookup');
    // Fast failure from the host is undecidable, not a finding — it may resolve inside the container.
    expect(rendered).toContain('undecidable');
    vi.unstubAllGlobals();
  });

  it('reports every version check as undetermined on a box with no git and no Docker', async () => {
    // The machine this runs on most: git absent, Docker absent, nothing to reconcile. Four
    // "could not look" lines and not one of them an issue.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const versionLines = text(section.lines)
      .split('\n')
      .filter((line) => /^\s+B[1-4] /.test(line));
    expect(versionLines).toHaveLength(4);
    for (const line of versionLines) {
      expect(line).toMatch(/cannot (determine|correlate|compare)/);
      expect(line).not.toContain('✓');
      expect(line).not.toContain('✗');
    }
    // A1 (no env file), A2 (no Hub) and A4 (no data dirs) are the only decided findings this box
    // has. Section B adds four "could not look" lines and must add nothing at all to that count.
    expect(section.issueCount).toBe(3);
    vi.unstubAllGlobals();
  });

  /**
   * B3's whole premise is that an appliance keeps its compose OUTSIDE the repo, so the file to
   * compare against is the one the container's own label names. Every B3 test hand-built the
   * declaration and passed it straight to the classifier, so replacing the discovery with the
   * repo's own `docker-compose.prod.yml` — literally reintroducing the beta-max bug of comparing a
   * container against a document it was never created from — passed all 825 tests.
   */
  it('compares the container against the compose file its own label names, not the repo copy', async () => {
    const applianceCompose = '/home/ci/.local/share/companion-hub/docker-compose.prod.yml';
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    readFileSync.mockReturnValue(COMPOSE);
    resolveHubContainerName.mockReturnValue('ci-os-hub');
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'git') {
        if (args.includes('--show-toplevel')) return { status: 0, stdout: '/home/ci/devel/CI-Hub\n', stderr: '' };
        if (args.includes('rev-parse')) return { status: 0, stdout: 'aaaaaaa1111\n', stderr: '' };
        return { status: 1, stdout: '', stderr: '' };
      }
      if (command === 'docker' && args[0] === 'inspect' && String(args[3]).includes('revision=')) {
        return { status: 0, stdout: inspectOutput({ service: 'ci-os-hub', composeFiles: applianceCompose }) };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const rendered = text(section.lines);

    expect(rendered).toContain(`Compared against ${applianceCompose} (service ci-os-hub)`);
    // The repo's own copy is NOT the document this container was created from, and must not be it.
    expect(rendered).not.toContain('Compared against /home/ci/devel/CI-Hub/docker-compose.prod.yml');
    // ...and the comparison is the measured beta-max failure: a container with no host tailscale.
    const b3 = rendered.split('\n').find((line) => line.includes('B3 Compose drift')) ?? '';
    expect(b3).toContain('✗');
    expect(rendered).toContain('/usr/bin/tailscale');
    vi.unstubAllGlobals();
  });

  it('says which label was missing when a container names no compose file at all', async () => {
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    resolveHubContainerName.mockReturnValue('ci-hub');
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'docker' && args[0] === 'inspect' && String(args[3]).includes('revision=')) {
        return { status: 0, stdout: inspectOutput({ composeFiles: '<no value>' }) };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const b3 =
      text(section.lines)
        .split('\n')
        .find((line) => line.includes('B3 Compose drift')) ?? '';

    expect(b3).toContain('com.docker.compose.project.config_files');
    // Undetermined, not drift: the container never named a file, so there is nothing to compare.
    expect(b3).toContain('? cannot determine');
    expect(b3).not.toContain('✗');
    vi.unstubAllGlobals();
  });

  it('reads B2 off the remote rather than the cached ref, on the real run', async () => {
    // Wiring, not classification: the whole-run path has to reach `ls-remote`, or B2 degrades to
    // the frozen count it exists to disbelieve.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command !== 'git') return { status: 1, stdout: '', stderr: '' };
      if (args.includes('--show-toplevel')) return { status: 0, stdout: '/repo\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('HEAD')) return { status: 0, stdout: 'aaaaaaa1111\n', stderr: '' };
      if (args.includes('ls-remote')) return { status: 128, stdout: '', stderr: 'fatal: Authentication failed for https://ci:tok@github.com/x/y\n' };
      if (args.includes('rev-list')) return { status: 0, stdout: '0\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const b2 =
      text(section.lines)
        .split('\n')
        .find((line) => line.includes('B2 Upstream')) ?? '';
    expect(b2).toContain('behind is UNKNOWN, not 0');
    expect(b2).toContain('Authentication failed');
    // The token git echoed back must not survive into the report.
    expect(text(section.lines)).not.toContain('tok@github.com');
    // A1, A2 and A4 again — a node that cannot see its own upstream is undetermined, not a finding.
    expect(section.issueCount).toBe(3);
    vi.unstubAllGlobals();
  });

  /**
   * C2's skip decision, end to end. `tailscale serve` proxies to http://localhost:<API_PORT>: with
   * nothing behind that port there is nothing to publish, and probing anyway spends 8s and then a
   * 40s cert retry on a node whose Hub is simply down — 48 seconds of the operator's time to
   * re-report A2. Nothing pinned that, and nothing pinned that the mutating remediation is withheld
   * when the config is already right.
   */
  it('skips the HTTPS probe when the Hub is down, and stays silent about a serve config that is correct', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command !== 'tailscale') return { status: 1, stdout: '', stderr: '' };
      if (args[0] === 'status') {
        return { status: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'hub-a.example-tailnet.ts.net.' } }) };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          TCP: { '443': { HTTPS: true } },
          Web: { 'hub-a.example-tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://localhost:5002' } } } },
        }),
      };
    });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const c2 = text(section.lines)
      .split('\n')
      .find((line) => line.includes('C2 Tailscale serve'));
    expect(c2).toContain('not probed');

    // The 48 seconds: no request to the node's own MagicDNS name was made at all.
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.startsWith('https://'))).toBe(false);
    expect(urls.every((url) => url.startsWith('http://127.0.0.1:'))).toBe(true);
    // And the config-writing remediation is withheld, because the config is already right.
    expect(section.remediationCommands.join(' ')).not.toContain('tailscale serve');
    vi.unstubAllGlobals();
  });

  /**
   * The first HTTPS request after `tailscale serve` is enabled blocks on cert issuance (~30s
   * measured), so one timeout is not a finding. The brief called the retry out by name — "do not
   * report a timeout as a failure without retrying at least once" — and `if (false)` in its place
   * passed the whole suite, because nothing drove this orchestration at all.
   */
  it('retries the serve probe once before believing a timeout', async () => {
    const serveUrl = 'https://hub-a.example-tailnet.ts.net/api/inference/pool/identify';
    let serveAttempts = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith('https://')) {
        serveAttempts += 1;
        // First attempt blocks on cert issuance; the second is the real answer.
        if (serveAttempts === 1) throw new Error('TimeoutError: The operation was aborted due to timeout');
        return { ok: true, status: 200, text: async () => JSON.stringify({ isCiHub: true, poolProtocol: 2 }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ isCiHub: true, poolProtocol: 2, data: [] }) };
    });
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    probeHostPort.mockResolvedValue(true);
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command !== 'tailscale') return { status: 1, stdout: '', stderr: '' };
      if (args[0] === 'status') {
        return { status: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'hub-a.example-tailnet.ts.net.' } }) };
      }
      return { status: 0, stdout: '{}' };
    });
    vi.stubGlobal('fetch', fetchMock);

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const c2 =
      text(section.lines)
        .split('\n')
        .find((line) => line.includes('C2 Tailscale serve')) ?? '';

    expect(fetchMock.mock.calls.filter(([url]) => url === serveUrl)).toHaveLength(2);
    expect(c2).toContain('✓');
    expect(c2).toContain('cert issuance');
    vi.unstubAllGlobals();
  });

  /**
   * The bridge's contribution to the total, isolated. The test that looked like it covered this
   * asserted `issueCount >= 1` in a scenario where fetch rejects and the pool's own checks already
   * contribute several — so dropping `+ bridge.issueCount` survived. It matters at the consumer:
   * cli-pool.ts picks the box tone from `issueCount > 0`, so on an otherwise-healthy node where ufw
   * silently blocks container→host Ollama, the operator gets a clean cyan box.
   */
  it('counts a bridge finding even when every pool check of its own is clean', async () => {
    runBridgeDoctorSection.mockResolvedValue({
      lines: ['Docker bridge            1 blocked'],
      issueCount: 1,
      failureCount: 1,
      remediationCommands: ['sudo ufw allow from 172.18.0.0/16 to 172.18.0.1 port 11434 proto tcp'],
    });
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    probeHostPort.mockResolvedValue(true);
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ isCiHub: true, poolProtocol: 2, data: [] }) }),
    );

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod', cliSubcommands: ['status', 'peers', 'discover', 'log', 'enable'] });
    const summary = text(section.lines).split('\n')[0] ?? '';

    // Nothing the pool itself checks is a finding here...
    expect(summary).not.toContain('failed');
    expect(summary).not.toContain('warned');
    // ...so this 1 can only have come from the bridge section, and it decides the box colour.
    expect(section.issueCount).toBe(1);
    vi.unstubAllGlobals();
  });

  /**
   * `failureCount` is the half of `issueCount` that says THIS node is broken, and it is what
   * `cli-pool.ts` puts in the exit code. The split has to hold in both directions: a `warn` is state
   * the operator asked to be shown, and an `unknown` — D3's peer-served measurement, a section that
   * could not be collected — decided nothing about the node, so neither may fail the command.
   */
  it('counts a decided failure and nothing else', () => {
    const verdicts = ['fail', 'warn', 'unknown', 'skipped', 'ok'] as const;
    const checks = verdicts.map((verdict, index) => ({ id: `X${index}`, label: 'check', verdict, detail: '' }));

    expect(countPoolIssues(checks)).toBe(2);
    expect(countPoolFailures(checks)).toBe(1);
  });

  it('reports a bridge failure as a failure of this node, not merely an issue', async () => {
    runBridgeDoctorSection.mockResolvedValue({
      lines: ['Docker bridge            1 blocked'],
      issueCount: 1,
      failureCount: 1,
      remediationCommands: [],
    });
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    probeHostPort.mockResolvedValue(true);
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ isCiHub: true, poolProtocol: 2, data: [] }) }),
    );

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod', cliSubcommands: ['status', 'peers', 'discover', 'log', 'enable'] });

    // Nothing this node checks of its own failed, so the 1 is the bridge's — and a container that
    // cannot reach its host backends is this node unusable as a pool member.
    expect(section.failureCount).toBe(1);
    vi.unstubAllGlobals();
  });

  it('keeps a probe that could not decide out of the failure count', async () => {
    runBridgeDoctorSection.mockResolvedValue({
      lines: ['Docker bridge            1 unverified'],
      issueCount: 1,
      failureCount: 0,
      remediationCommands: [],
    });
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    probeHostPort.mockResolvedValue(true);
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ isCiHub: true, poolProtocol: 2, data: [] }) }),
    );

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod', cliSubcommands: ['status', 'peers', 'discover', 'log', 'enable'] });

    expect(section.issueCount).toBe(1);
    expect(section.failureCount).toBe(0);
    vi.unstubAllGlobals();
  });

  /**
   * `--check-latency` end to end, and the shape of the request it spends GPU time on. `max_tokens: 1`
   * leaves one token to buffer, so the very node that failed in production — the engine buffering a
   * whole completion before the first byte — answers promptly and D3 prints ok.
   */
  it('asks for a completion big enough to show buffering, and only when --check-latency is given', async () => {
    const models = {
      data: [
        { id: 'nomic-embed-text', state: 'pulled', local: true, modality: ['embedding'] },
        { id: 'gemma3:27b', state: 'loaded', local: true, modality: ['text'] },
      ],
    };
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(String(url).includes('/v1/models') ? models : { isCiHub: true, poolProtocol: 2 }),
    }));
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    probeHostPort.mockResolvedValue(true);
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
    vi.stubGlobal('fetch', fetchMock);

    const withoutFlag = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/chat/completions'))).toBe(false);
    expect(text(withoutFlag.lines)).toContain('re-run with --check-latency');

    fetchMock.mockClear();
    await runPoolDoctorSection('.env.prod', { env: 'prod', checkLatency: true });
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).includes('/chat/completions')) as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { model: string; max_tokens: number; stream: boolean };

    expect(body.max_tokens).toBeGreaterThanOrEqual(64);
    expect(body.stream).toBe(false);
    // The embedding model would answer 400 and be reported as a peer-budget failure.
    expect(body.model).toBe('gemma3:27b');
    vi.unstubAllGlobals();
  });

  /**
   * The per-backend breakdown exists to NAME the slow backend. Run in parallel, a shared bottleneck
   * is charged to whichever backend happens to finish last, which is the opposite of naming it —
   * so the loop is sequential on purpose, and nothing drove it.
   */
  it('times each backend on its own, never overlapping them', async () => {
    const inFlight: string[] = [];
    let maxConcurrent = 0;
    const fetchMock = vi.fn(async (url: string) => {
      const backend = /backend=(\w+)/.exec(String(url))?.[1];
      if (backend) {
        inFlight.push(backend);
        maxConcurrent = Math.max(maxConcurrent, inFlight.length);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight.splice(inFlight.indexOf(backend), 1);
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ isCiHub: true, poolProtocol: 2, models: [], data: [] }) };
    });
    readHubApiKey.mockReturnValue('cihub_super_secret_device_key');
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    probeHostPort.mockResolvedValue(true);
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
    vi.stubGlobal('fetch', fetchMock);

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });

    expect(maxConcurrent).toBe(1);
    // All six, in the order the Hub's own fan-out builds them.
    const probed = fetchMock.mock.calls.map(([url]) => /backend=(\w+)/.exec(String(url))?.[1]).filter(Boolean);
    expect(probed).toEqual(['ollama', 'vllm', 'lemonade', 'mtplx', 'dspark', 'lucebox']);
    expect(text(section.lines)).toContain('so the slow one is named, not averaged away');
    vi.unstubAllGlobals();
  });

  /**
   * Fault isolation. Verified by injection before this existed: a throw inside section C reduced the
   * ENTIRE report to `Hub Pool preflight unavailable (...)` with `issueCount: 0` — A and B had
   * already completed and their results were discarded, D never ran, and cli-pool.ts paints an
   * issueCount of 0 as a clean cyan box. The operator loses the diagnosis they ran the command for.
   */
  it('loses only the section that faulted, and never reports the wreck as all-clear', async () => {
    // probeHostPort is section A's first call and is not inside any inner try/catch.
    probeHostPort.mockRejectedValue(new Error('INJECTED FAULT'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const rendered = text(section.lines);

    expect(rendered).toContain('section A could not be collected (INJECTED FAULT)');
    // Every other section still ran and is still in the report.
    for (const id of ['B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'D1', 'D2', 'D3']) expect(rendered).toContain(id);
    expect(rendered).toContain('1 section(s) unavailable');
    // ...and the box cannot come out cyan: cli-pool.ts colours it from this number alone.
    expect(section.issueCount).toBeGreaterThanOrEqual(1);
    vi.unstubAllGlobals();
  });

  it('reports progress as each section lands, so a five-minute run is not a frozen terminal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
    const progress: [string, number][] = [];

    await runPoolDoctorSection('.env.prod', { env: 'prod', onSectionDone: (line, elapsedMs) => progress.push([line, elapsedMs]) });

    expect(progress.map(([line]) => line.trim()[0])).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    // The elapsed clock is what the caller gates printing on, so it has to be real and monotonic.
    const elapsed = progress.map(([, ms]) => ms);
    expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b));
    expect(elapsed[0]).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('degrades to a single line instead of throwing when a probe blows up', async () => {
    // parseEnvFile is reached before any probe, so this stands in for an unexpected internal fault.
    parseEnvFile.mockImplementation(() => {
      throw new Error('kaboom');
    });
    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    expect(section.lines).toHaveLength(1);
    expect(section.lines[0]).toContain('unavailable (kaboom)');
    expect(section.issueCount).toBe(0);
  });

  it('never prints the operator key it used to reach authenticated routes', async () => {
    const secret = 'cihub_super_secret_device_key';
    readHubApiKey.mockReturnValue(secret);
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    probeHostPort.mockResolvedValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ isCiHub: true, poolProtocol: 2, data: [] }) }),
    );
    spawnSync.mockReturnValue({ status: 1, stdout: '' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    expect(text(section.lines)).not.toContain(secret);
    expect(section.remediationCommands.join(' ')).not.toContain(secret);
    // ...and it did authenticate with it.
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const authed = calls.filter(([, init]) => new Headers(init?.headers).get('Authorization') === `Bearer ${secret}`);
    expect(authed.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  /**
   * beta-max end to end: a repo checkout with no `.env.prod`, an appliance install holding the real
   * `.env`, and a Hub container created from the appliance compose. Before this, A1 reported "no
   * configuration to be a pool member with" and A4 passed over `<checkout>/.internal` while the Hub
   * was healthy and serving pool protocol 2.
   */
  /**
   * Mounts the beta-max shape: a real checkout (package.json says ci-hub) whose own `.env.prod` does
   * not exist, an appliance install holding the real `.env`, and a Hub container created from the
   * appliance compose. `envVars` is what that `.env` carries and `containerRoot`/`containerPort` what
   * the container reports, so a test can put them in whatever relationship it needs to discriminate.
   * The port deliberately defaults to something other than DEFAULT_API_PORT: at 5002 a run that had
   * lost the container's value entirely would still probe the right port by luck.
   */
  const applianceEnv = '/data/companion-hub/.env';
  const mountHybridNode = ({
    envVars,
    containerRoot,
    containerPort = 5099,
    composeFile = '/data/companion-hub/docker-compose.prod.yml',
  }: {
    envVars: Record<string, string>;
    containerRoot: string;
    containerPort?: number;
    composeFile?: string;
  }) => {
    const cwd = process.cwd();
    const present = new Set([`${cwd}/package.json`, `${cwd}/scripts`, '/data/companion-hub', composeFile, applianceEnv]);
    existsSync.mockImplementation((target: string) => present.has(String(target)));
    readFileSync.mockImplementation((target: string) => (String(target).endsWith('package.json') ? '{"name":"ci-hub"}' : ''));
    parseEnvFile.mockImplementation((file: string) => (String(file) === applianceEnv ? envVars : {}));
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    resolveHubContainerName.mockReturnValue('ci-os-hub');
    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'docker' && args[0] === 'inspect' && String(args[3]).includes('composeFiles=')) {
        return {
          status: 0,
          stdout: [
            'revision=<no value>',
            'imageCreated=<no value>',
            'service=ci-os-hub',
            `composeFiles=${composeFile}`,
            `env=API_PORT=${containerPort}`,
            `env=ROOT_FOLDER_HOST=${containerRoot}`,
            '',
          ].join('\n'),
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
  };

  it('reads the file the running container was started from, not the checkout it happens to sit in', async () => {
    // The appliance `.env` carries neither value: API_PORT and ROOT_FOLDER_HOST both have to come
    // from the container. And the root it reports is deliberately NOT the directory the compose file
    // sits in, so the env file, the container and the compose-dir default hold three different
    // values and a check that reaches for the wrong one cannot accidentally pass.
    mountHybridNode({ envVars: {}, containerRoot: '/srv/hub-state' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const rendered = text(section.lines);
    const lineFor = (id: string) => rendered.split('\n').find((line) => line.trim().startsWith(id)) ?? '';

    // A1 passes, names the file, and the API_PORT the env file does not carry comes from the container.
    expect(lineFor('A1')).toContain('✓');
    expect(lineFor('A1')).toContain('/data/companion-hub/.env —');
    expect(lineFor('A1')).toContain('API_PORT=5099');
    expect(lineFor('A1')).toContain('ROOT_FOLDER_HOST=/srv/hub-state');
    // ...and the port is not just printed: it is the one the run probes and builds its base URL from.
    expect(probeHostPort).toHaveBeenCalledWith(5099);
    const probed = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([url]) => String(url));
    expect(probed.length).toBeGreaterThan(0);
    expect(probed.every((url) => !url.includes('127.0.0.1:5002'))).toBe(true);
    expect(probed.some((url) => url.includes('127.0.0.1:5099'))).toBe(true);
    expect(rendered).toContain('Read from the running container ci-os-hub');
    expect(rendered).toContain('/data/companion-hub/docker-compose.prod.yml');
    // A4 inspected the tree the Hub actually uses: not `<checkout>/.internal` (what it reported
    // before the fix, because the env file has no ROOT_FOLDER_HOST to read), and not the directory
    // the compose file happens to live in — the container's value is the only one that is right.
    expect(lineFor('A4')).toContain('/srv/hub-state');
    expect(lineFor('A4')).not.toContain('/data/companion-hub');
    expect(rendered).not.toContain('.internal');
    // ...and every other consumer of the env file got the same one. The negative covers section D,
    // which reads the file itself: nothing in the run may still be reaching for the checkout's name.
    expect(readHubApiKey).toHaveBeenCalledWith(applianceEnv);
    expect(runBridgeDoctorSection).toHaveBeenCalledWith(applianceEnv);
    expect(parseEnvFile.mock.calls.map((call: unknown[]) => call[0])).not.toContain('.env.prod');
    expect(rendered).not.toContain('API_PORT was not set');
    vi.unstubAllGlobals();
  });

  /**
   * The mirror of the case above. Here the appliance `.env` does carry a root and it disagrees with
   * the container's. `resolveDataDir` prefers the file, but `defaultRootFolderHost` is derived from
   * the container — so the resolved root and the default diverge, and A4 can only be reading the
   * resolved one. Between the two tests every candidate source is wrong in one of them.
   */
  it('inspects the data root the resolver settled on, not the one the container reports', async () => {
    mountHybridNode({ envVars: { ROOT_FOLDER_HOST: '/mnt/hub-data' }, containerRoot: '/srv/hub-state' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const rendered = text(section.lines);
    const lineFor = (id: string) => rendered.split('\n').find((line) => line.trim().startsWith(id)) ?? '';

    expect(lineFor('A4')).toContain('/mnt/hub-data');
    expect(lineFor('A4')).not.toContain('/srv/hub-state');
    // ...and it says which of the two it took, so an operator staring at a disagreement can tell.
    expect(rendered).toContain(`Data dir from ROOT_FOLDER_HOST in ${applianceEnv}`);
    vi.unstubAllGlobals();
  });

  /**
   * The container is consulted first, but its compose file can sit somewhere that holds no env file
   * at all — a stack directory separate from the data dir. That is not a failure of the container
   * step so much as a fact an operator needs: A1 has to say the container WAS asked and what it
   * could not supply, or the fallback it landed on looks like the only thing that was ever tried.
   */
  it('keeps the reason the container step was skipped in A1, not just the source it fell back to', async () => {
    mountHybridNode({ envVars: {}, containerRoot: '/srv/hub-state', composeFile: '/opt/stack/docker-compose.prod.yml' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const rendered = text(section.lines);

    expect(rendered).toContain('The running container ci-os-hub was created from /opt/stack/docker-compose.prod.yml');
    expect(rendered).toContain('but that directory holds none of');
    vi.unstubAllGlobals();
  });

  /**
   * `cihub pool doctor <typo>` used to print one bare line and exit with no report: on a checkout,
   * `resolveHubContext` reaches `getEnvFileOrExit`, whose `process.exit(2)` no try/catch can stop.
   * The doctor's contract is that it always renders something, so the environment is checked first.
   */
  it('still renders a report when handed an environment name that does not exist', async () => {
    const cwd = process.cwd();
    // A real checkout — the case that reaches getEnvFileOrExit at all. In appliance mode it is
    // never called, so a run that skipped this setup would pass no matter what the code did.
    const present = new Set([`${cwd}/package.json`, `${cwd}/scripts`]);
    existsSync.mockImplementation((target: string) => present.has(String(target)));
    readFileSync.mockImplementation((target: string) => (String(target).endsWith('package.json') ? '{"name":"ci-hub"}' : ''));
    parseEnvFile.mockReturnValue({});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));

    const section = await runPoolDoctorSection('.env.bogus', { env: 'bogus' });

    expect(exit).not.toHaveBeenCalled();
    expect(section.lines.length).toBeGreaterThan(1);
    expect(text(section.lines)).toContain('A1');
    exit.mockRestore();
    vi.unstubAllGlobals();
  });

  it('folds the bridge section in rather than reimplementing it', async () => {
    runBridgeDoctorSection.mockResolvedValue({
      lines: ['Docker bridge            1 blocked'],
      issueCount: 1,
      failureCount: 1,
      remediationCommands: ['sudo ufw allow from 172.18.0.0/16 to 172.18.0.1 port 11434 proto tcp'],
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    spawnSync.mockReturnValue({ status: 1, stdout: '' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    // Section E derives its ports from an env file, so it gets the RESOLVED one — the same file the
    // rest of the run reads. Handed the caller's `.env.prod` on an appliance node it reads nothing
    // and silently probes the default ports instead.
    const resolvedEnvFile = readHubApiKey.mock.calls[0]?.[0];
    expect(resolvedEnvFile).not.toBe('.env.prod');
    expect(runBridgeDoctorSection).toHaveBeenCalledWith(resolvedEnvFile);
    expect(text(section.lines)).toContain('Docker bridge            1 blocked');
    expect(section.remediationCommands).toContain('sudo ufw allow from 172.18.0.0/16 to 172.18.0.1 port 11434 proto tcp');
    expect(section.issueCount).toBeGreaterThanOrEqual(1);
    vi.unstubAllGlobals();
  });
});

describe('readComposeDeclarations — a stack is every file it was created from, not the first one', () => {
  // The real shape on seven of sixteen fleet nodes: prod.yml declares the Hub service build:-only
  // with NO image:, and the dev-image overlay is what supplies one. Reading prod.yml alone compares
  // a container against half the document that made it.
  const PROD = [
    'services:',
    '  ci-hub:',
    '    build: .',
    '    volumes:',
    '      - ./state:/data/state',
    '    environment:',
    '      OLLAMA_URL: http://localhost:11434',
  ].join('\n');
  const OVERLAY = [
    'services:',
    '  ci-hub:',
    '    image: ghcr.io/companionintelligence/ci-hub:dev',
    '    volumes:',
    '      - /var/run/tailscale:/var/run/tailscale',
    '    environment:',
    '      MTPLX_URL: http://localhost:8080',
  ].join('\n');

  beforeEach(() => {
    existsSync.mockReset();
    readFileSync.mockReset();
  });

  it('unions the mounts and variables both files declare', () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockImplementation((file: string) => (String(file).includes('dev-image') ? OVERLAY : PROD));
    const { declaration, reason } = readComposeDeclarations(['/s/docker-compose.prod.yml', '/s/docker-compose.dev-image.yml'], ['ci-hub']);
    expect(reason).toBeNull();
    expect(declaration?.spec.mountTargets).toEqual(['/data/state', '/var/run/tailscale']);
    expect(declaration?.spec.envNames).toEqual(['OLLAMA_URL', 'MTPLX_URL']);
    // Both documents are named, so the operator can see what was actually read.
    expect(declaration?.path).toBe('/s/docker-compose.prod.yml + /s/docker-compose.dev-image.yml');
  });

  it('still answers from the files it could read, and says which one it could not', () => {
    existsSync.mockImplementation((file: string) => !String(file).includes('dev-image'));
    readFileSync.mockReturnValue(PROD);
    const { declaration, reason } = readComposeDeclarations(['/s/docker-compose.prod.yml', '/s/docker-compose.dev-image.yml'], ['ci-hub']);
    expect(declaration?.spec.mountTargets).toEqual(['/data/state']);
    expect(reason).toContain('dev-image');
    expect(reason).toContain('does not exist');
  });

  it('reports every reason when no file yields a declaration', () => {
    existsSync.mockReturnValue(false);
    const { declaration, reason } = readComposeDeclarations(['/s/a.yml', '/s/b.yml'], ['ci-hub']);
    expect(declaration).toBeNull();
    expect(reason).toContain('/s/a.yml');
    expect(reason).toContain('/s/b.yml');
  });

  it('a partial read is surfaced on the check itself, not swallowed', () => {
    const image = { container: 'ci-hub', mountTargets: ['/data/state'], envNames: ['OLLAMA_URL'], service: 'ci-hub', composeFiles: [] };
    const created = { path: '/s/docker-compose.prod.yml', spec: { service: 'ci-hub', mountTargets: ['/data/state'], envNames: ['OLLAMA_URL'] } };
    const check = checkComposeDrift(
      { image, created, createdReason: '/s/docker-compose.dev-image.yml does not exist on this host', repo: null } as never,
      'prod',
    );
    expect(check.verdict).toBe('ok');
    expect(text(check.notes ?? [])).toContain('Only part of the stack was read');
  });
});
