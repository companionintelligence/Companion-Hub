/**
 * Which build of the Hub this process is, answered from the image it runs in.
 *
 * ## Why this exists
 *
 * A deployed Hub could not state its own build. Measured on 2026-09-21: `package.json` on
 * `origin/dev` read `0.2.61` while published releases were at `0.2.73`, and all 17 fleet
 * appliances ran GHCR image index `sha256:14a09087…`, which carries no tag at all — distinct from
 * both `:latest` (`sha256:d8f0b6a0…`) and `:dev` (`sha256:3e2791d6…`). Nothing on the node could
 * name what it was running.
 *
 * Three existing answers were all wrong, each for its own reason:
 *
 * - **`CI_HUB_VERSION`** is read from the install's env file, which no build writes. It was wrong
 *   on 10 of 16 fleet Hubs (`0.2.53`, `v0.2.22`, `4.5.0`, `latest`, `local-paint-*`) — see
 *   `modules/system-update/hub-deployment.ts`, which stopped trusting it for that reason.
 * - **`package.json`** is not bumped per release; `scripts/build-standalone-cli.cjs` says so in as
 *   many words, and the release pipeline threads the tag instead. The in-image copy is whatever
 *   number was last hand-edited into the branch.
 * - **OCI labels** are correct, but reading them needs the Docker socket. "Which build am I?" must
 *   be answerable by the process itself, including on a node whose socket is unavailable or whose
 *   Hub runs outside a container.
 *
 * ## The stamp
 *
 * `CI_HUB_BUILD_*` is a namespace only the image build writes (see the Dockerfile's runner stage).
 * It is deliberately NOT `CI_HUB_VERSION`: compose `environment:` overrides image ENV, so a stamp
 * under that name would be shadowed by the very env-file value that was wrong on two thirds of the
 * fleet. No compose file, env writer or `.env` template sets a `CI_HUB_BUILD_*` key, so a value
 * present here came from the build.
 *
 * Everything is pure and env-driven so each fleet case above is a plain unit test. The one fact
 * that cannot be stamped is the image digest: the registry computes it from the pushed manifest,
 * so it does not exist while the layers are being built. It is read back from Docker at runtime and
 * merged in by the caller — `imageDigest` is null whenever that read is unavailable.
 */

/** How much of the identity below is actually known. */
export type HubBuildInfoSource =
  /** The image build stamped it. The only source that identifies a published build. */
  | 'image'
  /** Nothing stamped this image — a local `docker build`, or a build predating the stamp. */
  | 'unstamped';

export interface HubBuildInfo {
  /**
   * The release (`0.2.73`) or channel (`dev`, `nightly`) this image was built as, unprefixed.
   * Null when unstamped — never a guess, and never `package.json`.
   */
  version: string | null;
  /** The floating tag this build was published under: `latest`, `dev`, `staging`, `nightly`. */
  channel: string | null;
  /** Full commit SHA the image was built from. The only thing that separates two untagged `:dev` indexes. */
  gitSha: string | null;
  /** Short form of `gitSha`, for logs and `cihub version`. */
  gitShaShort: string | null;
  /** The git ref built, e.g. `refs/heads/dev`. */
  gitRef: string | null;
  /** ISO-8601 build time. */
  builtAt: string | null;
  /** The reference this build published, e.g. `ghcr.io/companionintelligence/ci-hub:0.2.73`. */
  imageRef: string | null;
  /**
   * The digest of the image actually running, when something could read it back from Docker.
   * Never stamped at build time — see the module comment.
   */
  imageDigest: string | null;
  source: HubBuildInfoSource;
  /**
   * The env file's `CI_HUB_VERSION`, reported as what it is: a value the operator's install
   * carries, NOT evidence of which build is running. Surfaced so an operator can see the two
   * disagree — that disagreement is the bug this endpoint was added to make visible.
   */
  declaredVersion: string | null;
  /** One line naming this build, for logs, `cihub version`, and bug reports. */
  summary: string;
}

/** Trimmed value, or null for absent/blank. An empty stamp is "not stamped", not an empty version. */
function read(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * GHCR tags are unprefixed and the desktop's pin strips the `v` (see `hub_env.rs`), so `v0.2.73`
 * and `0.2.73` are the same build. Normalising here keeps a stamped `v`-prefixed tag from reading
 * as a different version than the one in the image reference.
 */
function stripVersionPrefix(version: string): string {
  return /^v\d/.test(version) ? version.slice(1) : version;
}

/**
 * A full 40-hex SHA abbreviates to 9 — the width `describeRunningBuild()` already uses for the
 * revision label, so the two agree on screen. Anything else is passed through untouched rather
 * than sliced blindly: a short SHA, or a ref that is not a SHA at all, must not be truncated into
 * something that looks like a commit and is not.
 */
export function shortenGitSha(sha: string | null): string | null {
  if (!sha) return null;
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 9) : sha;
}

/**
 * One line that names the build, degrading through what is actually known.
 *
 * A release build reads `0.2.73 (abc123def)`. A channel build, which has no version, reads
 * `dev (abc123def)` — the commit is what distinguishes two `:dev` images. An unstamped image says
 * so outright rather than borrowing the env file's number, because borrowing it is how a Hub came
 * to report `4.5.0`.
 */
export function summarizeHubBuild(info: Omit<HubBuildInfo, 'summary'>): string {
  const commit = info.gitShaShort ? ` (${info.gitShaShort})` : '';
  if (info.version) return `${info.version}${commit}`;
  if (info.gitShaShort) return `unversioned build${commit}`;
  return 'unidentified build (this image carries no build stamp)';
}

/**
 * The build identity of the running process, from the image stamp alone.
 *
 * `imageDigest` is always null here; a caller that can reach Docker merges it in. Pure, so the
 * Hub answers `GET /api/hub/build` even when the socket is gone — which is exactly the state an
 * operator is usually in when they need to ask.
 */
export function resolveHubBuildInfo(env: NodeJS.ProcessEnv = process.env): HubBuildInfo {
  const stampedVersion = read(env, 'CI_HUB_BUILD_VERSION');
  const version = stampedVersion ? stripVersionPrefix(stampedVersion) : null;
  const channel = read(env, 'CI_HUB_BUILD_CHANNEL');
  const gitSha = read(env, 'CI_HUB_BUILD_SHA');
  const gitRef = read(env, 'CI_HUB_BUILD_REF');
  const builtAt = read(env, 'CI_HUB_BUILD_TIME');
  const imageRef = read(env, 'CI_HUB_BUILD_IMAGE_REF');

  // Any stamp at all means a build wrote it. Keyed off the whole namespace rather than the version
  // alone so an image that carries only a commit still reports `image`: that commit IS an identity,
  // and calling it `unstamped` would hide the one fact such a build does have.
  const stamped = Boolean(version || channel || gitSha || gitRef || builtAt || imageRef);

  const base = {
    version,
    channel,
    gitSha,
    gitShaShort: shortenGitSha(gitSha),
    gitRef,
    builtAt,
    imageRef,
    imageDigest: null,
    source: (stamped ? 'image' : 'unstamped') satisfies HubBuildInfoSource as HubBuildInfoSource,
    declaredVersion: read(env, 'CI_HUB_VERSION'),
  };

  return { ...base, summary: summarizeHubBuild(base) };
}
