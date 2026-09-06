import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isApplianceMode, isHubRepoRoot, requireRepoRoot } from '../lib/cli-repo-context';
import { stripAnsi } from '../lib/cli-ui';
import { buildComposeBaseArgs, composeArgsForContext, isFirstRun, resolveHubContext } from '../lib/hub-context';

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
