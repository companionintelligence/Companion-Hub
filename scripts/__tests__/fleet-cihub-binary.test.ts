import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assetNameForArch,
  compareCihubVersions,
  downloadReleaseAsset,
  installCihubFromStdinScript,
  parseCihubVersionOutput,
  pinCihubReleaseSource,
  resolveCihubBinarySource,
} from '../lib/fleet-cihub-binary.js';
import { stdinScriptCommand } from '../lib/fleet-ssh.js';

/**
 * The release is in a private repository. Every case here is a way the first installer got that
 * wrong on a real fleet: a node curling the API unauthenticated, an HTML page installed as a binary,
 * an August copy on PATH shadowing a fresh one.
 */
describe('resolveCihubBinarySource', () => {
  it('refuses, with the fix, when there is no token and no file — before any node is dialled', () => {
    const source = resolveCihubBinarySource({ env: {} });
    expect(source.kind).toBe('unavailable');
    if (source.kind === 'unavailable') {
      expect(source.why).toMatch(/private/);
      expect(source.fix.join(' ')).toMatch(/GH_TOKEN/);
      expect(source.fix.join(' ')).toMatch(/--cihub-binary/);
    }
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

  it('makes a lookup the token cannot do into "nothing to install", with the fix, before any node is dialled', async () => {
    const denied = vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch;
    const pinned = await pinCihubReleaseSource({ kind: 'release', token: 'ghp_x', version: 'latest' }, denied);
    expect(pinned.kind).toBe('unavailable');
    if (pinned.kind === 'unavailable') {
      expect(pinned.why).toMatch(/HTTP 404/);
      expect(pinned.why).toMatch(/private repo/);
      expect(pinned.fix.join(' ')).toMatch(/GH_TOKEN/);
    }
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

  it('names the private-repo cause on a 404 release lookup', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch;
    await expect(downloadReleaseAsset({ token: 'ghp_x', assetName: 'cihub-linux-x64', version: 'latest', fetchImpl })).rejects.toThrow(
      /private repo/,
    );
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
