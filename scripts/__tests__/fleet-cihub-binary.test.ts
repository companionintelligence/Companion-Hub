import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assetFormatError,
  assetNameForArch,
  assetNameForPlatform,
  compareCihubVersions,
  downloadReleaseAsset,
  GitHubRequestError,
  installCihubFromStdinScript,
  parseCihubVersionOutput,
  pinCihubReleaseSource,
  releaseFailureFix,
  resolveCihubBinarySource,
} from '../lib/fleet-cihub-binary.js';
import { stdinScriptCommand } from '../lib/fleet-ssh.js';

/**
 * Every case here is a way the first installer got the binary wrong on a real fleet: a node curling
 * the API while the repository was private, an HTML page installed as a binary, an August copy on
 * PATH shadowing a fresh one.
 */
describe('resolveCihubBinarySource', () => {
  it('fetches the public release when there is no token and no file, and sends no token', () => {
    // It used to refuse here with "releases are private", which left a run able only to adopt
    // whatever cihub each node already had.
    const source = resolveCihubBinarySource({ env: {} });
    expect(source).toEqual({ kind: 'release', version: 'latest' });
    expect(resolveCihubBinarySource({ env: { GH_TOKEN: '  ' }, version: '0.3.6' })).toEqual({ kind: 'release', version: '0.3.6' });
  });

  it('uses the operator machine token, not the node, and accepts either env name', () => {
    expect(resolveCihubBinarySource({ env: { GH_TOKEN: 'ghp_x' } })).toMatchObject({ kind: 'release', token: 'ghp_x', version: 'latest' });
    expect(resolveCihubBinarySource({ env: { GITHUB_TOKEN: 'ghp_y' }, version: 'v0.2.72' })).toMatchObject({
      kind: 'release',
      token: 'ghp_y',
      version: 'v0.2.72',
    });
  });

  it('takes a named file over a token, and reads its version when it can', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cihub-bin-'));
    try {
      const file = join(dir, 'cihub-linux-x64');
      writeFileSync(file, 'x');
      const source = resolveCihubBinarySource({ binaryPath: file, env: { GH_TOKEN: 'ghp_x' }, readVersion: () => '0.2.72' });
      expect(source).toMatchObject({ kind: 'local', path: file, version: '0.2.72' });
      expect(resolveCihubBinarySource({ binaryPath: join(dir, 'missing'), env: {} }).kind).toBe('unavailable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets --cihub-version name a file that will not run here, but never lets `latest` stand in for a version', () => {
    // An arm64 asset on an x64 operator machine has a version; the operator can say what it is.
    const dir = mkdtempSync(join(tmpdir(), 'cihub-bin-'));
    try {
      const file = join(dir, 'cihub-linux-arm64');
      writeFileSync(file, 'x');
      const unreadable = () => undefined;
      expect(resolveCihubBinarySource({ binaryPath: file, env: {}, readVersion: unreadable, version: '0.2.72' })).toMatchObject({
        version: '0.2.72',
      });
      const fromLatest = resolveCihubBinarySource({ binaryPath: file, env: {}, readVersion: unreadable, version: 'latest' });
      expect(fromLatest.kind).toBe('local');
      expect(fromLatest.kind === 'local' && fromLatest.version).toBeUndefined();
      // The file's own answer wins over the flag.
      expect(resolveCihubBinarySource({ binaryPath: file, env: {}, readVersion: () => '0.2.80', version: '0.2.72' })).toMatchObject({
        version: '0.2.80',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pinCihubReleaseSource', () => {
  /**
   * `latest` is what the flag says, not a version. Handed to the adopt-or-replace decision on each
   * node it could only ever adopt: on 2026-09-20 a July 0.2.36 in ~/.local/bin was kept, with a
   * current release in hand, and its `cihub up` did not know the headless seed path.
   */
  const release = (tag: string) =>
    vi.fn(async (url: string | URL) => {
      expect(String(url)).toMatch(/\/releases\/(latest|tags\/v0\.2\.72)$/);
      return new Response(JSON.stringify({ tag_name: tag, assets: [] }), { status: 200 });
    }) as unknown as typeof fetch;

  it('turns `latest` into the tag GitHub names right now, and remembers it was `latest`', async () => {
    const pinned = await pinCihubReleaseSource({ kind: 'release', token: 'ghp_x', version: 'latest' }, release('v0.2.72'));
    expect(pinned).toEqual({ kind: 'release', token: 'ghp_x', version: 'v0.2.72', resolvedFrom: 'latest' });
  });

  it('keeps an explicit tag as the tag, once GitHub has confirmed it exists', async () => {
    const pinned = await pinCihubReleaseSource({ kind: 'release', token: 'ghp_x', version: '0.2.72' }, release('v0.2.72'));
    expect(pinned).toEqual({ kind: 'release', token: 'ghp_x', version: 'v0.2.72' });
  });

  it('makes a lookup that fails into "nothing to install", with the fix, before any node is dialled', async () => {
    const missing = vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch;
    const pinned = await pinCihubReleaseSource({ kind: 'release', version: '9.9.9' }, missing);
    expect(pinned.kind).toBe('unavailable');
    if (pinned.kind === 'unavailable') {
      expect(pinned.why).toMatch(/HTTP 404/);
      expect(pinned.why).toMatch(/no release with that tag/);
      expect(pinned.why).not.toMatch(/private/);
      expect(pinned.fix.join(' ')).toMatch(/--cihub-binary/);
    }
  });

  it('pins without a token and sends no Authorization header', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ tag_name: 'v0.3.6', assets: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const pinned = await pinCihubReleaseSource({ kind: 'release', version: 'latest' }, fetchImpl);
    expect(pinned).toEqual({ kind: 'release', version: 'v0.3.6', resolvedFrom: 'latest' });
    expect(seen[0]).not.toHaveProperty('Authorization');
  });

  it('says when GitHub refused the token that was set', async () => {
    const refused = vi.fn(async () => new Response('{"message":"Bad credentials"}', { status: 401 })) as unknown as typeof fetch;
    const pinned = await pinCihubReleaseSource({ kind: 'release', token: 'ghp_bad', version: 'latest' }, refused);
    expect(pinned.kind === 'unavailable' && pinned.why).toMatch(/HTTP 401.*refused the token in GH_TOKEN or GITHUB_TOKEN/);
  });

  it('leaves a local file and an unavailable source alone, and touches no network for them', async () => {
    const never = vi.fn() as unknown as typeof fetch;
    const local = { kind: 'local' as const, path: '/tmp/cihub', version: '0.2.72' };
    expect(await pinCihubReleaseSource(local, never)).toBe(local);
    const unavailable = { kind: 'unavailable' as const, why: 'no token', fix: [] };
    expect(await pinCihubReleaseSource(unavailable, never)).toBe(unavailable);
    expect(never).not.toHaveBeenCalled();
  });
});

describe('version parsing and ordering', () => {
  it('finds the version line even when a notice is printed first', () => {
    expect(parseCihubVersionOutput('sync-rabbitmq-password: no RABBITMQ_PASSWORD set, skipping\ncihub 0.2.72')).toBe('0.2.72');
    expect(parseCihubVersionOutput('nothing here')).toBeUndefined();
  });

  it('orders x.y.z numerically, with or without a v', () => {
    expect(compareCihubVersions('0.2.55', 'v0.2.72')).toBeLessThan(0);
    expect(compareCihubVersions('0.2.72', '0.2.72')).toBe(0);
    expect(compareCihubVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
  });

  it('maps host architectures to the two assets the release ships', () => {
    expect(assetNameForArch('x86_64')).toBe('cihub-linux-x64');
    expect(assetNameForArch('aarch64')).toBe('cihub-linux-arm64');
    expect(assetNameForArch('riscv64')).toBeUndefined();
  });
});

/**
 * `assetNameForArch` answers "which asset does this fleet NODE take", and a node is Linux.
 * `cihub self-update` asks about the machine it is running on, which is as often the operator's Mac.
 */
describe('assetNameForPlatform', () => {
  it('covers every platform the release workflow publishes, under both arch spellings', () => {
    expect(assetNameForPlatform('linux', 'x64')).toBe('cihub-linux-x64');
    expect(assetNameForPlatform('linux', 'aarch64')).toBe('cihub-linux-arm64');
    expect(assetNameForPlatform('darwin', 'arm64')).toBe('cihub-macos-arm64');
    expect(assetNameForPlatform('darwin', 'x86_64')).toBe('cihub-macos-x64');
    expect(assetNameForPlatform('win32', 'x64')).toBe('cihub-windows-x64.exe');
  });

  it('has no answer for a platform or arch the release does not build', () => {
    expect(assetNameForPlatform('freebsd', 'x64')).toBeUndefined();
    expect(assetNameForPlatform('linux', 'riscv64')).toBeUndefined();
  });
});

describe('assetFormatError', () => {
  const html = Buffer.from('<html>Not Found</html>');
  const elf = Buffer.concat([Buffer.from('\x7fELF', 'latin1'), Buffer.alloc(16, 1)]);
  const machO = Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.alloc(16, 1)]);
  const pe = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(16, 1)]);

  it('holds every platform asset to its own magic, not just ELF', () => {
    expect(assetFormatError('cihub-linux-x64', elf)).toBeUndefined();
    expect(assetFormatError('cihub-macos-arm64', machO)).toBeUndefined();
    expect(assetFormatError('cihub-windows-x64.exe', pe)).toBeUndefined();
  });

  it('refuses an API error page served with a 200 under any asset name', () => {
    // The failure this check exists for: a private-repo error renamed to the asset and installed.
    expect(assetFormatError('cihub-linux-x64', html)).toMatch(/not an ELF binary/);
    expect(assetFormatError('cihub-macos-arm64', html)).toMatch(/not a Mach-O binary/);
    expect(assetFormatError('cihub-windows-x64.exe', html)).toMatch(/not a Windows executable/);
  });

  it('does not reject an asset whose platform it cannot tell from the name', () => {
    expect(assetFormatError('some-other-asset', html)).toBeUndefined();
  });
});

describe('downloadReleaseAsset', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fakeFetch(bytes: Buffer) {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer ghp_x');
      if (String(url).endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({ tag_name: 'v0.2.72', assets: [{ name: 'cihub-linux-x64', url: 'https://api.github.com/repos/x/y/releases/assets/1' }] }),
          { status: 200 },
        );
      }
      // The asset bytes are only served for octet-stream — the browser URL 404s on a private repo.
      expect(headers.Accept).toBe('application/octet-stream');
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('fetches with the token on the operator machine and caches by tag and asset', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'cihub-cache-'));
    dirs.push(cacheDir);
    const elf = Buffer.concat([Buffer.from('\x7fELF', 'latin1'), Buffer.alloc(64, 1)]);
    const fetchImpl = fakeFetch(elf);
    const first = await downloadReleaseAsset({ token: 'ghp_x', assetName: 'cihub-linux-x64', version: 'latest', cacheDir, fetchImpl });
    expect(first.tag).toBe('v0.2.72');
    expect(first.path).toBe(join(cacheDir, 'v0.2.72-cihub-linux-x64'));
    const second = await downloadReleaseAsset({ token: 'ghp_x', assetName: 'cihub-linux-x64', version: 'latest', cacheDir, fetchImpl });
    expect(second.sha256).toBe(first.sha256);
    // release lookup twice, asset bytes once
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('refuses an HTML page renamed to a binary', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'cihub-cache-'));
    dirs.push(cacheDir);
    await expect(
      downloadReleaseAsset({
        token: 'ghp_x',
        assetName: 'cihub-linux-x64',
        version: 'latest',
        cacheDir,
        fetchImpl: fakeFetch(Buffer.from('<html>Not Found</html>')),
      }),
    ).rejects.toThrow(/not an ELF binary/);
  });

  it('says a 404 release lookup means no such tag, not a private repository', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch;
    await expect(downloadReleaseAsset({ token: 'ghp_x', assetName: 'cihub-linux-x64', version: '9.9.9', fetchImpl })).rejects.toThrow(
      /HTTP 404 .*no release with that tag$/,
    );
  });

  it('does not name a tag when `latest` answers 404', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch;
    await expect(downloadReleaseAsset({ assetName: 'cihub-linux-x64', version: 'latest', fetchImpl })).rejects.toThrow(
      /HTTP 404 .*no published release to call latest$/,
    );
  });

  it('downloads without a token and sends no Authorization header: the repository is public', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'cihub-cache-'));
    dirs.push(cacheDir);
    const elf = Buffer.concat([Buffer.from('\x7fELF', 'latin1'), Buffer.alloc(64, 1)]);
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      if (String(url).endsWith('/releases/tags/v0.3.6')) {
        return new Response(
          JSON.stringify({ tag_name: 'v0.3.6', assets: [{ name: 'cihub-linux-x64', url: 'https://api.github.com/repos/x/y/releases/assets/1' }] }),
          { status: 200 },
        );
      }
      return new Response(elf, { status: 200 });
    }) as unknown as typeof fetch;

    const asset = await downloadReleaseAsset({ assetName: 'cihub-linux-x64', version: '0.3.6', cacheDir, fetchImpl });

    expect(asset.tag).toBe('v0.3.6');
    expect(seen).toHaveLength(2);
    for (const headers of seen) expect(headers).not.toHaveProperty('Authorization');
  });

  it('points at a token when GitHub rate-limits a lookup made without one', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"message":"API rate limit exceeded"}', { status: 403 })) as unknown as typeof fetch;
    await expect(downloadReleaseAsset({ assetName: 'cihub-linux-x64', version: 'latest', fetchImpl })).rejects.toThrow(
      /60 API requests an hour without a token; set GH_TOKEN/,
    );
  });

  it('points at a token when the asset download itself is rate-limited', async () => {
    // The asset comes from api.github.com too, so it counts against the same 60 an hour.
    const cacheDir = mkdtempSync(join(tmpdir(), 'cihub-cache-'));
    dirs.push(cacheDir);
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).endsWith('/releases/latest')
        ? new Response(
            JSON.stringify({ tag_name: 'v0.3.6', assets: [{ name: 'cihub-linux-x64', url: 'https://api.github.com/repos/x/y/releases/assets/1' }] }),
            {
              status: 200,
            },
          )
        : new Response('{"message":"API rate limit exceeded"}', { status: 429 }),
    ) as unknown as typeof fetch;
    await expect(downloadReleaseAsset({ assetName: 'cihub-linux-x64', version: 'latest', cacheDir, fetchImpl })).rejects.toThrow(
      /asset download failed: HTTP 429.*60 API requests an hour without a token/,
    );
  });

  it('does not blame a missing tag when the release was found but its asset answers 404', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'cihub-cache-'));
    dirs.push(cacheDir);
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).endsWith('/releases/latest')
        ? new Response(
            JSON.stringify({ tag_name: 'v0.3.6', assets: [{ name: 'cihub-linux-x64', url: 'https://api.github.com/repos/x/y/releases/assets/1' }] }),
            { status: 200 },
          )
        : new Response('Not Found', { status: 404 }),
    ) as unknown as typeof fetch;
    const failure = downloadReleaseAsset({ assetName: 'cihub-linux-x64', version: 'latest', cacheDir, fetchImpl });
    await expect(failure).rejects.toThrow(/^asset download failed: HTTP 404 for cihub-linux-x64$/);
  });

  describe.skipIf(process.platform === 'win32')('default cache folder', () => {
    let scratch: string;
    const uid = process.getuid?.() as number;
    const elf = Buffer.concat([Buffer.from('\x7fELF', 'latin1'), Buffer.alloc(64, 1)]);

    // os.tmpdir() reads TMPDIR on every call, so the default cache lands in this scratch folder.
    beforeEach(() => {
      scratch = mkdtempSync(join(tmpdir(), 'cihub-default-cache-'));
      dirs.push(scratch);
      const previousTmpdir = process.env.TMPDIR;
      process.env.TMPDIR = scratch;
      return () => {
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
      };
    });

    it('is a 0700 folder of this user under the temp dir, with no partial file left in it', async () => {
      const asset = await downloadReleaseAsset({ token: 'ghp_x', assetName: 'cihub-linux-x64', version: 'latest', fetchImpl: fakeFetch(elf) });

      const cacheDir = join(scratch, `cihub-fleet-binaries-${uid}`);
      expect(asset.path).toBe(join(cacheDir, 'v0.2.72-cihub-linux-x64'));
      expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
      expect(readdirSync(cacheDir)).toEqual(['v0.2.72-cihub-linux-x64']);
    });

    it('refuses a cache folder other accounts can write to and fetches nothing into it', async () => {
      // Another account that made the folder first could have left its own binary in it.
      const cacheDir = join(scratch, `cihub-fleet-binaries-${uid}`);
      mkdirSync(cacheDir);
      chmodSync(cacheDir, 0o777);
      writeFileSync(join(cacheDir, 'v0.2.72-cihub-linux-x64'), 'planted');
      const fetchImpl = fakeFetch(elf);

      await expect(downloadReleaseAsset({ token: 'ghp_x', assetName: 'cihub-linux-x64', version: 'latest', fetchImpl })).rejects.toThrow(
        /refusing to use .* as the cihub download cache/,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * GitHub computes a sha256 for every asset at upload and publishes it in the release API (`digest`).
 * Before this the bytes were vouched for by TLS alone: whatever the asset URL served was installed.
 */
describe('downloadReleaseAsset and the published digest', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const elf = Buffer.concat([Buffer.from('\x7fELF', 'latin1'), Buffer.alloc(64, 7)]);
  const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const cache = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cihub-digest-'));
    dirs.push(dir);
    return dir;
  };
  const serving = (bytes: Buffer, digest: string | null | undefined) =>
    vi.fn(async (url: string | URL) =>
      String(url).includes('/releases/tags/')
        ? new Response(
            JSON.stringify({
              tag_name: 'v0.3.6',
              assets: [
                { name: 'cihub-linux-x64', url: 'https://api.github.com/repos/x/y/releases/assets/1', ...(digest === undefined ? {} : { digest }) },
              ],
            }),
            { status: 200 },
          )
        : new Response(bytes, { status: 200 }),
    ) as unknown as typeof fetch;

  it('accepts a download whose sha256 matches the published one and says so', async () => {
    const cacheDir = cache();
    const asset = await downloadReleaseAsset({
      assetName: 'cihub-linux-x64',
      version: '0.3.6',
      cacheDir,
      fetchImpl: serving(elf, `sha256:${sha256(elf)}`),
    });
    expect(asset).toMatchObject({ sha256: sha256(elf), digest: 'matched' });
  });

  it('refuses a download that does not match and leaves nothing behind to install', async () => {
    const cacheDir = cache();
    const tampered = Buffer.from(elf);
    tampered[20] = 0xff;
    await expect(
      downloadReleaseAsset({ assetName: 'cihub-linux-x64', version: '0.3.6', cacheDir, fetchImpl: serving(tampered, `sha256:${sha256(elf)}`) }),
    ).rejects.toThrow(/does not match the sha256 GitHub publishes for it .*nothing was installed/);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it('drops a cached copy that no longer matches and fetches the asset again', async () => {
    const cacheDir = cache();
    writeFileSync(join(cacheDir, 'v0.3.6-cihub-linux-x64'), Buffer.concat([elf, Buffer.from('swapped')]));
    const fetchImpl = serving(elf, `sha256:${sha256(elf)}`);
    const asset = await downloadReleaseAsset({ assetName: 'cihub-linux-x64', version: '0.3.6', cacheDir, fetchImpl });
    expect(asset).toMatchObject({ sha256: sha256(elf), digest: 'matched' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('still installs an asset GitHub publishes no digest for and reports that only TLS checked it', async () => {
    for (const digest of [undefined, null, 'md5:abc']) {
      const asset = await downloadReleaseAsset({
        assetName: 'cihub-linux-x64',
        version: '0.3.6',
        cacheDir: cache(),
        fetchImpl: serving(elf, digest),
      });
      expect(asset.digest).toBe('not-published');
    }
  });
});

describe('releaseFailureFix', () => {
  const rateLimited = new GitHubRequestError('GitHub release lookup failed: HTTP 403', 403);

  it('answers a rate limit with the limit, not with "check the release exists"', async () => {
    // After a 403 the run used to say "Check the release exists", for a tag that was there all along.
    const limited = vi.fn(async () => new Response('{"message":"API rate limit exceeded"}', { status: 403 })) as unknown as typeof fetch;
    const pinned = await pinCihubReleaseSource({ kind: 'release', version: 'latest' }, limited);
    expect(pinned.kind === 'unavailable' && pinned.fix.join(' ')).toMatch(/60 API requests an hour without a token: wait for the limit to reset/);
    expect(pinned.kind === 'unavailable' && pinned.fix.join(' ')).not.toMatch(/release exists/);
    expect(releaseFailureFix(rateLimited, 'ghp_x')).toMatch(/rate-limiting the token/);
  });

  it('keeps "check the release exists" for a 404 and names the flag of the command that failed', () => {
    const missing = new GitHubRequestError('HTTP 404', 404);
    expect(releaseFailureFix(missing, undefined)).toMatch(/release exists \(--cihub-version\), or pass --cihub-binary/);
    expect(releaseFailureFix(missing, undefined, { fallback: 'download it by hand', versionFlag: '--to' })).toBe(
      'Check the release exists (--to), or download it by hand.',
    );
  });

  it('points at the network when no answer came back', () => {
    expect(releaseFailureFix(new TypeError('fetch failed'), undefined)).toMatch(/reach api\.github\.com/);
  });
});

describe('installCihubFromStdinScript', () => {
  const script = installCihubFromStdinScript('abc123', 'v0.2.72');

  it('verifies the stream before installing, and never pipes into a shell', () => {
    expect(script).toContain('sha256sum -c');
    expect(script).toContain('[ -s "$tmp" ]');
    expect(script).not.toMatch(/\|\s*(sh|bash)\b/);
    expect(script).toContain('install -m 0755 "$tmp" /usr/local/bin/cihub');
  });

  it('moves aside a user-local copy that would shadow /usr/local/bin, and proves the login shell resolves the new one', () => {
    expect(script).toContain('$HOME/.local/bin/cihub');
    expect(script).toContain('shadowed-by-usr-local-bin');
    expect(script).not.toMatch(/rm -f? "\$other"/);
    expect(script).toContain('command -v cihub');
    expect(script).toContain('cihub-installed v0.2.72');
  });

  it('is valid bash once wrapped for the stream, quotes and all', () => {
    // The wrapper puts the script in argv with every quote escaped; `bash -n` parses the whole
    // command the way the node's login shell will, without running it.
    expect(() => execFileSync('bash', ['-n', '-c', stdinScriptCommand(script)], { stdio: 'pipe' })).not.toThrow();
    expect(() => execFileSync('bash', ['-n', '-c', script], { stdio: 'pipe' })).not.toThrow();
  });
});

describe('stdinScriptCommand', () => {
  /**
   * The install script reads the binary from stdin. Wrapped in a heredoc — the form every other
   * remote step uses — the heredoc IS bash's stdin, so `cat` read the rest of the script instead of
   * the binary and the step came back exit 0, silent, and without its marker. Run the wrapper the way
   * sshd does (`$SHELL -c "<command>"`) with bytes on stdin, and they must reach the script's `cat`.
   */
  const script = ['set -e', 'tmp="$(mktemp)"', 'cat > "$tmp"', 'echo "received $(cat "$tmp")"', 'rm -f "$tmp"', "echo 'stream-done'"].join('\n');

  it('leaves stdin to the script, so a streamed file reaches its cat', () => {
    const out = execFileSync('sh', ['-c', stdinScriptCommand(script)], { input: 'BINARY BYTES', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    expect(out).toContain('received BINARY BYTES');
    expect(out).toContain('stream-done');
  });

  it('is not a heredoc', () => {
    expect(stdinScriptCommand(script)).not.toContain('<<');
    expect(stdinScriptCommand(script).startsWith('bash -c ')).toBe(true);
  });
});
