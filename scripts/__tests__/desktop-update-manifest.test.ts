/**
 * The desktop update manifest: built from the release artifacts, signed by a key the app pins, and
 * uploaded as it was signed. The app refuses anything else (update_signature.rs), so a slip in any
 * of the three leaves every desktop on its release.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listedKeys, publicKeyHex, signManifest } from '../../.github/scripts/sign-desktop-manifest.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const BUILD = path.join(repoRoot, '.github/scripts/build-desktop-manifest.mjs');
const SIGN = path.join(repoRoot, '.github/scripts/sign-desktop-manifest.mjs');
const UPLOAD = path.join(repoRoot, '.github/scripts/upload-desktop-r2.sh');
const KEYS_FILE = path.join(repoRoot, 'packages/desktop/src-tauri/src/update_signature.rs');
const PREFIX = 'companion-hub desktop update manifest v1\n';

/** An Ed25519 key from a 32-byte seed, as the Rust tests make theirs. */
function seededKey(seedByte: number) {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seedByte)]);
  return crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

function verify(manifest: Buffer, signatureHex: string, publicHex: string) {
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, Buffer.concat([Buffer.from(PREFIX), manifest]), publicKey, Buffer.from(signatureHex, 'hex'));
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-manifest-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeArtifact(relative: string, contents: string) {
  const file = path.join(dir, 'artifacts', relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function buildManifest() {
  const result = spawnSync('node', [BUILD, path.join(dir, 'artifacts'), path.join(dir, 'manifest.json')], {
    env: { ...process.env, RELEASE_TAG: 'v0.3.14', DOWNLOAD_BASE_URL: 'https://dl.ci.computer/', DATE: '2026-11-18T00:00:00Z' },
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return path.join(dir, 'manifest.json');
}

/** update_signature.rs with `key` as the only production key. */
function keysFileListing(publicHex: string) {
  const file = path.join(dir, 'update_signature.rs');
  fs.writeFileSync(
    file,
    `pub(crate) const PRODUCTION_UPDATE_KEYS: &[&str] = &[\n    "${publicHex}",\n];\npub(crate) const DEV_UPDATE_KEYS: &[&str] = &[];\n`,
  );
  return file;
}

function sign(manifest: string, environment: string, keysFile: string, pem: string | undefined) {
  return spawnSync('node', [SIGN, manifest, environment, keysFile], {
    env: { ...process.env, DESKTOP_UPDATE_SIGNING_KEY: pem ?? '' },
    encoding: 'utf8',
  });
}

describe('build-desktop-manifest.mjs', () => {
  it("lists each installer's URL, size and SHA-256, Windows at its space-free name", () => {
    const deb = writeArtifact('release-x86_64-unknown-linux-gnu/Companion Hub_0.3.14_amd64.deb', 'deb bytes');
    const msi = writeArtifact('release-x86_64-pc-windows-msvc/Companion Hub_0.3.14_x64_en-US.msi', 'msi bytes');

    const manifest = JSON.parse(fs.readFileSync(buildManifest(), 'utf8'));

    expect(manifest).toMatchObject({ version: '0.3.14', date: '2026-11-18T00:00:00Z' });
    expect(manifest.platforms['linux-x86_64'].deb).toEqual({
      url: 'https://dl.ci.computer/v0.3.14/linux/deb/x64/Companion%20Hub_0.3.14_amd64.deb',
      size: 9,
      sha256: deb,
    });
    expect(manifest.platforms['windows-x86_64'].msi).toEqual({
      url: 'https://dl.ci.computer/v0.3.14/windows/x64/Companion.Hub_0.3.14_x64_en-US.msi',
      size: 9,
      sha256: msi,
    });
  });
});

describe('sign-desktop-manifest.mjs', () => {
  it('signs with a key update_signature.rs lists, as the app verifies it', () => {
    writeArtifact('release-x86_64-unknown-linux-gnu/hub.deb', 'deb bytes');
    const manifest = buildManifest();
    const key = seededKey(1);
    const publicHex = publicKeyHex(key);

    const result = sign(manifest, 'production', keysFileListing(publicHex), key.export({ format: 'pem', type: 'pkcs8' }).toString());

    expect(result.status, result.stderr).toBe(0);
    const signature = fs.readFileSync(`${manifest}.sig`, 'utf8');
    expect(signature).toMatch(/^[0-9a-f]{128}\n$/);
    expect(verify(fs.readFileSync(manifest), signature.trim(), publicHex)).toBe(true);
  });

  it("refuses a key the environment's list lacks, so a release never ships a manifest its own app refuses", () => {
    writeArtifact('release-x86_64-unknown-linux-gnu/hub.deb', 'deb bytes');
    const manifest = buildManifest();
    const listed = seededKey(1);
    const keysFile = keysFileListing(publicKeyHex(listed));
    const pem = (key: crypto.KeyObject) => key.export({ format: 'pem', type: 'pkcs8' }).toString();

    // Another key, and the production key used for dev.
    for (const [environment, key] of [
      ['production', seededKey(2)],
      ['dev', listed],
    ] as const) {
      const result = sign(manifest, environment, keysFile, pem(key));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is not in');
    }
    expect(fs.existsSync(`${manifest}.sig`)).toBe(false);
  });

  it('refuses to run without a key, or with a key that is not Ed25519', () => {
    writeArtifact('release-x86_64-unknown-linux-gnu/hub.deb', 'deb bytes');
    const manifest = buildManifest();
    const keysFile = keysFileListing(publicKeyHex(seededKey(1)));

    expect(sign(manifest, 'production', keysFile, undefined).stderr).toContain('DESKTOP_UPDATE_SIGNING_KEY is not set');
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ec = sign(manifest, 'production', keysFile, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    expect(ec.status).toBe(1);
    expect(ec.stderr).toContain('must be Ed25519');
  });

  it('makes the signature the Rust tests check (update_signature.rs, matches_the_release_workflow_signer)', () => {
    const key = seededKey(7);
    expect(publicKeyHex(key)).toBe('ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c');
    expect(signManifest(Buffer.from('{"version":"0.3.14","platforms":{}}'), key)).toBe(
      '14247a3a3e967fd14ed154b28a750a59f48f2aa80332a87b17c3751298b220e05038e6c87e358473d94017bc28b088dda8bb1cfc5dc8147af1ca5bc7cf31e60c',
    );
  });

  it('reads both key lists from the real update_signature.rs', () => {
    const source = fs.readFileSync(KEYS_FILE, 'utf8');
    for (const list of ['PRODUCTION_UPDATE_KEYS', 'DEV_UPDATE_KEYS']) {
      expect(listedKeys(source, list)).toHaveLength(1);
    }
  });

  it('reads a list rustfmt has wrapped onto several lines, or with several keys', () => {
    const [a, b] = ['a'.repeat(64), 'B'.repeat(64)];
    const wrapped = `pub(crate) const PRODUCTION_UPDATE_KEYS: &[&str] =\n    &["${a}"];\n`;
    expect(listedKeys(wrapped, 'PRODUCTION_UPDATE_KEYS')).toEqual([a]);
    const several = `pub(crate) const DEV_UPDATE_KEYS: &[&str] = &[\n    "${a}",\n    "${b}",\n];\n`;
    expect(listedKeys(several, 'DEV_UPDATE_KEYS')).toEqual([a, b.toLowerCase()]);
  });
});

describe('upload-desktop-r2.sh', () => {
  const TOKEN = 'cf-test-token-value';
  const TOKEN_ID = '0123456789abcdef0123456789abcdef';

  /**
   * Runs the upload with an `aws` that records what it would put and a `curl` that answers
   * tokens/verify, and returns the R2 paths plus the credentials and endpoint `aws` was handed.
   */
  function upload(env: Record<string, string> = {}, verifyStatus = 'active') {
    const bin = path.join(dir, 'bin');
    const log = path.join(dir, 'aws.log');
    const creds = path.join(dir, 'aws.creds');
    fs.mkdirSync(bin, { recursive: true });
    fs.rmSync(log, { force: true });
    fs.rmSync(creds, { force: true });
    fs.writeFileSync(
      path.join(bin, 'aws'),
      `#!/bin/sh
for a in "$@"; do case "$a" in s3://*) echo "\${a#s3://}" >> "${log}";; esac; done
prev=""; for a in "$@"; do [ "$prev" = "--endpoint-url" ] && ep="$a"; prev="$a"; done
echo "$AWS_ACCESS_KEY_ID $AWS_SECRET_ACCESS_KEY $AWS_DEFAULT_REGION $ep" > "${creds}"
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, 'curl'),
      `#!/bin/sh
case "$*" in *"Bearer ${TOKEN}"*"/accounts/acct123/tokens/verify"*) ;; *) exit 22;; esac
echo '{"success":true,"result":{"id":"${TOKEN_ID}","status":"${verifyStatus}"}}'
`,
      { mode: 0o755 },
    );
    const result = spawnSync('bash', [UPLOAD], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        R2_BUCKET: 'dl-dev',
        DOWNLOAD_BASE_URL: 'https://dl-dev.ci.computer',
        RELEASE_TAG: 'v0.3.14',
        MANIFEST_DIR: dir,
        CLOUDFLARE_API_TOKEN: TOKEN,
        CLOUDFLARE_ACCOUNT_ID: 'acct123',
        R2_ACCESS_KEY_ID: '',
        R2_SECRET_ACCESS_KEY: '',
        ...env,
      },
      encoding: 'utf8',
    });
    const paths = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    const [keyId, secret, region, endpoint] = fs.existsSync(creds) ? fs.readFileSync(creds, 'utf8').trim().split(' ') : [];
    return { result, paths, keyId, secret, region, endpoint };
  }

  it('uploads the signed manifest as it is, its signature before it', () => {
    writeArtifact('release-x86_64-unknown-linux-gnu/hub.deb', 'deb bytes');
    const manifest = buildManifest();
    fs.writeFileSync(`${manifest}.sig`, `${'ab'.repeat(64)}\n`);

    const { result, paths } = upload();

    expect(result.status, result.stderr).toBe(0);
    const signatureAt = paths.indexOf('dl-dev/v0.3.14/manifest.json.sig');
    expect(signatureAt).toBeGreaterThan(-1);
    expect(paths.indexOf('dl-dev/v0.3.14/manifest.json')).toBeGreaterThan(signatureAt);
    expect(paths.at(-1)).toBe('dl-dev/latest.json');
  });

  it('uploads nothing without a signature, or when the manifest names a file not being uploaded', () => {
    writeArtifact('release-x86_64-unknown-linux-gnu/hub.deb', 'deb bytes');
    const manifest = buildManifest();

    const unsigned = upload();
    expect(unsigned.result.status).toBe(1);
    expect(unsigned.result.stdout + unsigned.result.stderr).toContain('unsigned manifest');
    expect(unsigned.paths).toEqual([]);

    fs.writeFileSync(`${manifest}.sig`, `${'ab'.repeat(64)}\n`);
    writeArtifact('release-x86_64-unknown-linux-gnu/hub.deb', 'different bytes');
    const mismatched = upload();
    expect(mismatched.result.status).toBe(1);
    expect(mismatched.result.stderr).toContain('not among the artifacts');
    expect(mismatched.paths).toEqual([]);
  });

  it("writes through R2's S3 endpoint with the token's S3 credentials, its secret masked", () => {
    writeArtifact('release-x86_64-unknown-linux-gnu/hub.deb', 'deb bytes');
    const manifest = buildManifest();
    fs.writeFileSync(`${manifest}.sig`, `${'ab'.repeat(64)}\n`);

    const { result, keyId, secret, region, endpoint } = upload();

    expect(result.status, result.stderr).toBe(0);
    const derived = crypto.createHash('sha256').update(TOKEN).digest('hex');
    expect(keyId).toBe(TOKEN_ID);
    expect(secret).toBe(derived);
    expect(region).toBe('auto');
    expect(endpoint).toBe('https://acct123.r2.cloudflarestorage.com');
    expect(result.stdout).toContain(`::add-mask::${derived}`);
  });

  it('uses R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY as they are when both are set', () => {
    writeArtifact('release-x86_64-unknown-linux-gnu/hub.deb', 'deb bytes');
    const manifest = buildManifest();
    fs.writeFileSync(`${manifest}.sig`, `${'ab'.repeat(64)}\n`);

    const { result, keyId, secret } = upload({
      CLOUDFLARE_API_TOKEN: '',
      R2_ACCESS_KEY_ID: 'explicit-id',
      R2_SECRET_ACCESS_KEY: 'explicit-secret',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(keyId).toBe('explicit-id');
    expect(secret).toBe('explicit-secret');
  });

  it('uploads nothing when Cloudflare rejects the token or reports it inactive', () => {
    writeArtifact('release-x86_64-unknown-linux-gnu/hub.deb', 'deb bytes');
    const manifest = buildManifest();
    fs.writeFileSync(`${manifest}.sig`, `${'ab'.repeat(64)}\n`);

    const rejected = upload({ CLOUDFLARE_API_TOKEN: 'some-other-token' });
    expect(rejected.result.status).toBe(1);
    expect(rejected.result.stdout).toContain('tokens/verify failed');
    expect(rejected.paths).toEqual([]);

    const expired = upload({}, 'expired');
    expect(expired.result.status).toBe(1);
    expect(expired.result.stdout).toContain('not active');
    expect(expired.paths).toEqual([]);
  });
});
