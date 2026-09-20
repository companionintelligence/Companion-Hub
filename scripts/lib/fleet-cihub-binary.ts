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
  /** A file the operator named. Streamed as-is; its version is read by running it when that is possible. */
  | { kind: 'local'; path: string; version?: string }
  /** Fetched from the GitHub release on the operator machine with a token, once per architecture. */
  | { kind: 'release'; token: string; version: string }
  /** Nothing to install from. `why` and `fix` are what the node's line will say. */
  | { kind: 'unavailable'; why: string; fix: string[] };

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
    return { kind: 'local', path: input.binaryPath, version: input.readVersion?.(input.binaryPath) };
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

interface ReleaseAsset {
  name: string;
  url: string;
  size?: number;
}

interface ReleaseInfo {
  tag_name: string;
  assets: ReleaseAsset[];
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
  const headers = { Authorization: `Bearer ${input.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cihub-fleet' };
  const releaseUrl =
    input.version === 'latest'
      ? `https://api.github.com/repos/${CIHUB_RELEASES_REPO}/releases/latest`
      : `https://api.github.com/repos/${CIHUB_RELEASES_REPO}/releases/tags/${input.version.startsWith('v') ? input.version : `v${input.version}`}`;

  const releaseRes = await fetchImpl(releaseUrl, { headers: { ...headers, Accept: 'application/vnd.github+json' } });
  if (!releaseRes.ok) {
    throw new Error(
      `GitHub release lookup failed: HTTP ${releaseRes.status} for ${releaseUrl}${releaseRes.status === 404 ? ' — does the token see the private repo?' : ''}`,
    );
  }
  const release = (await releaseRes.json()) as ReleaseInfo;
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
    if (bytes.subarray(0, 4).toString('latin1') !== '\x7fELF')
      throw new Error(`asset ${input.assetName} is not an ELF binary (starts with ${JSON.stringify(bytes.subarray(0, 12).toString('latin1'))})`);
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
