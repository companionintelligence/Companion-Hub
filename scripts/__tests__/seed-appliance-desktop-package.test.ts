import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 2026-09-26 fleet rebuild, replayed on the seed: `cihub reset --yes`, then `fleet install` ran
 * `cihub up --detached` over SSH with cihub 0.2.76. core-6 came up on ci-hub:0.2.70 and fzzy on
 * ci-hub:0.2.61, neither with the /api/registration/phase route fleet install checks.
 *
 * Both nodes had a CI-Hub checkout in the home directory, and so did fourteen of the other fifteen,
 * which came up on `:latest` — core-2's checkout even pins `:dev` — and fzzy's checkout names no
 * image at all. What only core-6 and fzzy had was a `companion-hub` desktop package, at 0.2.70 and
 * 0.2.61, and the seed pinned `ci-hub:<dpkg version>`. So this suite stubs `dpkg-query` and `pgrep`
 * where the live code calls them, rather than injecting a host: the path under test is the one a
 * real node takes.
 */
const childProcess = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), ...childProcess }));

const { HUB_STACK_IMAGE_REPO, UNUSED_DESKTOP_APP_ADVICE, resolveApplianceHubImage, seedApplianceInstall } = await import('../lib/seed-appliance');

/**
 * A command that uninstalls the desktop package. Its uninstall deletes the Hub's database, every app
 * and `~/.local/share/companion-hub`, which is the Hub the seed has just written (Companion-Hub#1831).
 */
const PACKAGE_REMOVAL =
  /\b(apt(-get)?\s+(remove|purge|autoremove)|dpkg\s+(-r|-P|--remove|--purge)|dnf\s+(remove|erase)|yum\s+(remove|erase)|rpm\s+(-e|--erase)|zypper\s+(rm|remove))\b/;
const { BUNDLED_HUB_COMPOSE } = await import('../lib/bundled-hub-assets.generated');

type NodeFacts = { desktopPackage?: string; desktopRunning?: boolean };

function onNode({ desktopPackage, desktopRunning = false }: NodeFacts): void {
  childProcess.execFileSync.mockImplementation((command: string) => {
    if (command === 'dpkg-query') {
      if (!desktopPackage) throw new Error('dpkg-query: no packages found matching companion-hub');
      return `${desktopPackage}\n`;
    }
    if (command === 'pgrep') {
      if (!desktopRunning) throw new Error('pgrep exited 1');
      return '';
    }
    throw new Error(`unexpected command in test: ${command}`);
  });
}

const envLine = (body: string, key: string) => body.split('\n').find((line) => line.startsWith(`${key}=`));

/** The fleet's trial build: a release-shaped version with a suffix, and no image published for it. */
const TRIAL_BUILD = '0.2.76-trial.1c9003d68';

/**
 * The parts of a pre-#1597 compose that matter here, in the shape v0.2.61 and v0.2.70 shipped: the
 * database and broker published on every interface, and no ci_hub_internal or ci_hub_edge network.
 */
const STALE_COMPOSE = [
  'services:',
  '  ci-hub-db:',
  '    ports:',
  '      - "${POSTGRES_PORT:-6543}:6543"',
  '  ci-hub-queue:',
  '    ports:',
  '      - "${RABBITMQ_PORT:-5001}:5672"',
  '  ci-hub:',
  '    image: ${CI_HUB_IMAGE:-ghcr.io/companionintelligence/ci-hub:latest}',
  '',
].join('\n');

describe('a fresh install on a node with a leftover desktop package', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cihub-seed-node-'));
    // The fleet's standalone binary stamps its release; a source run falls back to this override.
    vi.stubEnv('CIHUB_BUILD_VERSION', '0.2.76');
    vi.stubEnv('CI_HUB_IMAGE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    childProcess.execFileSync.mockReset();
    rmSync(home, { recursive: true, force: true });
  });

  function seedOn(facts: NodeFacts) {
    onNode(facts);
    const dataDir = join(home, '.local', 'share', 'companion-hub');
    return seedApplianceInstall({ dataDir, postgresPassword: 'operator-secret', findCompose: () => undefined });
  }

  it("fzzy: pins this cihub's release, not the 0.2.61 image of a desktop package this cihub is not", () => {
    const seeded = seedOn({ desktopPackage: '0.2.61' });

    for (const name of ['.env', '.env.dev']) {
      const body = readFileSync(join(seeded.dataDir, name), 'utf8');
      expect(envLine(body, 'CI_HUB_IMAGE')).toBe(`CI_HUB_IMAGE=${HUB_STACK_IMAGE_REPO}:0.2.76`);
      expect(envLine(body, 'CI_HUB_VERSION')).toBe('CI_HUB_VERSION=0.2.76');
      expect(body).not.toContain('0.2.61');
    }
    expect(seeded.hubImage).toBe(`${HUB_STACK_IMAGE_REPO}:0.2.76`);
  });

  it('fzzy: says which package it did not follow, and to leave the app closed rather than remove it', () => {
    const seeded = seedOn({ desktopPackage: '0.2.61' });

    const said = seeded.warnings.join('\n');
    expect(said).toContain('companion-hub 0.2.61 desktop package');
    expect(said).toContain('this cihub is 0.2.76');
    expect(said).toContain(`takes neither the package's image (${HUB_STACK_IMAGE_REPO}:0.2.61) nor its compose`);
    expect(said).toContain(UNUSED_DESKTOP_APP_ADVICE);
    expect(said).not.toMatch(PACKAGE_REMOVAL);
    expect(said).toContain('CI_HUB_IMAGE=<ref>');
    // The idle 0.2.61 app keeps a newer release tag, so starting it later does not undo this pin.
    expect(said).not.toContain('If that desktop app is started');
  });

  it('fzzy on a trial build: warns that starting the idle 0.2.61 app would put its own build back', () => {
    // A trial build has no image of its own, so the pin is `:latest`, which every desktop app discards.
    vi.stubEnv('CIHUB_BUILD_VERSION', TRIAL_BUILD);
    const seeded = seedOn({ desktopPackage: '0.2.61' });

    expect(seeded.hubImage).toBe(`${HUB_STACK_IMAGE_REPO}:latest`);
    const said = seeded.warnings.join('\n');
    expect(said).toContain(`If that desktop app is started, its first Hub start rewrites CI_HUB_IMAGE to ${HUB_STACK_IMAGE_REPO}:0.2.61`);
    expect(said).toContain('a database the newer Hub may already have migrated');
  });

  it("core-6: pins this cihub's release, which the running 0.2.70 desktop app keeps on its next start", () => {
    // Its watchdog started the Hub eight seconds after the seed and re-rendered .env.dev from its own
    // build. hub_env.rs carries forward only a release tag newer than its build, so `:latest` was
    // always going to lose, and ci-hub:0.2.76 does not.
    const seeded = seedOn({ desktopPackage: '0.2.70', desktopRunning: true });

    expect(seeded.hubImage).toBe(`${HUB_STACK_IMAGE_REPO}:0.2.76`);
    expect(seeded.warnings.join('\n')).not.toContain('desktop app is running');
  });

  it('core-6 on a trial build: warns that the running 0.2.70 desktop app will rewrite the pin on its next start', () => {
    vi.stubEnv('CIHUB_BUILD_VERSION', TRIAL_BUILD);
    const seeded = seedOn({ desktopPackage: '0.2.70', desktopRunning: true });

    const said = seeded.warnings.join('\n');
    expect(seeded.hubImage).toBe(`${HUB_STACK_IMAGE_REPO}:latest`);
    expect(seeded.hubImageFrom).toContain(`${TRIAL_BUILD}, which has no published image`);
    expect(said).toContain('desktop app is running');
    expect(said).toContain(`rewrites CI_HUB_IMAGE to ${HUB_STACK_IMAGE_REPO}:0.2.70, replacing ${HUB_STACK_IMAGE_REPO}:latest`);
  });

  it('does not read a CI-Hub checkout in the home directory, whatever it pins', () => {
    // core-6's checkout said 0.2.70 in .env.prod, which made the checkout look like the source. It was not.
    mkdirSync(join(home, 'devel', 'CI-Hub', '.internal'), { recursive: true });
    writeFileSync(join(home, 'devel', 'CI-Hub', '.env.prod'), `CI_HUB_IMAGE=${HUB_STACK_IMAGE_REPO}:0.2.49\nCI_HUB_VERSION=0.2.49\n`);
    writeFileSync(join(home, 'devel', 'CI-Hub', '.internal', '.env'), 'CI_HUB_VERSION=0.2.49\n');
    vi.stubEnv('HOME', home);
    const cwd = process.cwd();
    process.chdir(home);
    try {
      const seeded = seedOn({});
      expect(readFileSync(seeded.envFilePath, 'utf8')).not.toContain('0.2.49');
      expect(seeded.warnings).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });
});

/**
 * The compose half of the same seed, with the live search rather than `findCompose`. On 2026-09-27,
 * 16 of 17 fleet nodes had a v0.2.70 `docker-compose.prod.yml` beside /usr/local/bin/cihub, left there
 * by hand on 2026-09-18, and every rebuilt Hub ran on it: no ci_hub_internal or ci_hub_edge network,
 * and on core-2, a pool hub, Postgres 6543 and RabbitMQ 5001 answered from another machine. Only
 * core-3, with nothing beside its binary, got the compose built into cihub.
 */
describe('the compose a fresh install writes on a node with leftovers', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cihub-seed-compose-'));
    vi.stubEnv('CIHUB_BUILD_VERSION', '0.2.76');
    vi.stubEnv('CI_HUB_IMAGE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    childProcess.execFileSync.mockReset();
    rmSync(root, { recursive: true, force: true });
  });

  function expectBundledCompose(composePath: string): void {
    const written = readFileSync(composePath, 'utf8');
    expect(written).toBe(BUNDLED_HUB_COMPOSE);
    expect(written).toContain('ci_hub_internal');
    expect(written).toContain('ci_hub_edge');
    expect(written).toContain('"127.0.0.1:${POSTGRES_PORT:-6543}:6543"');
  }

  it('16 nodes: passes over a stale compose beside /usr/local/bin/cihub and says so', () => {
    onNode({});
    const bin = join(root, 'usr', 'local', 'bin');
    mkdirSync(bin, { recursive: true });
    const leftover = join(bin, 'docker-compose.prod.yml');
    writeFileSync(leftover, STALE_COMPOSE);

    const seeded = seedApplianceInstall({
      dataDir: join(root, 'home', 'ci', '.local', 'share', 'companion-hub'),
      postgresPassword: 'operator-secret',
      execPath: join(bin, 'cihub'),
    });

    expectBundledCompose(seeded.composePath);
    const said = seeded.warnings.join('\n');
    expect(said).toContain(`Did not use ${leftover}: it sits beside a standalone cihub`);
    expect(said).toContain(`sudo rm -r '${leftover}'`);
  });

  it('fzzy: passes over the 0.2.61 desktop package compose, as it passes over the package image', () => {
    // fzzy only escaped it on 2026-09-26 because the v0.2.70 leftover came first. The 0.2.61 compose
    // has no Tailscale mounts, so pool pairing on that Hub could never complete.
    onNode({ desktopPackage: '0.2.61' });
    const resources = join(root, 'usr', 'lib', 'Companion Hub', 'resources');
    mkdirSync(resources, { recursive: true });
    const packaged = join(resources, 'docker-compose.prod.yml');
    writeFileSync(packaged, STALE_COMPOSE);

    const seeded = seedApplianceInstall({
      dataDir: join(root, 'data'),
      postgresPassword: 'operator-secret',
      execPath: join(root, 'usr', 'local', 'bin', 'cihub'),
      composeCandidates: [{ path: packaged, origin: 'desktop-package' }],
    });

    expectBundledCompose(seeded.composePath);
    expect(seeded.hubImage).toBe(`${HUB_STACK_IMAGE_REPO}:0.2.76`);
    expect(seeded.composeFrom).toBe('the compose built into this cihub');
    expect(seeded.warnings.join('\n')).toContain(
      `Did not use ${packaged}: it belongs to the companion-hub 0.2.61 desktop package, and this cihub is 0.2.76.`,
    );
  });

  it("still copies the desktop package's compose when the package is this cihub's release", () => {
    onNode({ desktopPackage: '0.2.76' });
    const resources = join(root, 'usr', 'lib', 'Companion Hub', 'resources');
    mkdirSync(resources, { recursive: true });
    const packaged = join(resources, 'docker-compose.prod.yml');
    writeFileSync(packaged, 'services: {} # the 0.2.76 package\n');

    const seeded = seedApplianceInstall({
      dataDir: join(root, 'data'),
      postgresPassword: 'operator-secret',
      execPath: join(root, 'usr', 'local', 'bin', 'cihub'),
      composeCandidates: [{ path: packaged, origin: 'desktop-package' }],
    });

    expect(readFileSync(seeded.composePath, 'utf8')).toBe('services: {} # the 0.2.76 package\n');
    expect(seeded.composeFrom).toBe(packaged);
    expect(seeded.warnings).toEqual([]);
  });
});

describe('resolveApplianceHubImage — the seeding that is meant to happen', () => {
  beforeEach(() => vi.stubEnv('CIHUB_BUILD_VERSION', '0.2.76'));
  afterEach(() => {
    vi.unstubAllEnvs();
    childProcess.execFileSync.mockReset();
  });

  it('follows the desktop package when it is this cihub, which is how the CLI ships inside it', () => {
    onNode({ desktopPackage: '0.2.76', desktopRunning: true });
    expect(resolveApplianceHubImage({})).toEqual({
      image: `${HUB_STACK_IMAGE_REPO}:0.2.76`,
      version: '0.2.76',
      source: 'desktop-package',
      cli: '0.2.76',
      warnings: [],
    });
  });

  it('lets CI_HUB_IMAGE win over any package, and names the source', () => {
    onNode({ desktopPackage: '0.2.61' });
    const resolved = resolveApplianceHubImage({ CI_HUB_IMAGE: `${HUB_STACK_IMAGE_REPO}:0.2.75` });
    expect(resolved).toMatchObject({ image: `${HUB_STACK_IMAGE_REPO}:0.2.75`, version: '0.2.75', source: 'environment' });
    // The package was not a candidate, so there is nothing to say about ignoring it — and it is not running.
    expect(resolved.warnings).toEqual([]);
  });

  it('stays quiet about a running desktop app that would keep the pin (a newer release tag)', () => {
    onNode({ desktopPackage: '0.2.70', desktopRunning: true });
    const resolved = resolveApplianceHubImage({ CI_HUB_IMAGE: `${HUB_STACK_IMAGE_REPO}:0.2.75` });
    expect(resolved.warnings).toEqual([]);
  });

  it('warns about a running desktop app that would drop a digest pin', () => {
    // The desktop keeps only a release tag of the public repo newer than its build; a digest is not one.
    onNode({ desktopPackage: '0.2.70', desktopRunning: true });
    const digest = `${HUB_STACK_IMAGE_REPO}@sha256:${'f3'.repeat(32)}`;
    const resolved = resolveApplianceHubImage({ CI_HUB_IMAGE: digest });
    expect(resolved.source).toBe('environment');
    expect(resolved.warnings.join('\n')).toContain(`replacing ${digest}`);
  });
});

/**
 * Companion-Hub#1831. The seed writes the desktop's own layout and starts its compose, so the package's
 * uninstall (deb postrm, rpm postun) deletes the Hub it has just set up: the database volume, every app
 * and its data, and ~/.local/share/companion-hub. No message may point an operator at it.
 */
describe('never tells the operator to remove the desktop package', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cihub-seed-removal-'));
    vi.stubEnv('CIHUB_BUILD_VERSION', '0.2.76');
    vi.stubEnv('CI_HUB_IMAGE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    childProcess.execFileSync.mockReset();
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    ['an idle package at another release', { desktopPackage: '0.2.61' }, {}],
    ['a running app at another release', { desktopPackage: '0.2.70', desktopRunning: true }, {}],
    ['an idle package on a trial build', { desktopPackage: '0.2.61' }, { CIHUB_BUILD_VERSION: TRIAL_BUILD }],
    ['a running app on a trial build', { desktopPackage: '0.2.70', desktopRunning: true }, { CIHUB_BUILD_VERSION: TRIAL_BUILD }],
    ['an idle package when CI_CLOUD_URL chose the Portal', { desktopPackage: '0.2.76' }, { CI_CLOUD_URL: 'https://hub.companionintelligence.com' }],
    [
      'a running app when CI_CLOUD_URL chose the Portal',
      { desktopPackage: '0.2.76', desktopRunning: true },
      { CI_CLOUD_URL: 'https://hub.companionintelligence.com' },
    ],
  ] as [string, NodeFacts, Record<string, string>][])('with %s, it says to leave the app closed', (_case, facts, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    onNode(facts);

    const seeded = seedApplianceInstall({
      dataDir: join(home, '.local', 'share', 'companion-hub'),
      postgresPassword: 'operator-secret',
      findCompose: () => undefined,
    });
    const said = seeded.warnings.join('\n');

    expect(said).toContain(UNUSED_DESKTOP_APP_ADVICE);
    expect(said).not.toMatch(PACKAGE_REMOVAL);
  });

  it('has no package removal command anywhere in the CLI', () => {
    const scriptsDir = join(__dirname, '..');
    const sources = [
      ...readdirSync(scriptsDir)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(scriptsDir, name)),
      ...readdirSync(join(scriptsDir, 'lib'))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(scriptsDir, 'lib', name)),
    ];
    const naming = new RegExp(`${PACKAGE_REMOVAL.source}[^\\n]*companion-hub`);

    expect(sources.length).toBeGreaterThan(20);
    for (const source of sources) {
      expect(readFileSync(source, 'utf8'), source).not.toMatch(naming);
    }
  });
});
