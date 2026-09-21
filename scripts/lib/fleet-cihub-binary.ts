/**
 * Where the `cihub` binary a fleet install puts on a node comes from.
 *
 * The release assets live in a private GitHub repository. The first version of the installer had
 * each node `curl` `api.github.com/…/releases/latest` unauthenticated, which answers 404 for a private
 * repo — so it failed on every node of a fifteen-node fleet, on 2026-09-18, before anything else could
 * run. The node has no GitHub credential and should not be given one. The operator's machine can
 * fetch the asset (a token in its environment, or a file already on disk) and the SSH session the
 * install holds can carry the bytes down. That is what this module does; nothing here runs on a node.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CIHUB_RELEASES_REPO = 'companionintelligence/CI-Hub';

/** Env vars an operator machine may already carry a GitHub token in — `gh` and Actions both set one. */
export const GITHUB_TOKEN_ENV_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

export type CihubBinarySource =
  /**
   * A file the operator named. Streamed as-is; its version is read by running it when that is
   * possible, else taken from `--cihub-version` when one was given, else unknown.
   */
  | { kind: 'local'; path: string; version?: string }
  /**
   * Fetched from the GitHub release on the operator machine with a token, once per architecture.
   * `version` is a tag once `pinCihubReleaseSource` has run; `resolvedFrom` then keeps what the flag
   * said (`latest`) for the run's own summary line.
   */
  | { kind: 'release'; token: string; version: string; resolvedFrom?: string }
  /** Nothing to install from. `why` and `fix` are what the node's line will say. */
  | { kind: 'unavailable'; why: string; fix: string[] };

/**
 * The release asset for a *host* running this CLI, across all three platforms.
 *
 * `assetNameForArch` answers the fleet-install question — "which Linux asset does this NODE take" —
 * and only ever needs Linux, because a fleet node is one. `cihub self-update` asks about the machine
 * it is running on, which is as often a macOS laptop as an appliance. Same naming the release
 * workflow publishes: `cihub-<os>-<arch>`, `.exe` on Windows.
 */
export function assetNameForPlatform(platform: NodeJS.Platform, arch: string): string | undefined {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : undefined;
  if (!os) return undefined;
  const cpu = arch === 'x64' || arch === 'x86_64' || arch === 'amd64' ? 'x64' : arch === 'arm64' || arch === 'aarch64' ? 'arm64' : undefined;
  if (!cpu) return undefined;
  return `cihub-${os}-${cpu}${os === 'windows' ? '.exe' : ''}`;
}

/**
 * Is this actually an executable for the platform the asset name claims?
 *
 * The check exists because the failure it catches is the one this download had for its whole life:
 * a private-repo API error is served as an HTML page with a 200, written to disk under the asset's
 * name, and installed. Per-platform rather than ELF-only so the macOS and Windows assets
 * `cihub self-update` fetches are held to the same bar — `<html>` is not a Mach-O either.
 */
export function assetFormatError(assetName: string, bytes: Buffer): string | undefined {
  const head = bytes.subarray(0, 4);
  const shown = JSON.stringify(bytes.subarray(0, 12).toString('latin1'));
  if (assetName.includes('-linux-')) {
    return head.toString('latin1') === '\x7fELF' ? undefined : `asset ${assetName} is not an ELF binary (starts with ${shown})`;
  }
  if (assetName.includes('-macos-')) {
    // Thin Mach-O (either endianness) or a universal `fat` archive.
    const magics = new Set(['feedfacf', 'feedface', 'cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca']);
    return magics.has(head.toString('hex')) ? undefined : `asset ${assetName} is not a Mach-O binary (starts with ${shown})`;
  }
  if (assetName.includes('-windows-')) {
    return head.subarray(0, 2).toString('latin1') === 'MZ' ? undefined : `asset ${assetName} is not a Windows executable (starts with ${shown})`;
  }
  return undefined;
}

export function assetNameForArch(arch: string): string | undefined {
  switch (arch) {
    case 'x86_64':
    case 'amd64':
      return 'cihub-linux-x64';
    case 'aarch64':
    case 'arm64':
      return 'cihub-linux-arm64';
    default:
      return undefined;
  }
}

/**
 * Decide the source before any node is dialled, so a run with no way to get the binary refuses on
 * the first node rather than after its Portal device has been minted.
 */
export function resolveCihubBinarySource(input: {
  binaryPath?: string;
  version?: string;
  env?: NodeJS.ProcessEnv;
  readVersion?: (binaryPath: string) => string | undefined;
}): CihubBinarySource {
  const env = input.env ?? process.env;
  if (input.binaryPath) {
    if (!existsSync(input.binaryPath) || !statSync(input.binaryPath).isFile()) {
      return {
        kind: 'unavailable',
        why: `--cihub-binary ${input.binaryPath} is not a file`,
        fix: ['Point --cihub-binary at a cihub-linux-x64 or cihub-linux-arm64 release asset.'],
      };
    }
    // The file's own answer first. When it will not run here — an arm64 asset on an x64 operator
    // machine — an explicit --cihub-version is the operator saying what it is; `latest` is not a
    // version and names nothing.
    const declared = input.version && input.version !== 'latest' ? input.version : undefined;
    return { kind: 'local', path: input.binaryPath, version: input.readVersion?.(input.binaryPath) ?? declared };
  }
  const token = GITHUB_TOKEN_ENV_VARS.map((name) => env[name]?.trim()).find(Boolean);
  if (token) return { kind: 'release', token, version: input.version ?? 'latest' };
  return {
    kind: 'unavailable',
    why: `no cihub binary to install: ${CIHUB_RELEASES_REPO} releases are private, and a node cannot fetch them`,
    fix: [
      `Set GH_TOKEN (e.g. GH_TOKEN="$(gh auth token)") so this machine fetches the release and streams it to each node,`,
      'or pass --cihub-binary <path> to a cihub-linux-x64 / cihub-linux-arm64 asset already on disk.',
    ],
  };
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** `cihub version` prints a stray notice before the version on some builds — take the line that is one. */
export function parseCihubVersionOutput(output: string): string | undefined {
  const match = output.match(/^cihub\s+v?(\d+\.\d+\.\d+\S*)/m);
  return match?.[1];
}

/** Numeric semver compare on the `x.y.z` prefix; pre-release suffixes are ignored. Returns <0, 0, >0. */
export function compareCihubVersions(a: string, b: string): number {
  const parse = (v: string) => (v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1, 4).map(Number);
  const [a1 = 0, a2 = 0, a3 = 0] = parse(a);
  const [b1 = 0, b2 = 0, b3 = 0] = parse(b);
  return a1 - b1 || a2 - b2 || a3 - b3;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size?: number;
}

export interface ReleaseInfo {
  tag_name: string;
  assets: ReleaseAsset[];
}

const githubHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cihub-fleet' });

/** The release a version names: `latest` as GitHub resolves it right now, or one tag, `v` or not. */
export async function lookupRelease(input: { token: string; version: string; fetchImpl?: typeof fetch }): Promise<ReleaseInfo> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const releaseUrl =
    input.version === 'latest'
      ? `https://api.github.com/repos/${CIHUB_RELEASES_REPO}/releases/latest`
      : `https://api.github.com/repos/${CIHUB_RELEASES_REPO}/releases/tags/${input.version.startsWith('v') ? input.version : `v${input.version}`}`;
  const releaseRes = await fetchImpl(releaseUrl, { headers: { ...githubHeaders(input.token), Accept: 'application/vnd.github+json' } });
  if (!releaseRes.ok) {
    throw new Error(
      `GitHub release lookup failed: HTTP ${releaseRes.status} for ${releaseUrl}${releaseRes.status === 404 ? ' — does the token see the private repo?' : ''}`,
    );
  }
  return (await releaseRes.json()) as ReleaseInfo;
}

/**
 * Turn `latest` into the tag it names, before any node is dialled.
 *
 * `latest` is what the flag says, not a version, and the adopt-or-replace decision on each node
 * compares versions: handed `latest`, it could only adopt whatever was on PATH. On 2026-09-20 that
 * was a July 0.2.36 in `~/.local/bin`, kept on a node the run had a current release for, and its
 * `cihub up` did not know the headless seed path. Resolving here also means fourteen nodes install
 * the one tag this run saw, not whichever release lands mid-pass, and a token that cannot see the
 * repository is reported once on the summary line rather than adopted around on every node.
 */
export async function pinCihubReleaseSource(source: CihubBinarySource, fetchImpl?: typeof fetch): Promise<CihubBinarySource> {
  if (source.kind !== 'release') return source;
  try {
    const release = await lookupRelease({ token: source.token, version: source.version, fetchImpl });
    return { ...source, version: release.tag_name, ...(source.version === 'latest' ? { resolvedFrom: 'latest' } : {}) };
  } catch (error) {
    return {
      kind: 'unavailable',
      why: error instanceof Error ? error.message : String(error),
      fix: ['Check GH_TOKEN can read the private repository, or pass --cihub-binary.'],
    };
  }
}

/**
 * Fetch one release asset with the operator's token into a per-run cache, and return its path.
 *
 * Two requests: the release (by tag, or `latest`), then the asset by its API URL with
 * `Accept: application/octet-stream`, which is the only form that serves a private repository's
 * asset bytes. The browser download URL does not, whatever the token.
 */
export async function downloadReleaseAsset(input: {
  token: string;
  assetName: string;
  version: string;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ path: string; tag: string; sha256: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = githubHeaders(input.token);
  const release = await lookupRelease({ token: input.token, version: input.version, fetchImpl });
  const asset = release.assets.find((a) => a.name === input.assetName);
  if (!asset)
    throw new Error(`release ${release.tag_name} has no asset named ${input.assetName} (has: ${release.assets.map((a) => a.name).join(', ')})`);

  const cacheDir = input.cacheDir ?? path.join(tmpdir(), 'cihub-fleet-binaries');
  mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `${release.tag_name}-${input.assetName}`);
  if (!existsSync(target) || statSync(target).size === 0) {
    const assetRes = await fetchImpl(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'follow' });
    if (!assetRes.ok) throw new Error(`asset download failed: HTTP ${assetRes.status} for ${input.assetName}`);
    const bytes = Buffer.from(await assetRes.arrayBuffer());
    if (bytes.length === 0) throw new Error(`asset download for ${input.assetName} was empty`);
    // Refuse an HTML error page renamed to a binary — the failure this download had for its whole life.
    const formatError = assetFormatError(input.assetName, bytes);
    if (formatError) throw new Error(formatError);
    writeFileSync(target, bytes, { mode: 0o755 });
  }
  return { path: target, tag: release.tag_name, sha256: sha256File(target) };
}

/**
 * The remote half of the stream: read the binary from stdin, verify it, install it, and make sure it
 * is the `cihub` a login shell will find.
 *
 * The last part is not cosmetic. `REMOTE_TOOL_INIT` puts `$HOME/.local/bin` ahead of `/usr/local/bin`,
 * and on 2026-09-18 five of fifteen fleet nodes carried a forgotten `~/.local/bin/cihub` from August.
 * On one of them the install adopted it, and its `cihub up` — a version that predates the current
 * compose service names — took half the freshly seeded stack down. A copy that would shadow the one
 * just installed is moved aside, named for what displaced it, never deleted.
 */
export function installCihubFromStdinScript(sha256: string, label: string): string {
  return [
    'set -e',
    'tmp="$(mktemp)"',
    'trap \'rm -f "$tmp"\' EXIT',
    'cat > "$tmp"',
    `echo '${sha256}  '"$tmp" | sha256sum -c --quiet || { echo "cihub stream corrupted in transit (sha256 mismatch)" >&2; exit 1; }`,
    '[ -s "$tmp" ] || { echo "received an empty cihub binary" >&2; exit 1; }',
    'if [ "$(id -u)" = 0 ]; then SUDO=""; elif sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; else echo "no passwordless sudo to install into /usr/local/bin" >&2; exit 1; fi',
    '$SUDO install -m 0755 "$tmp" /usr/local/bin/cihub',
    'for other in "$HOME/.local/bin/cihub" "$HOME/.bun/bin/cihub" "$HOME/.asdf/shims/cihub"; do',
    '  if [ -e "$other" ] && [ ! "$other" -ef /usr/local/bin/cihub ]; then',
    '    mv "$other" "$other.shadowed-by-usr-local-bin-$(date +%Y%m%d)" && echo "moved aside $other (would have shadowed /usr/local/bin/cihub)"',
    '  fi',
    'done',
    'found="$(command -v cihub || true)"',
    '[ "$found" = /usr/local/bin/cihub ] || { echo "installed /usr/local/bin/cihub but a login shell resolves cihub to $found" >&2; exit 1; }',
    `echo "cihub-installed ${label}"`,
  ].join('\n');
}
