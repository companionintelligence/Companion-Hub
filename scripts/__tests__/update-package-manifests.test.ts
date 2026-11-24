/**
 * The Homebrew cask and the Scoop manifest install from dl.ci.computer, so `update-package-manifests.sh` reads each
 * installer's URL and sha256 from the release's manifest.json. It used to hash GitHub release assets instead, and
 * the URLs it wrote answered 404 to anyone outside the org while the Hub repository was private. These tests run the
 * real script against a local HTTP server that plays the CDN, and pin what it writes and when it refuses to.
 */
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const generatorSource = path.join(repoRoot, 'distribution/scripts/update-package-manifests.sh');
const execFileAsync = promisify(execFile);

const hasJq = spawnSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' }).status === 0;

const VERSION = '0.9.9';
const SHA = { intelDmg: 'a'.repeat(64), armDmg: 'b'.repeat(64), exe: 'c'.repeat(64), msi: 'd'.repeat(64) };

type Installer = { url: string; size: number; sha256: string };
type Manifest = { version: string; platforms: Record<string, Record<string, Installer>> };

let server: http.Server;
let base: string;
let root: string;
let workdir: string;

/** What the fake CDN serves. Reset before every test. */
let manifest: Manifest | undefined;
let statusFor: Map<string, number>;
let lengthFor: Map<string, number>;

function releaseManifest(overrides: { exeUrl?: string; omit?: 'exe' | 'intel-dmg'; version?: string } = {}): Manifest {
  const tag = `v${VERSION}`;
  const platforms: Manifest['platforms'] = {
    'darwin-x86_64': {
      dmg: { url: `${base}/${tag}/macos/intel/Companion%20Hub_${VERSION}_x64.dmg`, size: 111, sha256: SHA.intelDmg },
    },
    'darwin-aarch64': {
      dmg: { url: `${base}/${tag}/macos/arm/Companion%20Hub_${VERSION}_aarch64.dmg`, size: 222, sha256: SHA.armDmg },
    },
    'windows-x86_64': {
      msi: { url: `${base}/${tag}/windows/x64/Companion.Hub_${VERSION}_x64_en-US.msi`, size: 444, sha256: SHA.msi },
      exe: {
        url: overrides.exeUrl ?? `${base}/${tag}/windows/x64/Companion.Hub_${VERSION}_x64-setup.exe`,
        size: 333,
        sha256: SHA.exe,
      },
    },
  };
  if (overrides.omit === 'exe') delete platforms['windows-x86_64'].exe;
  if (overrides.omit === 'intel-dmg') delete platforms['darwin-x86_64'];
  return { version: overrides.version ?? VERSION, platforms };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-package-manifests-'));
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === `/v${VERSION}/manifest.json`) {
      if (!manifest) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(manifest));
      return;
    }
    const known = Object.values(manifest?.platforms ?? {})
      .flatMap((formats) => Object.values(formats))
      .find((entry) => new URL(entry.url).pathname === url);
    if (!known) {
      res.writeHead(404).end();
      return;
    }
    // A HEAD response carries the headers of the GET it stands for, content-length included, and no body.
    res.writeHead(statusFor.get(url) ?? 200, { 'content-length': lengthFor.get(url) ?? known.size }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  statusFor = new Map();
  lengthFor = new Map();
  manifest = undefined;
  // The script writes next to itself (distribution/…), so each test runs a copy in its own tree. The two directories
  // it fills are committed in the repo, so they exist here too.
  workdir = fs.mkdtempSync(path.join(root, 'tree-'));
  for (const dir of ['scripts', 'homebrew', 'scoop']) fs.mkdirSync(path.join(workdir, 'distribution', dir), { recursive: true });
  fs.copyFileSync(generatorSource, path.join(workdir, 'distribution/scripts/update-package-manifests.sh'));
});

async function generate(tag: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['distribution/scripts/update-package-manifests.sh', tag], {
      cwd: workdir,
      env: { ...process.env, CI_HUB_DOWNLOAD_BASE: base },
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

const out = (file: string) => path.join(workdir, 'distribution', file);
const read = (file: string) => fs.readFileSync(out(file), 'utf-8');
const GENERATED = ['homebrew/companion-hub.rb', 'scoop/companion-hub.json', 'publish'];
const writtenAnything = () => GENERATED.some((file) => fs.existsSync(out(file)));

describe.skipIf(!hasJq)('update-package-manifests.sh', () => {
  it('writes the CDN URLs and the hashes from manifest.json into the cask and the Scoop manifest', async () => {
    manifest = releaseManifest();
    const result = await generate(`v${VERSION}`);
    expect(result.code, result.output).toBe(0);

    const cask = read('homebrew/companion-hub.rb');
    expect(cask).toContain(`version "${VERSION}"`);
    expect(cask).toContain(`url "${base}/v#{version}/macos/intel/Companion%20Hub_#{version}_x64.dmg"`);
    expect(cask).toContain(`sha256 "${SHA.intelDmg}"`);
    expect(cask).toContain(`url "${base}/v#{version}/macos/arm/Companion%20Hub_#{version}_aarch64.dmg"`);
    expect(cask).toContain(`sha256 "${SHA.armDmg}"`);
    // `brew livecheck` follows the feed that only moves once a release is complete, not GitHub's Latest release.
    expect(cask).toMatch(/livecheck do\n\s+url "[^"]+\/latest\.json"\n\s+strategy :json do \|json\|\n\s+json\["version"\]&\.delete_prefix\("v"\)/);
    expect(cask).toContain(`url "${base}/latest.json"`);

    const scoop = JSON.parse(read('scoop/companion-hub.json'));
    expect(scoop.version).toBe(VERSION);
    expect(scoop.url).toBe(`${base}/v${VERSION}/windows/x64/Companion.Hub_${VERSION}_x64-setup.exe`);
    expect(scoop.hash).toBe(SHA.exe);
    expect(scoop.checkver).toEqual({ url: `${base}/latest.json`, jsonpath: '$.version', regex: 'v?([\\d.]+)' });
    expect(scoop.autoupdate.url).toBe(`${base}/v$version/windows/x64/Companion.Hub_$version_x64-setup.exe`);
    expect(scoop.autoupdate.hash).toEqual({
      url: `${base}/v$version/manifest.json`,
      jsonpath: "$.platforms['windows-x86_64'].exe.sha256",
    });
    // The installer script runs the file Scoop saved, whose name is the last segment of the URL.
    expect(scoop.installer.script).toContain('Companion.Hub_${version}_x64-setup.exe');

    expect(read('publish/homebrew-tap/Casks/companion-hub.rb')).toBe(cask);
    expect(JSON.parse(read('publish/scoop-bucket/companion-hub.json'))).toEqual(scoop);
  });

  it('never points either manifest at GitHub Releases', async () => {
    manifest = releaseManifest();
    expect((await generate(`v${VERSION}`)).code).toBe(0);
    for (const file of ['homebrew/companion-hub.rb', 'scoop/companion-hub.json']) {
      expect(read(file), file).not.toMatch(/github\.com\/[^"\s]+\/releases/);
    }
  });

  it('takes the tag with or without its v', async () => {
    manifest = releaseManifest();
    const result = await generate(VERSION);
    expect(result.code, result.output).toBe(0);
    expect(read('homebrew/companion-hub.rb')).toContain(`version "${VERSION}"`);
  });

  describe('stops before it writes anything when', () => {
    it('the release has no manifest.json yet', async () => {
      const result = await generate(`v${VERSION}`);
      expect(result.code).not.toBe(0);
      expect(writtenAnything()).toBe(false);
    });

    it('manifest.json is for another version', async () => {
      manifest = releaseManifest({ version: '0.9.8' });
      const result = await generate(`v${VERSION}`);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('is for version 0.9.8');
      expect(writtenAnything()).toBe(false);
    });

    it('an installer the manifests need is missing from manifest.json', async () => {
      for (const omit of ['exe', 'intel-dmg'] as const) {
        manifest = releaseManifest({ omit });
        const result = await generate(`v${VERSION}`);
        expect(result.code, omit).not.toBe(0);
        expect(result.output, omit).toMatch(/manifest\.json has no (windows-x86_64 exe|darwin-x86_64 dmg) installer/);
        expect(writtenAnything(), omit).toBe(false);
      }
    });

    it('the uploader changes its file layout, so a version placeholder no longer builds the URL', async () => {
      // The Windows copy used to keep the space in its name; this is what the template would build for it.
      manifest = releaseManifest({ exeUrl: `${base}/v${VERSION}/windows/x64/Companion%20Hub_${VERSION}_x64-setup.exe` });
      const result = await generate(`v${VERSION}`);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('the templates in this script build');
      expect(writtenAnything()).toBe(false);
    });

    it('an installer is not publicly downloadable', async () => {
      manifest = releaseManifest();
      statusFor.set(new URL(manifest.platforms['darwin-aarch64'].dmg.url).pathname, 403);
      const result = await generate(`v${VERSION}`);
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/answered 403, not 200/);
      expect(writtenAnything()).toBe(false);
    });

    it('an installer is not the size manifest.json records', async () => {
      manifest = releaseManifest();
      lengthFor.set(new URL(manifest.platforms['windows-x86_64'].exe.url).pathname, 1);
      const result = await generate(`v${VERSION}`);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('manifest.json says 333');
      expect(writtenAnything()).toBe(false);
    });
  });
});
