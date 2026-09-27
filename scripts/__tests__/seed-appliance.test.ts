import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ApplianceImageHost,
  composeResourceCandidates,
  describeHubImageSource,
  envPasswordFrom,
  findBundledCompose,
  findTraefikAssets,
  HUB_STACK_IMAGE_REPO,
  renderApplianceEnvContent,
  resolveApplianceHubImage,
  resolvePostgresPassword,
  seedApplianceInstall,
  traefikAssetsCandidates,
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

describe('resolveApplianceHubImage', () => {
  /** A machine with no desktop package: a headless node, or a Mac or CI runner without dpkg. */
  const bareHost: ApplianceImageHost = { desktopPackageVersion: () => undefined, desktopAppRunning: () => false, cliVersion: () => '0.2.76' };

  it('honours CI_HUB_IMAGE', () => {
    expect(resolveApplianceHubImage({ CI_HUB_IMAGE: 'ghcr.io/companionintelligence/ci-hub:0.2.58' }, bareHost)).toEqual({
      image: 'ghcr.io/companionintelligence/ci-hub:0.2.58',
      version: '0.2.58',
      source: 'environment',
      warnings: [],
    });
  });

  it('names a digest pin as a digest, not as the 64 hex characters after the last colon', () => {
    const digest = 'sha256:90f8eda420682b7c2879d50de1b8f589c963deb6b116f1d3536564f8b7bf8166';
    expect(resolveApplianceHubImage({ CI_HUB_IMAGE: `${HUB_STACK_IMAGE_REPO}@${digest}` }, bareHost)).toEqual({
      image: `${HUB_STACK_IMAGE_REPO}@${digest}`,
      version: 'digest-90f8eda42068',
      source: 'environment',
      warnings: [],
    });
  });

  it('falls back to the public latest tag when nothing is pinned', () => {
    // Exact now: the host is injected, so the answer no longer depends on the machine running the test.
    expect(resolveApplianceHubImage({ CI_HUB_IMAGE: undefined }, bareHost)).toEqual({
      image: `${HUB_STACK_IMAGE_REPO}:latest`,
      version: 'latest',
      source: 'default',
      warnings: [],
    });
  });

  it('pins a desktop package only when it is the same release as this cihub, `v` or not', () => {
    const host = (desktop: string, cli: string): ApplianceImageHost => ({ ...bareHost, desktopPackageVersion: () => desktop, cliVersion: () => cli });
    expect(resolveApplianceHubImage({}, host('0.2.76', 'v0.2.76'))).toMatchObject({
      image: `${HUB_STACK_IMAGE_REPO}:0.2.76`,
      source: 'desktop-package',
    });
    // Newer is not "this cihub" either: it is the desktop app's build, not the one driving this install.
    expect(resolveApplianceHubImage({}, host('0.2.80', '0.2.76'))).toMatchObject({ image: `${HUB_STACK_IMAGE_REPO}:latest`, source: 'default' });
    // A source run reports 0.0.0-dev, which no package is.
    expect(resolveApplianceHubImage({}, host('0.2.76', '0.0.0-dev'))).toMatchObject({ image: `${HUB_STACK_IMAGE_REPO}:latest`, source: 'default' });
  });
});

describe('describeHubImageSource', () => {
  it('says where each kind of pin came from', () => {
    expect(describeHubImageSource({ source: 'environment', version: '0.2.75' })).toBe('set by CI_HUB_IMAGE');
    expect(describeHubImageSource({ source: 'desktop-package', version: '0.2.76' })).toContain('companion-hub 0.2.76 desktop package');
    expect(describeHubImageSource({ source: 'default', version: 'latest' })).toBe('the public release channel (CI_HUB_IMAGE is not set)');
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
  it('returns the first candidate that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cihub-compose-'));
    try {
      mkdirSync(join(dir, 'resources'));
      const compose = join(dir, 'resources', 'docker-compose.prod.yml');
      writeFileSync(compose, 'services: {}\n');
      expect(findBundledCompose(join(dir, 'cihub'))).toBe(compose);
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

  it('returns the first candidate directory that exists — a headless install with no CI-Hub checkout', () => {
    // Regression: initTraefik() used to resolve this directory as `path.join(process.cwd(),
    // 'packages/backend/assets/traefik')` — correct inside a checkout, but a fresh `cihub up`
    // on a fleet node (packaged binary, no checkout) has no such cwd-relative path. It
    // silently warned and skipped traefik.yml, and because it never reached the unconditional
    // acme_storage.json write either, `docker compose up` failed on both missing bind mounts:
    // "invalid mount config for type bind: bind source path does not exist".
    const dir = mkdtempSync(join(tmpdir(), 'cihub-traefik-'));
    try {
      mkdirSync(join(dir, 'resources', 'traefik-assets'), { recursive: true });
      const traefikYml = join(dir, 'resources', 'traefik-assets', 'traefik.yml');
      writeFileSync(traefikYml, 'entryPoints: {}\n');
      expect(findTraefikAssets(join(dir, 'cihub'))).toBe(join(dir, 'resources', 'traefik-assets'));
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
      expect(findTraefikAssets(join(dir, 'cihub'))).toBe(join(process.cwd(), 'packages/backend/assets/traefik'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
