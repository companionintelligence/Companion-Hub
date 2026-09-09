import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTailscalePersistedStateProbeForTests } from '../lib/cli-compose-env';
import { isApplianceMode, isHubRepoRoot, requireRepoRoot } from '../lib/cli-repo-context';
import { stripAnsi } from '../lib/cli-ui';
import type { PinnedDockerEngine, ReachableEngine } from '../lib/docker-engine';
import {
  applyDockerEnginePin,
  buildComposeBaseArgs,
  composeArgsForContext,
  envOverridesForContext,
  isFirstRun,
  resolveHubContext,
} from '../lib/hub-context';

/**
 * `docker-engine` and `seed-appliance` are the appliance path's two side-effecting collaborators:
 * one pins DOCKER_HOST for every subsequent compose call, the other writes a fresh install to disk.
 * Stubbing them is what makes those branches reachable without a Docker daemon or a TTY password
 * prompt. Every stub value below is deliberately un-producible by the real implementation (TEST-NET-1
 * addresses, a nonexistent image repo), so a stub value surfacing in the output proves it was threaded
 * through rather than defaulted or hardcoded.
 */
const dockerEngine = vi.hoisted(() => ({
  enumerateDockerEngineCandidates: vi.fn(),
  probeReachableEngines: vi.fn(),
  resolveAndPinHubDockerEngine: vi.fn(),
  splitBrainConflict: vi.fn(),
}));
vi.mock('../lib/docker-engine.js', () => dockerEngine);

const seedAppliance = vi.hoisted(() => ({
  resolvePostgresPassword: vi.fn(),
  seedApplianceInstall: vi.fn(),
}));
vi.mock('../lib/seed-appliance.js', () => seedAppliance);

/**
 * These two modules decide whether a lifecycle command drives the repo's compose stack or the
 * packaged appliance install under the canonical data dir. Getting it wrong silently targets the
 * wrong Docker stack, so the fixtures here are real directories on disk rather than an `fs` mock:
 * the detection is a pile of `existsSync` + `JSON.parse` calls, and a mock would only re-state them.
 */

/** The desktop writes both names with identical content; `paths.ts` prefers the platform primary. */
const PRIMARY_ENV_NAME = process.platform === 'win32' ? '.env' : '.env.dev';
const COMPAT_ENV_NAME = process.platform === 'win32' ? '.env.dev' : '.env';

const tempDirs: string[] = [];
let previousCwd = process.cwd();
let previousDataDir: string | undefined;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type CheckoutFixture = {
  /** `null` writes no package.json at all; a string is written verbatim (so malformed JSON is testable). */
  packageJson?: string | null;
  scriptsDir?: boolean;
};

/** A directory shaped like a CI-Hub checkout, with one ingredient varied per test. */
function makeCheckout(fixture: CheckoutFixture = {}): string {
  const packageJson = fixture.packageJson === undefined ? JSON.stringify({ name: 'ci-hub', version: '1.2.3' }) : fixture.packageJson;
  const dir = tempDir('hub-context-repo-');
  if (packageJson !== null) writeFileSync(join(dir, 'package.json'), packageJson, 'utf-8');
  if (fixture.scriptsDir !== false) mkdirSync(join(dir, 'scripts'));
  return dir;
}

/**
 * A cwd that is definitively not a checkout, plus a canonical data dir the CLI should target.
 * `seedCompose`/`seedEnv` seed one half only — an install interrupted between the two writes,
 * which the seeded check has to reject even though the data dir is no longer empty.
 */
function makeApplianceHost(options: { seeded?: boolean; seedCompose?: boolean; seedEnv?: boolean } = {}): { workDir: string; dataDir: string } {
  const workDir = tempDir('hub-context-appliance-cwd-');
  const dataDir = tempDir('hub-context-appliance-data-');
  if (options.seeded || options.seedCompose) writeFileSync(join(dataDir, 'docker-compose.prod.yml'), 'services: {}\n', 'utf-8');
  if (options.seeded || options.seedEnv) writeFileSync(join(dataDir, PRIMARY_ENV_NAME), 'POSTGRES_PASSWORD=seeded\n', 'utf-8');
  process.env.CI_HUB_DATA_DIR = dataDir;
  process.chdir(workDir);
  return { workDir, dataDir };
}

beforeEach(() => {
  previousCwd = process.cwd();
  previousDataDir = process.env.CI_HUB_DATA_DIR;
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousDataDir === undefined) delete process.env.CI_HUB_DATA_DIR;
  else process.env.CI_HUB_DATA_DIR = previousDataDir;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
  // The module mocks are hoisted once for the file, so their call history outlives restoreAllMocks;
  // reset makes each test declare the engine/seed behavior it depends on.
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

// --- checkout detection ---

describe('isHubRepoRoot', () => {
  it('accepts a directory with a ci-hub package.json and a scripts dir', () => {
    expect(isHubRepoRoot(makeCheckout())).toBe(true);
  });

  it('rejects a directory with no package.json', () => {
    expect(isHubRepoRoot(makeCheckout({ packageJson: null }))).toBe(false);
  });

  it('rejects a directory that does not exist at all', () => {
    expect(isHubRepoRoot(join(tmpdir(), 'hub-context-absent-__xyz__'))).toBe(false);
  });

  it('rejects malformed package.json rather than throwing', () => {
    // A half-written package.json during an install would otherwise crash every lifecycle command.
    expect(() => isHubRepoRoot(makeCheckout({ packageJson: '{ "name": "ci-hub"' }))).not.toThrow();
    expect(isHubRepoRoot(makeCheckout({ packageJson: '{ "name": "ci-hub"' }))).toBe(false);
    expect(isHubRepoRoot(makeCheckout({ packageJson: 'not json at all' }))).toBe(false);
  });

  it('rejects a package.json with no name field', () => {
    expect(isHubRepoRoot(makeCheckout({ packageJson: JSON.stringify({ version: '1.0.0' }) }))).toBe(false);
  });

  it('requires the name to be exactly ci-hub, not merely to contain it', () => {
    // A sibling repo (or a fork) sitting beside a scripts/ dir must not be mistaken for the Hub.
    expect(isHubRepoRoot(makeCheckout({ packageJson: JSON.stringify({ name: 'ci-hub-desktop' }) }))).toBe(false);
    expect(isHubRepoRoot(makeCheckout({ packageJson: JSON.stringify({ name: '@companion/ci-hub' }) }))).toBe(false);
    expect(isHubRepoRoot(makeCheckout({ packageJson: JSON.stringify({ name: 'CI-Hub' }) }))).toBe(false);
  });

  it('rejects a ci-hub package.json with no scripts dir beside it', () => {
    // The packaged npm tarball ships package.json but not the helper scripts the commands shell out to.
    expect(isHubRepoRoot(makeCheckout({ scriptsDir: false }))).toBe(false);
  });

  it('defaults to process.cwd() when no directory is passed', () => {
    const checkout = makeCheckout();
    process.chdir(checkout);
    expect(isHubRepoRoot()).toBe(true);

    process.chdir(tempDir('hub-context-not-a-repo-'));
    expect(isHubRepoRoot()).toBe(false);
  });
});

describe('isApplianceMode', () => {
  it('is the exact inverse of isHubRepoRoot for every fixture shape', () => {
    const fixtures: { dir: string; repoRoot: boolean }[] = [
      { dir: makeCheckout(), repoRoot: true },
      { dir: makeCheckout({ packageJson: null }), repoRoot: false },
      { dir: makeCheckout({ packageJson: '{ broken' }), repoRoot: false },
      { dir: makeCheckout({ packageJson: JSON.stringify({ name: 'other' }) }), repoRoot: false },
      { dir: makeCheckout({ scriptsDir: false }), repoRoot: false },
    ];

    for (const { dir, repoRoot } of fixtures) {
      expect(isHubRepoRoot(dir)).toBe(repoRoot);
      expect(isApplianceMode(dir)).toBe(!repoRoot);
    }
  });

  it('defaults to process.cwd() when no directory is passed', () => {
    process.chdir(makeCheckout());
    expect(isApplianceMode()).toBe(false);

    process.chdir(tempDir('hub-context-not-a-repo-'));
    expect(isApplianceMode()).toBe(true);
  });
});

// --- context resolution: checkout mode ---

describe('resolveHubContext in a checkout', () => {
  let checkout: string;

  beforeEach(() => {
    checkout = makeCheckout();
    process.chdir(checkout);
  });

  it('honors the requested env instead of forcing prod', () => {
    expect(resolveHubContext('local').env).toBe('local');
    expect(resolveHubContext('dev').env).toBe('dev');
    expect(resolveHubContext('staging').env).toBe('staging');
    expect(resolveHubContext('prod').env).toBe('prod');
  });

  it('maps each env to its repo-relative env file and compose files', () => {
    expect(resolveHubContext('local')).toMatchObject({
      appliance: false,
      envFile: '.env.local',
      composeFiles: ['docker-compose.local.yml'],
    });
    expect(resolveHubContext('prod')).toMatchObject({
      envFile: '.env.prod',
      composeFiles: ['docker-compose.prod.yml'],
    });
    expect(resolveHubContext('staging')).toMatchObject({
      envFile: '.env.staging',
      // Staging layers its override on top of prod; order matters to Compose.
      composeFiles: ['docker-compose.prod.yml', 'docker-compose.staging.yml'],
    });
  });

  it('keeps every path relative so Compose resolves them against the checkout', () => {
    const ctx = resolveHubContext('staging');
    expect(isAbsolute(ctx.envFile)).toBe(false);
    for (const file of ctx.composeFiles) expect(isAbsolute(file)).toBe(false);
  });

  it('ignores CI_HUB_DATA_DIR while inside a checkout', () => {
    // The desktop app exports CI_HUB_DATA_DIR when it shells out; a developer with that var set
    // must still drive the checkout's stack rather than the installed appliance one.
    const applianceData = tempDir('hub-context-appliance-data-');
    process.env.CI_HUB_DATA_DIR = applianceData;

    const ctx = resolveHubContext('local');

    expect(ctx.cwd).toBe(process.cwd());
    expect(ctx.cwd).not.toBe(applianceData);
    // Lifecycle code branches on dataDir to pin ROOT_FOLDER_HOST/DOCKER_HOST — it must stay unset here.
    expect(ctx.dataDir).toBeUndefined();
    expect(ctx.envFile).toBe('.env.local');
  });

  it('layers the dev-image override only when .env.dev in the cwd pins CI_HUB_IMAGE', () => {
    // Proves the env file is read relative to the checkout rather than from a fixed location.
    expect(resolveHubContext('dev').composeFiles).toEqual(['docker-compose.prod.yml']);

    writeFileSync(join(checkout, '.env.dev'), 'CI_HUB_IMAGE=ghcr.io/companionintelligence/ci-hub:pr-1\n', 'utf-8');
    expect(resolveHubContext('dev').composeFiles).toEqual(['docker-compose.prod.yml', 'docker-compose.dev-image.yml']);

    // The override is keyed on the requested env too: a stale .env.dev left in a developer's
    // checkout must never drag a PR image into `cihub up prod` or `up staging`.
    expect(resolveHubContext('prod').composeFiles).toEqual(['docker-compose.prod.yml']);
    expect(resolveHubContext('staging').composeFiles).toEqual(['docker-compose.prod.yml', 'docker-compose.staging.yml']);
  });

  it('ignores an empty CI_HUB_IMAGE in .env.dev', () => {
    writeFileSync(join(checkout, '.env.dev'), 'CI_HUB_IMAGE=\n', 'utf-8');
    expect(resolveHubContext('dev').composeFiles).toEqual(['docker-compose.prod.yml']);
  });

  it('layers the dev-image override for prod when .env.prod pins CI_HUB_IMAGE', () => {
    // Regression: a fleet node's .env.prod can set CI_HUB_IMAGE just like .env.dev does, and used
    // to be silently ignored by getComposeFiles — `cihub up` would then try (and fail) to build
    // from source instead of pulling the pinned image.
    expect(resolveHubContext('prod').composeFiles).toEqual(['docker-compose.prod.yml']);

    writeFileSync(join(checkout, '.env.prod'), 'CI_HUB_IMAGE=ghcr.io/companionintelligence/ci-hub:dev\n', 'utf-8');
    expect(resolveHubContext('prod').composeFiles).toEqual(['docker-compose.prod.yml', 'docker-compose.dev-image.yml']);

    // Keyed on the requested env's own file — a stale .env.prod must never affect `up dev`/`up staging`.
    expect(resolveHubContext('dev').composeFiles).toEqual(['docker-compose.prod.yml']);
    expect(resolveHubContext('staging').composeFiles).toEqual(['docker-compose.prod.yml', 'docker-compose.staging.yml']);
  });

  it('layers the dev-image override on top of staging when .env.staging pins CI_HUB_IMAGE', () => {
    writeFileSync(join(checkout, '.env.staging'), 'CI_HUB_IMAGE=ghcr.io/companionintelligence/ci-hub:staging\n', 'utf-8');
    expect(resolveHubContext('staging').composeFiles).toEqual([
      'docker-compose.prod.yml',
      'docker-compose.staging.yml',
      'docker-compose.dev-image.yml',
    ]);
  });
});

// --- context resolution: appliance mode ---

describe('resolveHubContext outside a checkout', () => {
  it('forces prod no matter which env the operator asked for', () => {
    makeApplianceHost();
    for (const requested of ['local', 'dev', 'staging', 'prod'] as const) {
      expect(resolveHubContext(requested).env).toBe('prod');
    }
  });

  it('resolves absolute env/compose paths under the canonical data dir', () => {
    const { dataDir } = makeApplianceHost({ seeded: true });
    const ctx = resolveHubContext('local');

    expect(ctx.appliance).toBe(true);
    expect(ctx.dataDir).toBe(dataDir);
    expect(ctx.envFile).toBe(join(dataDir, PRIMARY_ENV_NAME));
    expect(ctx.composeFiles).toEqual([join(dataDir, 'docker-compose.prod.yml')]);
    expect(isAbsolute(ctx.envFile)).toBe(true);
    expect(ctx.composeFiles.every((file) => isAbsolute(file))).toBe(true);
  });

  it('runs Compose from the data dir, not from the operator cwd', () => {
    const { workDir, dataDir } = makeApplianceHost({ seeded: true });
    const ctx = resolveHubContext('prod');

    expect(ctx.cwd).toBe(dataDir);
    expect(ctx.cwd).not.toBe(workDir);
  });

  it('falls back to the compat env file name when only that one was seeded', () => {
    const { dataDir } = makeApplianceHost();
    writeFileSync(join(dataDir, 'docker-compose.prod.yml'), 'services: {}\n', 'utf-8');
    writeFileSync(join(dataDir, COMPAT_ENV_NAME), 'POSTGRES_PASSWORD=compat\n', 'utf-8');

    expect(resolveHubContext('prod').envFile).toBe(join(dataDir, COMPAT_ENV_NAME));
  });

  it('prefers the platform-primary env file when the desktop wrote both', () => {
    const { dataDir } = makeApplianceHost({ seeded: true });
    writeFileSync(join(dataDir, COMPAT_ENV_NAME), 'POSTGRES_PASSWORD=seeded\n', 'utf-8');

    expect(resolveHubContext('prod').envFile).toBe(join(dataDir, PRIMARY_ENV_NAME));
  });

  it('ignores a blank CI_HUB_DATA_DIR instead of resolving paths under it', () => {
    // The desktop exports the override when it shells out; a wrapper that exports it empty must
    // fall back to the canonical dir rather than pointing Compose at a whitespace directory name.
    makeApplianceHost({ seeded: true });
    process.env.CI_HUB_DATA_DIR = '   ';

    const ctx = resolveHubContext('prod');

    expect(isAbsolute(ctx.cwd)).toBe(true);
    expect(ctx.dataDir?.endsWith('companion-hub')).toBe(true);
  });

  it('still names the primary env path when nothing is seeded yet', () => {
    // `up` seeds the install afterwards, so the context must point at where the file will land.
    const { dataDir } = makeApplianceHost();
    expect(resolveHubContext('prod').envFile).toBe(join(dataDir, PRIMARY_ENV_NAME));
  });
});

// --- compose argv ---

describe('buildComposeBaseArgs', () => {
  it('emits the env file, the pinned project name, and one -f per compose file in order', () => {
    expect(buildComposeBaseArgs('.env.staging', ['docker-compose.prod.yml', 'docker-compose.staging.yml'])).toEqual([
      'compose',
      '--env-file',
      '.env.staging',
      '--project-name',
      'ci-hub',
      '-f',
      'docker-compose.prod.yml',
      '-f',
      'docker-compose.staging.yml',
    ]);
  });

  it('places --env-file before --project-name and every -f after both', () => {
    // Compose reads overrides left-to-right; a reordering here would silently change the merged stack.
    const args = buildComposeBaseArgs('.env.local', ['a.yml', 'b.yml']);
    expect(args.indexOf('--env-file')).toBeLessThan(args.indexOf('--project-name'));
    expect(args.indexOf('--project-name')).toBeLessThan(args.indexOf('-f'));
    expect(args.filter((arg) => arg === '-f')).toHaveLength(2);
    expect(args.lastIndexOf('a.yml')).toBeLessThan(args.lastIndexOf('b.yml'));
  });

  it('omits -f entirely when given no compose files', () => {
    expect(buildComposeBaseArgs('.env.local', [])).toEqual(['compose', '--env-file', '.env.local', '--project-name', 'ci-hub']);
  });
});

describe('composeArgsForContext', () => {
  it('builds repo-relative argv inside a checkout', () => {
    process.chdir(makeCheckout());

    expect(composeArgsForContext(resolveHubContext('staging'))).toEqual([
      'compose',
      '--env-file',
      '.env.staging',
      '--project-name',
      'ci-hub',
      '-f',
      'docker-compose.prod.yml',
      '-f',
      'docker-compose.staging.yml',
    ]);
  });

  it('builds absolute data-dir argv in appliance mode', () => {
    const { dataDir } = makeApplianceHost({ seeded: true });

    expect(composeArgsForContext(resolveHubContext('local'))).toEqual([
      'compose',
      '--env-file',
      join(dataDir, PRIMARY_ENV_NAME),
      '--project-name',
      'ci-hub',
      '-f',
      join(dataDir, 'docker-compose.prod.yml'),
    ]);
  });

  it('uses the same project name in both modes so one stack is never orphaned', () => {
    const checkout = makeCheckout();
    process.chdir(checkout);
    const repoArgs = composeArgsForContext(resolveHubContext('prod'));

    const { dataDir } = makeApplianceHost({ seeded: true });
    const applianceArgs = composeArgsForContext(resolveHubContext('prod'));

    expect(repoArgs[repoArgs.indexOf('--project-name') + 1]).toBe('ci-hub');
    expect(applianceArgs[applianceArgs.indexOf('--project-name') + 1]).toBe('ci-hub');
    // Same project, different files: the appliance argv must not reach back into the checkout.
    expect(applianceArgs.join(' ')).toContain(dataDir);
    expect(applianceArgs.join(' ')).not.toContain(checkout);
  });
});

// --- first-run detection ---

describe('isFirstRun', () => {
  it('reports a first run when the env file is absent from the cwd', () => {
    process.chdir(tempDir('hub-context-first-run-'));
    expect(isFirstRun()).toBe(true);
    expect(isFirstRun('.env.prod')).toBe(true);
  });

  it('stops reporting a first run once the env file exists', () => {
    const dir = tempDir('hub-context-first-run-');
    process.chdir(dir);
    writeFileSync(join(dir, '.env.local'), 'X=1\n', 'utf-8');

    expect(isFirstRun()).toBe(false);
    expect(isFirstRun('.env.local')).toBe(false);
  });

  it('checks the named env file, not merely any env file', () => {
    const dir = tempDir('hub-context-first-run-');
    process.chdir(dir);
    writeFileSync(join(dir, '.env.prod'), 'X=1\n', 'utf-8');

    // Both directions matter: the seeded name must stop reporting a first run, and its
    // unseeded siblings must keep reporting one. Asserting only the `true` side lets a
    // by-name shortcut (or a hardcoded default) pass unnoticed.
    expect(isFirstRun('.env.prod')).toBe(false);
    expect(isFirstRun('.env.local')).toBe(true);
    expect(isFirstRun()).toBe(true);
  });

  it('follows the cwd rather than a fixed directory', () => {
    const seeded = tempDir('hub-context-first-run-seeded-');
    writeFileSync(join(seeded, '.env.local'), 'X=1\n', 'utf-8');
    const empty = tempDir('hub-context-first-run-empty-');

    process.chdir(seeded);
    expect(isFirstRun()).toBe(false);

    process.chdir(empty);
    expect(isFirstRun()).toBe(true);
  });
});

// --- guards ---

function spyOnExit() {
  return vi.spyOn(process, 'exit').mockImplementation((): never => {
    throw new Error('process.exit');
  });
}

describe('requireRepoRoot', () => {
  it('returns silently from inside a checkout', () => {
    process.chdir(makeCheckout());
    const exitSpy = spyOnExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => requireRepoRoot('cihub setup')).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('exits 2 with actionable guidance outside a checkout', () => {
    process.chdir(tempDir('hub-context-not-a-repo-'));
    const exitSpy = spyOnExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => requireRepoRoot('cihub setup')).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(2);

    const text = stripAnsi(logSpy.mock.calls.map((call) => String(call[0])).join('\n'));
    expect(text).toContain('Run from a CI-Hub checkout');
    expect(text).toContain('cihub setup runs');
    expect(text).toContain('docker-compose.local.yml');
  });
});

/**
 * `requireRepoOrApplianceContext` dedupes its notice through module-level state, so each test needs
 * a fresh copy of the module rather than a leftover "already told them" flag from the previous one.
 */
async function loadFreshHubContext(): Promise<typeof import('../lib/hub-context')> {
  vi.resetModules();
  return await import('../lib/hub-context');
}

describe('requireRepoOrApplianceContext', () => {
  let exitSpy: ReturnType<typeof spyOnExit>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = spyOnExit();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  const boxText = () => stripAnsi((logSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join('\n'));

  it('allows a checkout without printing an appliance notice', async () => {
    process.chdir(makeCheckout());
    const { requireRepoOrApplianceContext } = await loadFreshHubContext();

    expect(() => requireRepoOrApplianceContext('cihub up')).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('allows a seeded appliance install and names the data dir it will operate on', async () => {
    const { dataDir } = makeApplianceHost({ seeded: true });
    const { requireRepoOrApplianceContext } = await loadFreshHubContext();

    expect(() => requireRepoOrApplianceContext('cihub up')).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(boxText()).toContain('Targeting prod install');
    expect(boxText()).toContain(dataDir);
  });

  it('prints the appliance notice once even when several commands resolve the context', async () => {
    makeApplianceHost({ seeded: true });
    const { requireRepoOrApplianceContext } = await loadFreshHubContext();

    requireRepoOrApplianceContext('cihub down');
    requireRepoOrApplianceContext('cihub down');

    expect(logSpy.mock.calls).toHaveLength(1);
  });

  it('exits 2 with seeding instructions when require-seed finds no install', async () => {
    const { dataDir } = makeApplianceHost();
    const { requireRepoOrApplianceContext } = await loadFreshHubContext();

    expect(() => requireRepoOrApplianceContext('cihub up')).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(2);

    const text = boxText();
    expect(text).toContain('No prod Hub install found');
    expect(text).toContain(`cihub up needs a seeded Hub at ${dataDir}.`);
    expect(text).toContain('cihub up prod');
  });

  it('defaults to the require-seed gate when no gate is passed', async () => {
    makeApplianceHost();
    const { requireRepoOrApplianceContext } = await loadFreshHubContext();

    expect(() => requireRepoOrApplianceContext('cihub setup')).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('lets allow-missing proceed so a broken install can still be torn down', async () => {
    const { dataDir } = makeApplianceHost();
    const { requireRepoOrApplianceContext } = await loadFreshHubContext();

    expect(() => requireRepoOrApplianceContext('cihub reset', 'allow-missing')).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();

    const text = boxText();
    expect(text).toContain('Targeting prod install');
    expect(text).toContain('Proceeding with Docker-level cleanup only.');
    expect(text).toContain(dataDir);
  });

  it('prints the missing-install notice once when allow-missing runs repeatedly', async () => {
    // `cihub down` twice on an unseeded host takes the allow-missing branch, which carries its
    // own dedupe guard rather than going through noteApplianceTarget().
    makeApplianceHost();
    const { requireRepoOrApplianceContext } = await loadFreshHubContext();

    requireRepoOrApplianceContext('cihub reset', 'allow-missing');
    requireRepoOrApplianceContext('cihub reset', 'allow-missing');

    expect(logSpy.mock.calls).toHaveLength(1);
    expect(boxText()).toContain('Proceeding with Docker-level cleanup only.');
  });

  it('exits 2 when the data dir holds a compose file but no env file', async () => {
    // Half-seeded install (the env write never landed). Treating it as seeded would run Compose
    // with a --env-file that does not exist instead of pointing the operator at seeding.
    const { dataDir } = makeApplianceHost({ seedCompose: true });
    const { requireRepoOrApplianceContext } = await loadFreshHubContext();

    expect(() => requireRepoOrApplianceContext('cihub up')).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(boxText()).toContain(`cihub up needs a seeded Hub at ${dataDir}.`);
  });

  it('exits 2 when the data dir holds an env file but no compose file', async () => {
    // The mirror-image half: an env file alone has no stack to drive.
    const { dataDir } = makeApplianceHost({ seedEnv: true });
    const { requireRepoOrApplianceContext } = await loadFreshHubContext();

    expect(() => requireRepoOrApplianceContext('cihub up')).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(boxText()).toContain(`cihub up needs a seeded Hub at ${dataDir}.`);
  });

  it('lets allow-missing tear down a half-seeded install', async () => {
    // The partial install is exactly what the allow-missing gate documents itself as existing for.
    const { dataDir } = makeApplianceHost({ seedCompose: true });
    const { requireRepoOrApplianceContext } = await loadFreshHubContext();

    expect(() => requireRepoOrApplianceContext('cihub reset', 'allow-missing')).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(boxText()).toContain('Proceeding with Docker-level cleanup only.');
    expect(boxText()).toContain(dataDir);
  });

  it('does not warn about a missing install when allow-missing finds a seeded one', async () => {
    makeApplianceHost({ seeded: true });
    const { requireRepoOrApplianceContext } = await loadFreshHubContext();

    requireRepoOrApplianceContext('cihub reset', 'allow-missing');

    expect(boxText()).not.toContain('Docker-level cleanup only');
    expect(boxText()).toContain('Targeting prod install');
  });
});

// --- engine pin + env overrides ---

/** TEST-NET-1/2 hosts: the real resolver only ever yields unix sockets, npipes, or a real context host. */
const WSL_ENGINE: PinnedDockerEngine = {
  dockerHost: 'tcp://192.0.2.77:2375',
  kind: 'wsl-engine',
  contextName: 'wsl-engine',
  reason: 'selected by test fixture',
  selectedAt: 0,
  pathStyle: 'wsl-mnt',
};

const PLAIN_ENGINE: PinnedDockerEngine = {
  dockerHost: 'tcp://198.51.100.4:2375',
  kind: 'system',
  reason: 'selected by test fixture',
  selectedAt: 0,
};

/** Distinct sentinel objects so an assertion can prove which value reached splitBrainConflict. */
const REACHABLE: ReachableEngine[] = [
  { candidate: { label: 'test engine', dockerHost: WSL_ENGINE.dockerHost, kind: 'wsl-engine' }, hasHubIdentity: true, hubHostPorts: [] },
];

function stubEngineResolution(engine: PinnedDockerEngine, conflict: string | null = null): void {
  dockerEngine.enumerateDockerEngineCandidates.mockReturnValue([]);
  dockerEngine.probeReachableEngines.mockReturnValue(REACHABLE);
  dockerEngine.resolveAndPinHubDockerEngine.mockReturnValue(engine);
  dockerEngine.splitBrainConflict.mockReturnValue(conflict);
}

describe('applyDockerEnginePin', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  const boxText = () => stripAnsi((logSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join('\n'));

  it('overlays the resolved DOCKER_HOST, drops a stale DOCKER_CONTEXT, and keeps the caller overrides', () => {
    stubEngineResolution(WSL_ENGINE);

    // A DOCKER_CONTEXT inherited from the operator's shell outranks DOCKER_HOST for the docker CLI,
    // so leaving it in place would send compose to the context's engine and ignore the pin entirely.
    const result = applyDockerEnginePin({ ENV_FILE: '.env.dev', COMPOSE_PROFILES: 'cloudflare', DOCKER_CONTEXT: 'desktop-linux' }, '/data/dir');

    expect(result.DOCKER_HOST).toBe(WSL_ENGINE.dockerHost);
    expect(Object.keys(result)).not.toContain('DOCKER_CONTEXT');
    expect(result.ENV_FILE).toBe('.env.dev');
    expect(result.COMPOSE_PROFILES).toBe('cloudflare');
    expect(result.CI_HUB_DOCKER_PATH_STYLE).toBe('wsl-mnt');
  });

  it('omits CI_HUB_DOCKER_PATH_STYLE when the pinned engine has no path style', () => {
    // Only Windows-side engines carry a bind-mount style; emitting one for a plain socket engine
    // would rewrite every compose bind path on Linux/macOS.
    stubEngineResolution(PLAIN_ENGINE);

    const result = applyDockerEnginePin({ ENV_FILE: '.env.dev' }, '/data/dir');

    expect(result.DOCKER_HOST).toBe(PLAIN_ENGINE.dockerHost);
    expect(Object.keys(result)).not.toContain('CI_HUB_DOCKER_PATH_STYLE');
  });

  it('exits 1 with the conflict text when the Hub stack lives on another engine', () => {
    const conflict = 'Hub stack is on some other engine (tcp://203.0.113.9:2375)';
    stubEngineResolution(WSL_ENGINE, conflict);
    const exitSpy = spyOnExit();

    // The mocked exit throws, and the function's own catch re-reports that throw — so assert on the
    // first exit call and on the conflict box, which only the conflict branch can produce.
    expect(() => applyDockerEnginePin({ ENV_FILE: '.env.dev' }, '/data/dir')).toThrow('process.exit');
    expect(exitSpy.mock.calls[0]).toEqual([1]);
    // Engine problems are exit 1; the seeding gates in this module use 2, and scripts branch on that.
    expect(exitSpy).not.toHaveBeenCalledWith(2);
    expect(boxText()).toContain('Docker engine conflict');
    expect(boxText()).toContain(conflict);
    // The conflict must be judged against the engine that was just pinned, not some other candidate.
    expect(dockerEngine.splitBrainConflict).toHaveBeenCalledWith(WSL_ENGINE, REACHABLE);
  });

  it('exits 1 when engine resolution throws, naming the failure', () => {
    dockerEngine.resolveAndPinHubDockerEngine.mockImplementation(() => {
      throw new Error('no reachable docker engine in test');
    });
    const exitSpy = spyOnExit();

    expect(() => applyDockerEnginePin({ ENV_FILE: '.env.dev' }, '/data/dir')).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(boxText()).toContain('Docker engine selection failed');
    expect(boxText()).toContain('no reachable docker engine in test');
  });
});

describe('envOverridesForContext', () => {
  beforeEach(() => {
    // Otherwise the profile merge shells out to `docker run` to look for persisted Tailscale state.
    setTailscalePersistedStateProbeForTests(() => false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    setTailscalePersistedStateProbeForTests(null);
  });

  it('pins ROOT_FOLDER_HOST and the Docker engine to the data dir in appliance mode', () => {
    stubEngineResolution(WSL_ENGINE);
    const { dataDir } = makeApplianceHost({ seeded: true });

    const overrides = envOverridesForContext(resolveHubContext('prod'));

    // ROOT_FOLDER_HOST is what compose interpolates into every bind mount. Left at the checkout
    // default ('.internal', resolved against cwd) the appliance stack would mount the operator's cwd.
    expect(overrides.ROOT_FOLDER_HOST).toBe(dataDir);
    expect(overrides.ENV_FILE).toBe(join(dataDir, PRIMARY_ENV_NAME));
    expect(overrides.DOCKER_HOST).toBe(WSL_ENGINE.dockerHost);
    // The engine pin is persisted per data dir; pinning against the cwd would write the wrong state file.
    expect(dockerEngine.resolveAndPinHubDockerEngine).toHaveBeenCalledWith({ dataDir });
  });

  it('leaves ROOT_FOLDER_HOST unset in a checkout and never pins a Docker engine', () => {
    // The negative half of the appliance guard: a developer's checkout must keep resolving binds
    // relative to the repo and must not have its DOCKER_HOST rewritten out from under it.
    stubEngineResolution(WSL_ENGINE);
    process.chdir(makeCheckout());

    const overrides = envOverridesForContext(resolveHubContext('local'));

    expect(overrides.ENV_FILE).toBe('.env.local');
    expect(overrides.ROOT_FOLDER_HOST).toBeUndefined();
    expect(overrides.DOCKER_HOST).toBeUndefined();
    expect(overrides.CI_HUB_DOCKER_PATH_STYLE).toBeUndefined();
    expect(dockerEngine.resolveAndPinHubDockerEngine).not.toHaveBeenCalled();
  });
});

// --- interactive seeding ---

/** Values the real seeder cannot produce, so seeing one proves it came from the call under test. */
const SEED_PASSWORD = 'sentinel-pw-8f3a2c';
const SEED_IMAGE = 'ghcr.io/example-invalid/not-a-real-hub:sentinel-42';

describe('ensureApplianceInstall', () => {
  let exitSpy: ReturnType<typeof spyOnExit>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = spyOnExit();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    seedAppliance.resolvePostgresPassword.mockResolvedValue(SEED_PASSWORD);
  });

  const boxText = () => stripAnsi((logSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join('\n'));

  it('never re-seeds an install that already exists', async () => {
    // Re-seeding mints a new POSTGRES_PASSWORD and overwrites the env file, locking the CLI out of
    // the Postgres volume the desktop app already initialized.
    const { dataDir } = makeApplianceHost({ seeded: true });
    const { ensureApplianceInstall } = await loadFreshHubContext();

    await ensureApplianceInstall();

    expect(seedAppliance.seedApplianceInstall).not.toHaveBeenCalled();
    expect(seedAppliance.resolvePostgresPassword).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(boxText()).toContain('Targeting prod install');
    expect(boxText()).toContain(dataDir);
    expect(boxText()).not.toContain('Creating a fresh install');
  });

  it('seeds a fresh install with the resolved password and reports the image', async () => {
    const { dataDir } = makeApplianceHost();
    seedAppliance.seedApplianceInstall.mockReturnValue({
      dataDir,
      envFilePath: join(dataDir, PRIMARY_ENV_NAME),
      composePath: join(dataDir, 'docker-compose.prod.yml'),
      hubImage: SEED_IMAGE,
    });
    const { ensureApplianceInstall } = await loadFreshHubContext();

    await ensureApplianceInstall();

    expect(seedAppliance.seedApplianceInstall).toHaveBeenCalledWith({ dataDir, postgresPassword: SEED_PASSWORD });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(boxText()).toContain(`Creating a fresh install at ${dataDir}`);
    expect(boxText()).toContain('Fresh Hub install created');
    expect(boxText()).toContain(SEED_IMAGE);
  });

  /**
   * The TTY gate decides whether resolvePostgresPassword may prompt. Hardcoding it true makes a
   * non-interactive `cihub up` — CI, or the run the desktop app spawns — block forever on a prompt
   * nobody can answer, which reads as a hung install rather than an error. Both directions are
   * pinned because only asserting the false case would leave `isTty: false` hardcoded, silently
   * turning the interactive path into a "set POSTGRES_PASSWORD" failure for real operators.
   */
  it.each([
    { stdin: false, stdout: false, expected: false, label: 'neither stream is a TTY' },
    { stdin: true, stdout: false, expected: false, label: 'only stdin is a TTY' },
    { stdin: false, stdout: true, expected: false, label: 'only stdout is a TTY' },
    { stdin: true, stdout: true, expected: true, label: 'both streams are TTYs' },
  ])('passes isTty $expected to the password resolver when $label', async ({ stdin, stdout, expected }) => {
    const { dataDir } = makeApplianceHost();
    seedAppliance.seedApplianceInstall.mockReturnValue({
      dataDir,
      envFilePath: join(dataDir, PRIMARY_ENV_NAME),
      composePath: join(dataDir, 'docker-compose.prod.yml'),
      hubImage: SEED_IMAGE,
    });
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdin });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdout });

    try {
      const { ensureApplianceInstall } = await loadFreshHubContext();
      await ensureApplianceInstall();
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    }

    expect(seedAppliance.resolvePostgresPassword).toHaveBeenCalledWith({ env: process.env, isTty: expected });
  });

  it('exits 2 when seeding fails, pointing at the data dir', async () => {
    const { dataDir } = makeApplianceHost();
    seedAppliance.seedApplianceInstall.mockImplementation(() => {
      throw new Error('could not find docker-compose.prod.yml in test');
    });
    const { ensureApplianceInstall } = await loadFreshHubContext();

    await expect(ensureApplianceInstall()).rejects.toThrow('process.exit');
    // 2 is the "operator must act" code the lifecycle gates use; 1 means an engine fault.
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(boxText()).toContain('Could not create Hub install');
    expect(boxText()).toContain('could not find docker-compose.prod.yml in test');
    expect(boxText()).toContain(`Expected prod data at: ${dataDir}`);
  });
});
