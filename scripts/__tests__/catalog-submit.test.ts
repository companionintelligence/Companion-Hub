import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  catalogIdFor,
  imageTag,
  packBundleTarGz,
  prepareSubmitPlan,
  portalOriginFromEnv,
  registryHostFromOrigin,
  loopbackStateMatches,
  resolveSubmitCredentials,
  rewriteComposeImages,
  validateSubmitDir,
  writeStoredLogin,
  readStoredLogin,
  deleteStoredLogin,
  loginFilePath,
  runCatalogLogout,
} from '../lib/catalog-submit';
import { renderHelp, stripAnsi } from '../cihub-cli';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cihub-submit-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'metadata'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ id: 'photos', name: 'Photos', version: '1.0.0' }));
  writeFileSync(
    join(dir, 'docker-compose.json'),
    JSON.stringify({
      services: [
        { name: 'web', image: 'photos:local', isMain: true },
        { name: 'db', image: 'postgres:16' },
      ],
    }),
  );
  writeFileSync(join(dir, 'metadata', 'description.md'), '# Photos');
  writeFileSync(join(dir, 'metadata', 'logo.png'), 'png');
  return dir;
}

describe('catalog id and compose rewrite', () => {
  it('builds {bundle}_{org} ids', () => {
    expect(catalogIdFor('photos', 'acme')).toBe('photos_acme');
  });

  it('rewrites the main service onto the catalog id and extras onto a subpath', () => {
    const rewritten = rewriteComposeImages(
      {
        services: [
          { name: 'web', image: 'photos:dev', isMain: true },
          { name: 'db', image: 'postgres:16' },
        ],
      },
      'photos_acme',
      'hub.ci.computer',
    );

    expect(rewritten.compose.services?.[0]?.image).toBe('hub.ci.computer/photos_acme:dev');
    expect(rewritten.compose.services?.[1]?.image).toBe('hub.ci.computer/photos_acme/db:16');
    expect(imageTag('ghcr.io/example/photos:1.2.3')).toBe('1.2.3');
  });
});

describe('submit credentials', () => {
  it('prefers --token over env over stored login', () => {
    const resolved = resolveSubmitCredentials({
      token: 'cio_flag',
      env: { CI_PORTAL_TOKEN: 'cio_env' },
      stored: { token: 'cio_stored', orgId: 'org_stored', orgSlug: 'acme', portalOrigin: 'https://hub.ci.computer' },
    });
    expect(resolved).toMatchObject({ token: 'cio_flag', orgId: 'org_stored', orgSlug: 'acme' });
  });

  it('returns a login hint when no credential is present', () => {
    const resolved = resolveSubmitCredentials({ env: {}, stored: null });
    expect(resolved).toMatchObject({ error: expect.stringContaining('cihub login') });
  });
});

describe('submit directory', () => {
  it('validates the _template files and prepares a dry-run plan', async () => {
    const dir = fixtureDir();
    const { missing } = validateSubmitDir(dir);
    expect(missing).toEqual([]);

    const plan = await prepareSubmitPlan(dir, 'acme', 'hub.ci.computer');
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.catalogId).toBe('photos_acme');
      expect(plan.rewritten.images[0]?.target).toBe('hub.ci.computer/photos_acme:local');
    }
  });

  it('packs rewritten compose into the tarball', () => {
    const dir = fixtureDir();
    const tarball = packBundleTarGz(dir, JSON.stringify({ services: [{ name: 'web', image: 'hub.ci.computer/photos_acme:local' }] }));
    expect(tarball.byteLength).toBeGreaterThan(100);
    expect(readFileSync(join(dir, 'docker-compose.json'), 'utf8')).toContain('photos:local');
  });
});

describe('submit portal origin', () => {
  it('prefers explicit then env then the stored issuer, and keeps localhost ports', () => {
    expect(portalOriginFromEnv({}, undefined, 'https://stored.example:8787')).toBe('https://stored.example:8787');
    expect(portalOriginFromEnv({ CI_PORTAL_ORIGIN: 'https://env.example' }, undefined, 'https://stored.example:8787')).toBe('https://env.example');
    expect(portalOriginFromEnv({}, 'https://flag.example', 'https://stored.example:8787')).toBe('https://flag.example');
    expect(registryHostFromOrigin('https://localhost:8787')).toBe('localhost:8787');
    expect(registryHostFromOrigin('https://hub.ci.computer')).toBe('hub.ci.computer');
  });

  it('requires the loopback CSRF state to match exactly', () => {
    expect(loopbackStateMatches('abc', 'abc')).toBe(true);
    expect(loopbackStateMatches('abc', 'xyz')).toBe(false);
    expect(loopbackStateMatches(null, 'abc')).toBe(false);
  });
});

describe('stored login file', () => {
  it('writes mode-restricted JSON next to cihub config, not pairing state', () => {
    const home = mkdtempSync(join(tmpdir(), 'cihub-home-'));
    dirs.push(home);
    const filePath = loginFilePath(home);
    expect(filePath).toContain(`${join('.config', 'cihub', 'portal-login.json')}`);
    writeStoredLogin(
      {
        token: 'cio_test',
        tokenId: 'tok_1',
        orgId: 'org_1',
        orgSlug: 'acme',
        portalOrigin: 'https://hub.ci.computer',
      },
      filePath,
    );
    expect(readStoredLogin(filePath)?.token).toBe('cio_test');
    expect(readStoredLogin(filePath)?.tokenId).toBe('tok_1');
    deleteStoredLogin(filePath);
    expect(readStoredLogin(filePath)).toBeNull();
  });

  it('revokes the stored token id on logout, then deletes the file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cihub-home-'));
    dirs.push(home);
    const filePath = loginFilePath(home);
    writeStoredLogin(
      {
        token: 'cio_test',
        tokenId: 'tok_1',
        orgId: 'org_1',
        orgSlug: 'acme',
        portalOrigin: 'https://hub.ci.computer',
      },
      filePath,
    );
    const calls: Array<{ url: string; method?: string; authorization?: string | null }> = [];

    await runCatalogLogout({
      filePath,
      fetchImpl: (async (input, init) => {
        calls.push({
          url: String(input),
          method: typeof init?.method === 'string' ? init.method : undefined,
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch,
    });

    expect(calls).toEqual([
      {
        url: 'https://hub.ci.computer/api/organizations/org_1/developer-tokens/tok_1',
        method: 'DELETE',
        authorization: 'Bearer cio_test',
      },
    ]);
    expect(readStoredLogin(filePath)).toBeNull();
  });

  it('deletes the local file even when Portal revoke fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cihub-home-'));
    dirs.push(home);
    const filePath = loginFilePath(home);
    writeStoredLogin(
      {
        token: 'cio_test',
        tokenId: 'tok_1',
        orgId: 'org_1',
        orgSlug: 'acme',
        portalOrigin: 'https://hub.ci.computer',
      },
      filePath,
    );

    await runCatalogLogout({
      filePath,
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    });

    expect(readStoredLogin(filePath)).toBeNull();
  });
});

describe('help', () => {
  it('documents login and submit instead of catalog publish', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('Catalog publishing');
    expect(plain).toContain('cihub login');
    expect(plain).toContain('cihub submit <dir>');
    expect(plain).toContain('cihub submit --dry-run');
    expect(plain).not.toContain('cihub catalog publish');
  });
});
