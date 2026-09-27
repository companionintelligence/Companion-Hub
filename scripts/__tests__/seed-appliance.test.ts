import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ApplianceImageHost,
  composeResourceCandidates,
  describeHubImageSource,
  describeIgnoredHubResources,
  envPasswordFrom,
  findBundledCompose,
  findTraefikAssets,
  type HubResourceCandidate,
  HUB_STACK_IMAGE_REPO,
  isPublishedReleaseVersion,
  pickHubResource,
  renderApplianceEnvContent,
  resolveApplianceHubImage,
  resolvePostgresPassword,
  seedApplianceInstall,
  traefikAssetsCandidates,
  untrustedHubResourceReason,
  validateSeedPassword,
} from '../lib/seed-appliance';

describe('validateSeedPassword', () => {
  it('rejects empty and short passwords', () => {
    expect(validateSeedPassword('')).toMatch(/required/i);
    expect(validateSeedPassword('short')).toMatch(/at least 8/);
  });

  it('rejects a mismatch when confirm is provided', () => {
    expect(validateSeedPassword('long-enough', 'different')).toMatch(/do not match/i);
  });

  it('accepts a matching password of at least 8 characters', () => {
    expect(validateSeedPassword('long-enough', 'long-enough')).toBeNull();
  });
});

describe('resolvePostgresPassword', () => {
  it('prefers CIHUB_POSTGRES_PASSWORD over POSTGRES_PASSWORD', async () => {
    await expect(
      resolvePostgresPassword({
        env: { CIHUB_POSTGRES_PASSWORD: 'from-cihub', POSTGRES_PASSWORD: 'from-plain' },
        isTty: false,
      }),
    ).resolves.toBe('from-cihub');
  });

  it('falls back to POSTGRES_PASSWORD', async () => {
    await expect(resolvePostgresPassword({ env: { POSTGRES_PASSWORD: 'from-plain' }, isTty: false })).resolves.toBe('from-plain');
  });

  it('prompts twice and returns the confirmed password', async () => {
    const prompt = vi.fn().mockResolvedValueOnce('interactive-pw').mockResolvedValueOnce('interactive-pw');
    await expect(resolvePostgresPassword({ env: {}, isTty: true, prompt })).resolves.toBe('interactive-pw');
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('throws when prompts do not match', async () => {
    const prompt = vi.fn().mockResolvedValueOnce('interactive-pw').mockResolvedValueOnce('nope');
    await expect(resolvePostgresPassword({ env: {}, isTty: true, prompt })).rejects.toThrow(/do not match/i);
  });

  it('tells a non-TTY caller how to supply the password', async () => {
    await expect(resolvePostgresPassword({ env: {}, isTty: false })).rejects.toThrow(/POSTGRES_PASSWORD/);
  });
});

describe('envPasswordFrom', () => {
  it('ignores blank values', () => {
    expect(envPasswordFrom({ POSTGRES_PASSWORD: '   ' })).toBeUndefined();
  });
});

/** A machine with no desktop package: a headless node, or a Mac or CI runner without dpkg. */
const bareHost: ApplianceImageHost = { desktopPackageVersion: () => undefined, desktopAppRunning: () => false, cliVersion: () => '0.2.76' };

describe('resolveApplianceHubImage', () => {
  it('honours CI_HUB_IMAGE', () => {
    expect(resolveApplianceHubImage({ CI_HUB_IMAGE: 'ghcr.io/companionintelligence/ci-hub:0.2.58' }, bareHost)).toEqual({
      image: 'ghcr.io/companionintelligence/ci-hub:0.2.58',
      version: '0.2.58',
      source: 'environment',
      cli: '0.2.76',
      warnings: [],
    });
  });

  it('names a digest pin as a digest, not as the 64 hex characters after the last colon', () => {
    const digest = 'sha256:90f8eda420682b7c2879d50de1b8f589c963deb6b116f1d3536564f8b7bf8166';
    expect(resolveApplianceHubImage({ CI_HUB_IMAGE: `${HUB_STACK_IMAGE_REPO}@${digest}` }, bareHost)).toEqual({
      image: `${HUB_STACK_IMAGE_REPO}@${digest}`,
      version: 'digest-90f8eda42068',
      source: 'environment',
      cli: '0.2.76',
      warnings: [],
    });
  });

  it("pins this cihub's own release when nothing is pinned, not the floating :latest", () => {
    // The compose the seed writes is this release's, and `:latest` would let the image move off it.
    expect(resolveApplianceHubImage({ CI_HUB_IMAGE: undefined }, bareHost)).toEqual({
      image: `${HUB_STACK_IMAGE_REPO}:0.2.76`,
      version: '0.2.76',
      source: 'cli-release',
      cli: '0.2.76',
      warnings: [],
    });
    expect(resolveApplianceHubImage({}, { ...bareHost, cliVersion: () => 'v0.2.76' })).toMatchObject({ image: `${HUB_STACK_IMAGE_REPO}:0.2.76` });
  });

  it('falls back to :latest for a build with no published image of its own, and says it is not this build', () => {
    // The fleet's trial build and a source run. No workflow publishes either one's image.
    for (const cli of ['0.2.76-trial.1c9003d68', '0.0.0-dev', '0.0.0']) {
      const resolved = resolveApplianceHubImage({}, { ...bareHost, cliVersion: () => cli });
      expect(resolved).toMatchObject({ image: `${HUB_STACK_IMAGE_REPO}:latest`, version: 'latest', source: 'default', warnings: [] });
      expect(describeHubImageSource(resolved)).toContain(`is ${cli}, which has no published image`);
    }
  });

  it('pins a desktop package only when it is the same release as this cihub, `v` or not', () => {
    const host = (desktop: string, cli: string): ApplianceImageHost => ({ ...bareHost, desktopPackageVersion: () => desktop, cliVersion: () => cli });
    expect(resolveApplianceHubImage({}, host('0.2.76', 'v0.2.76'))).toMatchObject({
      image: `${HUB_STACK_IMAGE_REPO}:0.2.76`,
      source: 'desktop-package',
    });
    // Newer is not "this cihub" either: it is the desktop app's build, not the one driving this install.
    expect(resolveApplianceHubImage({}, host('0.2.80', '0.2.76'))).toMatchObject({ image: `${HUB_STACK_IMAGE_REPO}:0.2.76`, source: 'cli-release' });
    // A source run reports 0.0.0-dev, which no package is.
    expect(resolveApplianceHubImage({}, host('0.2.76', '0.0.0-dev'))).toMatchObject({ image: `${HUB_STACK_IMAGE_REPO}:latest`, source: 'default' });
  });

  it('warns that an idle older desktop app would replace a pin it does not keep, and not one it keeps', () => {
    // fzzy: the 0.2.61 app is installed but not running. It keeps a newer release tag, so this
    // cihub's own release survives it; `:latest` does not.
    const idle061 = (cli: string): ApplianceImageHost => ({ ...bareHost, desktopPackageVersion: () => '0.2.61', cliVersion: () => cli });
    expect(resolveApplianceHubImage({}, idle061('0.2.76')).warnings.join('\n')).not.toContain('If that desktop app is started');
    const trial = resolveApplianceHubImage({}, idle061('0.2.76-trial.1c9003d68')).warnings.join('\n');
    expect(trial).toContain(`If that desktop app is started, its first Hub start rewrites CI_HUB_IMAGE to ${HUB_STACK_IMAGE_REPO}:0.2.61`);
    expect(trial).toContain('a database the newer Hub may already have migrated');
  });
});

describe('isPublishedReleaseVersion', () => {
  it('accepts a plain release, with or without the v, and nothing the pipeline does not publish', () => {
    expect(isPublishedReleaseVersion('0.2.76')).toBe(true);
    expect(isPublishedReleaseVersion('v0.2.76')).toBe(true);
    expect(isPublishedReleaseVersion('0.2.76-trial.1c9003d68')).toBe(false);
    expect(isPublishedReleaseVersion('0.0.0-dev')).toBe(false);
    expect(isPublishedReleaseVersion('0.0.0')).toBe(false);
    expect(isPublishedReleaseVersion('nightly')).toBe(false);
    expect(isPublishedReleaseVersion('01.2.3')).toBe(false);
  });
});

describe('describeHubImageSource', () => {
  it('says where each kind of pin came from', () => {
    expect(describeHubImageSource({ source: 'environment', version: '0.2.75' })).toBe('set by CI_HUB_IMAGE');
    expect(describeHubImageSource({ source: 'desktop-package', version: '0.2.76' })).toContain('companion-hub 0.2.76 desktop package');
    expect(describeHubImageSource({ source: 'cli-release', version: '0.2.76' })).toBe("this cihub's own release (CI_HUB_IMAGE is not set)");
    expect(describeHubImageSource({ source: 'default', version: 'latest' })).toBe('the public release channel (CI_HUB_IMAGE is not set)');
    expect(describeHubImageSource({ source: 'default', version: 'latest', cli: '0.0.0-dev' })).toContain(
      'the Hub runs the newest release and not this build',
    );
  });
});

describe('untrustedHubResourceReason / pickHubResource', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fileIn(name: string, body = 'services: {}\n'): string {
    const dir = mkdtempSync(join(tmpdir(), 'cihub-resource-'));
    tempDirs.push(dir);
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  }

  const standalone = '/usr/local/bin/cihub';
  const desktopBundled = '/usr/lib/Companion Hub/resources/cihub';

  it('takes a file beside the binary only when the binary is the desktop package’s own cihub', () => {
    const candidate: HubResourceCandidate = { path: '/x/docker-compose.prod.yml', origin: 'beside-binary' };
    expect(untrustedHubResourceReason(candidate, desktopBundled, bareHost)).toBeNull();
    expect(untrustedHubResourceReason(candidate, standalone, bareHost)).toContain('beside a standalone cihub');
    // A source run: execPath is node, and whatever sits in node's directory is not this cihub's.
    expect(untrustedHubResourceReason(candidate, '/usr/local/bin/node', bareHost)).not.toBeNull();
  });

  it("takes a desktop package's file only when the package is this cihub's release", () => {
    const candidate: HubResourceCandidate = { path: '/usr/lib/Companion Hub/resources/docker-compose.prod.yml', origin: 'desktop-package' };
    const withPackage = (desktop: string | undefined): ApplianceImageHost => ({ ...bareHost, desktopPackageVersion: () => desktop });
    expect(untrustedHubResourceReason(candidate, standalone, withPackage('0.2.76'))).toBeNull();
    expect(untrustedHubResourceReason(candidate, standalone, withPackage('0.2.61'))).toBe(
      'it belongs to the companion-hub 0.2.61 desktop package, and this cihub is 0.2.76',
    );
    // Files in the package directory with no dpkg package to vouch for them.
    expect(untrustedHubResourceReason(candidate, standalone, withPackage(undefined))).toContain('no installed companion-hub package');
  });

  it('always takes the checkout this cihub runs from', () => {
    expect(untrustedHubResourceReason({ path: '/src/CI-Hub/x', origin: 'checkout' }, standalone, bareHost)).toBeNull();
  });

  it('passes over untrusted files to the first trusted one, and reports each one it passed', () => {
    const leftover = fileIn('docker-compose.prod.yml');
    const checkout = fileIn('checkout-compose.yml');
    const picked = pickHubResource(
      [
        { path: '/nowhere/docker-compose.prod.yml', origin: 'beside-binary' },
        { path: leftover, origin: 'beside-binary' },
        { path: checkout, origin: 'checkout' },
      ],
      standalone,
      bareHost,
    );
    expect(picked.path).toBe(checkout);
    // A candidate that is not on disk is not "passed over"; only the leftover is.
    expect(picked.ignored.map((entry) => entry.path)).toEqual([leftover]);
    const said = describeIgnoredHubResources(picked, 'compose').join('\n');
    expect(said).toContain(`Did not use ${leftover}`);
    expect(said).toContain(`Used ${checkout} instead.`);
    expect(said).toContain(`sudo rm -r '${leftover}'`);
  });

  it('keeps quiet about a passed-over file that is the same as the baked-in copy', () => {
    const same = fileIn('docker-compose.prod.yml');
    const picked = pickHubResource([{ path: same, origin: 'beside-binary' }], standalone, bareHost, (candidate) => candidate === same);
    expect(picked).toEqual({ ignored: [] });
    expect(describeIgnoredHubResources(picked, 'compose')).toEqual([]);
  });
});

describe('composeResourceCandidates', () => {
  it('includes the desktop Linux resource path and an exec-dir sibling', () => {
    const candidates = composeResourceCandidates('/opt/hub/bin/cihub');
    expect(candidates).toContain('/opt/hub/bin/docker-compose.prod.yml');
    expect(candidates).toContain('/usr/lib/Companion Hub/resources/docker-compose.prod.yml');
  });
});

describe('seedApplianceInstall', () => {
  let dataDir: string;
  let composeSource: string;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('copies compose, writes both env files, and stores the prompted password', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cihub-seed-'));
    composeSource = join(dataDir, 'source-compose.yml');
    writeFileSync(composeSource, 'services: {}\n');

    const result = seedApplianceInstall({
      dataDir,
      postgresPassword: 'operator-secret',
      jwtSecret: 'jwt-secret',
      rabbitmqPassword: 'rabbit-secret',
      hubImage: 'ghcr.io/companionintelligence/ci-hub:0.2.58',
      hubVersion: '0.2.58',
      composeSource,
    });

    expect(result.composePath).toBe(join(dataDir, 'docker-compose.prod.yml'));
    expect(readFileSync(result.composePath, 'utf8')).toBe('services: {}\n');
    expect(existsSync(join(dataDir, 'state'))).toBe(true);
    expect(existsSync(join(dataDir, 'app-data'))).toBe(true);

    const envBody = readFileSync(result.envFilePath, 'utf8');
    expect(envBody).toContain('POSTGRES_PASSWORD=operator-secret');
    expect(envBody).toContain('JWT_SECRET=jwt-secret');
    expect(envBody).toContain('RABBITMQ_PASSWORD=rabbit-secret');
    expect(envBody).toContain('CI_HUB_IMAGE=ghcr.io/companionintelligence/ci-hub:0.2.58');
    expect(envBody).toContain(`ROOT_FOLDER_HOST=${dataDir}`);
    expect(readFileSync(join(dataDir, '.env'), 'utf8')).toBe(envBody);
    expect(readFileSync(join(dataDir, '.env.dev'), 'utf8')).toBe(envBody);
  });

  it('throws when no compose file can be found', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cihub-seed-missing-'));
    expect(() =>
      seedApplianceInstall({
        dataDir,
        postgresPassword: 'operator-secret',
        composeSource: join(dataDir, 'does-not-exist.yml'),
        execPath: join(dataDir, 'no-such-cihub'),
      }),
    ).toThrow(/Could not find docker-compose.prod.yml/);
  });
});

describe('renderApplianceEnvContent', () => {
  it('emits the preserved + derived blocks the desktop seed uses', () => {
    const body = renderApplianceEnvContent({
      dataDir: '/home/ci/.local/share/companion-hub',
      postgresPassword: 'db-pass',
      jwtSecret: 'jwt',
      rabbitmqPassword: 'rq',
      hubImage: `${HUB_STACK_IMAGE_REPO}:latest`,
      hubVersion: 'latest',
    });
    expect(body).toContain('POSTGRES_PASSWORD=db-pass');
    expect(body).toContain('CI_CLOUD_URL=https://hub.ci.computer');
    expect(body).toContain('DOMAIN=companionintelligence.com');
  });
});

describe('findBundledCompose', () => {
  it('returns the compose shipped beside the desktop package’s own cihub', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cihub-compose-'));
    try {
      // The Linux package layout: cihub and the compose are resources of one package.
      const resources = join(dir, 'Companion Hub', 'resources');
      mkdirSync(resources, { recursive: true });
      const compose = join(resources, 'docker-compose.prod.yml');
      writeFileSync(compose, 'services: {}\n');
      expect(findBundledCompose(join(resources, 'cihub'), bareHost)).toBe(compose);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes over a compose beside a standalone cihub, which nothing installs there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cihub-compose-'));
    try {
      mkdirSync(join(dir, 'resources'));
      const compose = join(dir, 'resources', 'docker-compose.prod.yml');
      writeFileSync(compose, 'services: {}\n');
      expect(findBundledCompose(join(dir, 'cihub'), bareHost)).not.toBe(compose);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('traefikAssetsCandidates / findTraefikAssets', () => {
  it('includes the same exec-dir and desktop resource shapes as the compose resolver', () => {
    const candidates = traefikAssetsCandidates('/opt/hub/bin/cihub');
    expect(candidates).toContain('/opt/hub/bin/traefik-assets');
    expect(candidates).toContain('/usr/lib/Companion Hub/resources/traefik-assets');
  });

  it('finds the assets shipped beside the desktop package’s own cihub, with no CI-Hub checkout', () => {
    // Regression: initTraefik() used to resolve this directory as `path.join(process.cwd(),
    // 'packages/backend/assets/traefik')` — correct inside a checkout, but a packaged binary has no
    // such cwd-relative path. It silently warned and skipped traefik.yml, and because it never
    // reached the unconditional acme_storage.json write either, `docker compose up` failed on both
    // missing bind mounts: "invalid mount config for type bind: bind source path does not exist".
    // A standalone binary now gets the copies baked into it (bundled-hub-assets.test.ts).
    const dir = mkdtempSync(join(tmpdir(), 'cihub-traefik-'));
    try {
      const resources = join(dir, 'Companion Hub', 'resources');
      mkdirSync(join(resources, 'traefik-assets'), { recursive: true });
      writeFileSync(join(resources, 'traefik-assets', 'traefik.yml'), 'entryPoints: {}\n');
      expect(findTraefikAssets(join(resources, 'cihub'), bareHost)).toBe(join(resources, 'traefik-assets'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes over a traefik-assets directory left beside a standalone cihub', () => {
    // 16 of 17 fleet nodes, 2026-09-27: a v0.2.70 copy beside /usr/local/bin/cihub since 2026-09-18.
    const dir = mkdtempSync(join(tmpdir(), 'cihub-traefik-'));
    try {
      mkdirSync(join(dir, 'traefik-assets'), { recursive: true });
      writeFileSync(join(dir, 'traefik-assets', 'traefik.yml'), 'entryPoints: {}\n');
      expect(findTraefikAssets(join(dir, 'cihub'), bareHost)).not.toBe(join(dir, 'traefik-assets'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still falls back to cwd-relative packages/backend/assets/traefik inside a checkout', () => {
    // Preserves the original (pre-fix) behavior for the one case it always worked for.
    expect(existsSync(join(process.cwd(), 'packages/backend/assets/traefik', 'traefik.yml'))).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'cihub-traefik-nofile-'));
    try {
      // No exec-dir candidate exists, so this only passes if the cwd fallback still works.
      expect(findTraefikAssets(join(dir, 'cihub'), bareHost)).toBe(join(process.cwd(), 'packages/backend/assets/traefik'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
