import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composeResourceCandidates,
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
  it('honours CI_HUB_IMAGE', () => {
    expect(resolveApplianceHubImage({ CI_HUB_IMAGE: 'ghcr.io/companionintelligence/ci-hub:0.2.58' })).toEqual({
      image: 'ghcr.io/companionintelligence/ci-hub:0.2.58',
      version: '0.2.58',
    });
  });

  it('falls back to the public latest tag when nothing is pinned', () => {
    const resolved = resolveApplianceHubImage({ CI_HUB_IMAGE: undefined });
    expect(resolved.image.startsWith(`${HUB_STACK_IMAGE_REPO}:`)).toBe(true);
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
