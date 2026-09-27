import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const { HUB_STACK_IMAGE_REPO, resolveApplianceHubImage, seedApplianceInstall } = await import('../lib/seed-appliance');

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

  it('fzzy: does not pin the 0.2.61 image of a desktop package this cihub is not', () => {
    const seeded = seedOn({ desktopPackage: '0.2.61' });

    for (const name of ['.env', '.env.dev']) {
      const body = readFileSync(join(seeded.dataDir, name), 'utf8');
      expect(envLine(body, 'CI_HUB_IMAGE')).toBe(`CI_HUB_IMAGE=${HUB_STACK_IMAGE_REPO}:latest`);
      expect(envLine(body, 'CI_HUB_VERSION')).toBe('CI_HUB_VERSION=latest');
      expect(body).not.toContain('0.2.61');
    }
    expect(seeded.hubImage).toBe(`${HUB_STACK_IMAGE_REPO}:latest`);
  });

  it('fzzy: says which package it did not follow, and how to be rid of it', () => {
    const seeded = seedOn({ desktopPackage: '0.2.61' });

    const said = seeded.warnings.join('\n');
    expect(said).toContain('companion-hub 0.2.61 desktop package');
    expect(said).toContain('this cihub is 0.2.76');
    expect(said).toContain(`${HUB_STACK_IMAGE_REPO}:0.2.61`);
    expect(said).toContain('sudo apt remove companion-hub');
    expect(said).toContain('CI_HUB_IMAGE=<ref>');
  });

  it('core-6: warns that the running 0.2.70 desktop app will rewrite the pin on its next start', () => {
    // Its watchdog started the Hub eight seconds after the seed and re-rendered .env.dev from its own
    // build. Whatever the CLI seeds, a running desktop app puts its own release back.
    const seeded = seedOn({ desktopPackage: '0.2.70', desktopRunning: true });

    const said = seeded.warnings.join('\n');
    expect(seeded.hubImage).toBe(`${HUB_STACK_IMAGE_REPO}:latest`);
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
