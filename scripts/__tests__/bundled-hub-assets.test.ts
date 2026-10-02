import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledHubAssetsModuleIsCurrent } from '../generate-bundled-hub-assets';
import { initTraefik } from '../init-traefik';
import { BUNDLED_HUB_COMPOSE, BUNDLED_TRAEFIK_DYNAMIC_YML, BUNDLED_TRAEFIK_YML } from '../lib/bundled-hub-assets.generated';
import { seedApplianceInstall } from '../lib/seed-appliance';

/**
 * A standalone `cihub` on a headless box has no checkout and no desktop package, so nothing the seed
 * searches for is on disk. On 2026-09-18 that was twelve of fifteen fleet nodes, and `cihub up`
 * stopped at "Install the Companion Hub desktop package". The compose and traefik files are baked into
 * the CLI for that machine; these tests pin that they are current and that they are used.
 */
describe('bundled hub assets', () => {
  it('the generated module matches its sources (run: pnpm exec tsx scripts/generate-bundled-hub-assets.ts)', () => {
    expect(bundledHubAssetsModuleIsCurrent()).toBe(true);
  });

  it('is the pull-only compose an appliance runs, with the current service names', () => {
    expect(BUNDLED_HUB_COMPOSE).toMatch(/^\s+ci-hub-queue:$/m);
    expect(BUNDLED_HUB_COMPOSE).toMatch(/^\s+ci-hub:$/m);
    expect(BUNDLED_HUB_COMPOSE).not.toMatch(/^\s+build:$/m);
    expect(BUNDLED_TRAEFIK_YML).toContain('{{ACME_EMAIL}}');
    expect(BUNDLED_TRAEFIK_DYNAMIC_YML.length).toBeGreaterThan(0);
    // init-traefik writes it as is, before the Hub runs, and Traefik reads it as a Go template: a
    // placeholder in it made Traefik drop the whole file until the Hub booted (Companion-Hub#1832).
    expect(BUNDLED_TRAEFIK_DYNAMIC_YML).not.toContain('{{');
  });
});

describe('seedApplianceInstall on a headless box', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cihub-seed-bare-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('writes the bundled compose when nothing on disk can be found, instead of refusing', () => {
    const result = seedApplianceInstall({ dataDir, postgresPassword: 'operator-secret', findCompose: () => undefined });
    expect(readFileSync(result.composePath, 'utf8')).toBe(BUNDLED_HUB_COMPOSE);
    expect(existsSync(result.envFilePath)).toBe(true);
  });

  it('still prefers a compose that is on disk', () => {
    const result = seedApplianceInstall({ dataDir, postgresPassword: 'operator-secret', findCompose: () => join(dataDir, 'missing.yml') });
    // The search returned a path that does not exist: that is "nothing found", not an operator's choice.
    expect(readFileSync(result.composePath, 'utf8')).toBe(BUNDLED_HUB_COMPOSE);
  });
});

describe('initTraefik on a headless box', () => {
  const cwd = process.cwd();
  let scratch: string;
  let savedRoot: string | undefined;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cihub-traefik-bare-'));
    savedRoot = process.env.ROOT_FOLDER_HOST;
    process.env.ROOT_FOLDER_HOST = scratch;
    process.env.ENV_FILE = join(scratch, 'none.env');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    if (savedRoot === undefined) delete process.env.ROOT_FOLDER_HOST;
    else process.env.ROOT_FOLDER_HOST = savedRoot;
    delete process.env.ENV_FILE;
    rmSync(scratch, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes the bundled traefik.yml and dynamic.yml when no assets are on disk', async () => {
    await initTraefik({ assetsDir: null });
    const dir = join(scratch, 'state', 'traefik');
    expect(readFileSync(join(dir, 'config', 'traefik.yml'), 'utf8')).toBe(BUNDLED_TRAEFIK_YML.replace('{{ACME_EMAIL}}', 'admin@localhost'));
    expect(readFileSync(join(dir, 'dynamic', 'dynamic.yml'), 'utf8')).toBe(BUNDLED_TRAEFIK_DYNAMIC_YML);
    expect(readFileSync(join(dir, 'acme_storage.json'), 'utf8')).toBe('{}');
  });
});
