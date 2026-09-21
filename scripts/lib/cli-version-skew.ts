/**
 * Is the `cihub` you are typing the same build as the Hub stack it is driving?
 *
 * The CLI and the stack image move on two distribution channels that never talk to each other:
 *
 * - the **CLI** ships inside the desktop package (`companion-hub`), as Homebrew/Scoop packages, and
 *   as standalone `cihub-<os>-<arch>` release assets;
 * - the **stack** is `ghcr.io/companionintelligence/ci-hub:<tag>`, moved by `cihub pool update`, by
 *   the backend's `SystemUpdateService`, or by a fleet roll.
 *
 * Rolling one has never moved the other, and nothing reported the gap. Measured on the appliance
 * `beta-max`, 2026-09-21: `cihub version` said `0.2.72`, the running stack was an untagged GHCR
 * index (`sha256:14a09087…`) matching no published tag, and `cihub pool ceiling` — merged, shipped,
 * documented — died with `Unknown pool subcommand: ceiling`. The operator's own Mac was further
 * back still: no `fleet` subcommand at all. Every command in that gap fails as if it never existed,
 * so a runbook written against the repo is wrong on the machine it is run on.
 *
 * This module answers the question in one place, so `update`, `doctor` and `pool update` all give
 * the same answer. Everything but {@link readStackBuild} is pure.
 *
 * ## How each side is identified
 *
 * The CLI knows its own build: the version stamped at compile time (`CIHUB_BUILD_VERSION`) and, for
 * builds that predate or skip a release tag, the commit (`CIHUB_BUILD_REVISION`).
 *
 * The stack is read off the running container, never from `CI_HUB_VERSION` — that value comes from
 * the install's env file, no build stamps it, and it was wrong on 10 of 16 fleet Hubs on 2026-09-17
 * (see `packages/backend/src/modules/system-update/hub-deployment.ts`, which resolves the same three
 * sources for the in-container updater). The order here is the same one:
 *
 *   1. a version tag in the image reference (`ci-hub:0.2.73`);
 *   2. `org.opencontainers.image.version`, when it is version-shaped — release images published
 *      before the metadata fix carry `latest` there, so the label alone cannot be trusted;
 *   3. the highest version tag Docker holds locally for the same image id (`:latest` pulled
 *      alongside `:0.2.73`).
 *
 * A `:dev` build, a digest pin and a local build match none of the three, and `null` is the honest
 * answer for them — at which point the commit is what is left to compare, which is why the CLI
 * carries one too.
 */
import path from 'node:path';
import { packageRevision, packageVersion } from './cli-compose-env.js';
import { runCapture } from './cli-proc.js';
import { HUB_CONTAINER_NAMES } from './compose-discovery.js';
import { compareCihubVersions } from './fleet-cihub-binary.js';

/**
 * A Hub stack version as the release pipeline publishes it (`0.2.73`, `0.2.73-rc.1`), optionally
 * `v`-prefixed. Deliberately the same shape `isHubVersionTag` accepts in the backend: the two have
 * to agree about what counts as a release, or one of them would report skew the other cannot see.
 */
const VERSION_TAG_PATTERN = /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export function isVersionTag(value: string | null | undefined): boolean {
  return typeof value === 'string' && VERSION_TAG_PATTERN.test(value.trim());
}

/** `v0.2.73` and `0.2.73` are the same release; compare and print them one way. */
export function normalizeVersion(value: string): string {
  return value.trim().replace(/^[vV]/, '');
}

/** Split `registry:5000/org/repo:tag@sha256:…`. A colon before the last `/` is a registry port, not a tag. */
export function parseImageTag(reference: string): { repository: string; tag: string | null; digest: string | null } {
  const trimmed = reference.trim();
  const at = trimmed.indexOf('@');
  const name = at >= 0 ? trimmed.slice(0, at) : trimmed;
  const digest = at >= 0 ? trimmed.slice(at + 1) : null;
  const colon = name.lastIndexOf(':');
  if (colon > name.lastIndexOf('/')) return { repository: name.slice(0, colon), tag: name.slice(colon + 1), digest };
  return { repository: name, tag: null, digest };
}

/** The raw labels and tags one `docker inspect` pass yields for the running Hub. */
export interface StackImageFacts {
  /** `Config.Image` — the reference compose created the container from. */
  reference: string;
  /** `org.opencontainers.image.version`. Often `latest` on real releases; see the file header. */
  labelVersion: string | null;
  /** `org.opencontainers.image.revision` — the commit the image was built from. */
  revision: string | null;
  /** `RepoTags` Docker holds for that image id, in whatever order the daemon reports them. */
  repoTags: string[];
}

/** Which build the stack is, as far as the container can prove it. */
export interface StackBuild {
  container: string;
  reference: string;
  /** The release, normalized without the `v`, or null for a build that is not a published release. */
  version: string | null;
  /** The commit, when the build stamped one. A `dev` image has this and no version. */
  revision: string | null;
}

/** Which build this `cihub` is. */
export interface CliBuild {
  version: string;
  revision: string | null;
}

export function resolveStackBuild(container: string, facts: StackImageFacts): StackBuild {
  const fromReference = parseImageTag(facts.reference).tag;
  let version: string | null = isVersionTag(fromReference) ? normalizeVersion(fromReference as string) : null;
  if (!version && isVersionTag(facts.labelVersion)) version = normalizeVersion(facts.labelVersion as string);
  if (!version) {
    const tagged = facts.repoTags
      .map((tag) => parseImageTag(tag).tag)
      .filter((tag): tag is string => isVersionTag(tag))
      .map(normalizeVersion)
      .sort((a, b) => compareCihubVersions(b, a));
    version = tagged[0] ?? null;
  }
  return { container, reference: facts.reference.trim(), version, revision: facts.revision };
}

/**
 * What the two builds are to each other.
 *
 * `incomparable` is its own answer on purpose. "The stack is an untagged build and this CLI carries
 * no commit, so nothing here can be compared" is a different finding from "they match", and reporting
 * it as a match is how beta-max looked healthy while half its documented commands were missing.
 */
export type SkewVerdict =
  | { kind: 'match'; how: 'version' | 'revision'; cli: string; stack: string }
  | { kind: 'skew'; how: 'version' | 'revision'; cli: string; stack: string; direction: 'cli-behind' | 'cli-ahead' | 'unordered' }
  | { kind: 'incomparable'; cli: string; stack: string; why: string }
  | { kind: 'no-stack'; cli: string };

const shortRevision = (revision: string): string => revision.slice(0, 9);

export function compareBuilds(cli: CliBuild, stack: StackBuild | null): SkewVerdict {
  const cliVersion = normalizeVersion(cli.version || '0.0.0');
  if (!stack) return { kind: 'no-stack', cli: cliVersion };

  if (stack.version) {
    if (normalizeVersion(stack.version) === cliVersion) return { kind: 'match', how: 'version', cli: cliVersion, stack: stack.version };
    const ordered = compareCihubVersions(cliVersion, stack.version);
    return {
      kind: 'skew',
      how: 'version',
      cli: cliVersion,
      stack: stack.version,
      // Equal `x.y.z` with different pre-release suffixes orders as 0 here; that is a real
      // difference this comparison cannot rank, and claiming a direction would be a guess.
      direction: ordered < 0 ? 'cli-behind' : ordered > 0 ? 'cli-ahead' : 'unordered',
    };
  }

  // No release on the stack side: the commit is the only identity left. Two dev builds from the same
  // commit ARE the same code, which is the common, healthy state on a `:dev` node.
  if (cli.revision && stack.revision) {
    return cli.revision === stack.revision
      ? { kind: 'match', how: 'revision', cli: shortRevision(cli.revision), stack: shortRevision(stack.revision) }
      : {
          kind: 'skew',
          how: 'revision',
          cli: shortRevision(cli.revision),
          stack: shortRevision(stack.revision),
          direction: 'unordered',
        };
  }

  const stackLabel = stack.revision
    ? `${stack.reference || 'an untagged image'}@${shortRevision(stack.revision)}`
    : stack.reference || 'an unidentified image';
  return {
    kind: 'incomparable',
    cli: cliVersion,
    stack: stackLabel,
    why: stack.revision
      ? 'this cihub build stamps no commit, and the running image names no release'
      : 'the running image names no release and stamps no commit',
  };
}

/** Where this `cihub` came from, which is what decides how it is updated. */
export type CliInstallChannel =
  | { kind: 'homebrew'; path: string }
  | { kind: 'scoop'; path: string }
  | { kind: 'desktop'; path: string }
  | { kind: 'standalone'; path: string }
  | { kind: 'source'; path: string };

/**
 * Classify the running `cihub` from the path it was executed as.
 *
 * A Bun-compiled standalone build runs as itself, so `process.execPath` IS the cihub binary; a
 * source run through tsx has `node` there instead, and nothing about that install is replaceable in
 * place. Between those two, the path says who owns the file — a package manager's prefix means the
 * package manager updates it, and writing over a Cellar/Caskroom or Scoop path behind its back
 * leaves the manifest claiming a version that is no longer on disk.
 */
export function classifyCliInstall(execPath: string, platform: NodeJS.Platform = process.platform): CliInstallChannel {
  const normalized = execPath.replace(/\\/g, '/');
  const base = path.posix.basename(normalized).toLowerCase();
  if (!base.startsWith('cihub')) return { kind: 'source', path: execPath };
  const lower = normalized.toLowerCase();
  if (lower.includes('/cellar/') || lower.includes('/caskroom/') || lower.includes('/homebrew/') || lower.includes('/linuxbrew/')) {
    return { kind: 'homebrew', path: execPath };
  }
  if (lower.includes('/scoop/apps/') || lower.includes('/scoop/shims/')) return { kind: 'scoop', path: execPath };
  // The copy Tauri bundles as a resource beside the desktop app: replaced by the desktop updater,
  // never on its own, or the app and the CLI it ships stop being one artifact.
  if (lower.includes('.app/contents/') || lower.includes('/companion hub/') || lower.includes('/companion-hub/resources/')) {
    return { kind: 'desktop', path: execPath };
  }
  void platform;
  return { kind: 'standalone', path: execPath };
}

/** The exact command that moves the CLI on this channel — printed, so an operator can copy it. */
export function cliUpdateInstructions(channel: CliInstallChannel, target?: string): string[] {
  const pin = target ? ` --to ${target}` : '';
  switch (channel.kind) {
    case 'homebrew':
      return ['brew update && brew upgrade --cask companion-hub'];
    case 'scoop':
      return ['scoop update companion-hub'];
    case 'desktop':
      return ['companion-hub update', '(this cihub ships inside the desktop app; the app updater replaces both)'];
    case 'standalone':
      return [`cihub self-update${pin}`];
    case 'source':
      return ['git pull, then rebuild: node scripts/build-standalone-cli.cjs'];
  }
}

export interface SkewReport {
  severity: 'ok' | 'warn' | 'fail';
  /** One line, safe to print on its own after another command. */
  headline: string;
  /** The headline plus what to do about it. */
  lines: string[];
}

/**
 * The verdict as an operator reads it.
 *
 * Only a proven mismatch is a failure: two builds that both name a release, and name different ones.
 * A `:dev` node whose CLI and image cannot be compared gets a warning, because that state is normal
 * on a development node and failing it would put a red line on every one of them — but it is never
 * silent, which is the whole defect being fixed.
 */
export function describeSkew(verdict: SkewVerdict, channel: CliInstallChannel): SkewReport {
  switch (verdict.kind) {
    case 'no-stack':
      return {
        severity: 'ok',
        headline: `cihub ${verdict.cli}; no Hub container running, so there is nothing to compare it against`,
        lines: [`cihub ${verdict.cli}; no Hub container running, so there is nothing to compare it against`],
      };
    case 'match':
      return {
        severity: 'ok',
        headline:
          verdict.how === 'version' ? `cihub ${verdict.cli} matches the running stack` : `cihub and the running stack are both commit ${verdict.cli}`,
        lines: [
          verdict.how === 'version' ? `cihub ${verdict.cli} matches the running stack` : `cihub and the running stack are both commit ${verdict.cli}`,
        ],
      };
    case 'incomparable':
      return {
        severity: 'warn',
        headline: `cihub ${verdict.cli} vs stack ${verdict.stack} — cannot be compared: ${verdict.why}`,
        lines: [
          `cihub ${verdict.cli} vs stack ${verdict.stack}`,
          `Cannot be compared: ${verdict.why}.`,
          'A command this CLI does not have fails as if it never existed, so treat the docs as ahead of this machine.',
          ...cliUpdateInstructions(channel).map((line) => `  ${line}`),
        ],
      };
    case 'skew': {
      const both =
        verdict.how === 'version' ? `cihub ${verdict.cli} vs stack ${verdict.stack}` : `cihub commit ${verdict.cli} vs stack commit ${verdict.stack}`;
      const why =
        verdict.direction === 'cli-behind'
          ? 'This CLI is older than the stack it is driving: commands the stack and the docs have may be missing here.'
          : verdict.direction === 'cli-ahead'
            ? 'This CLI is newer than the stack it is driving: it may call routes this Hub build does not serve.'
            : 'These are different builds; which is newer cannot be ordered from here.';
      return {
        severity: verdict.how === 'version' ? 'fail' : 'warn',
        headline: `${both} — ${verdict.direction === 'cli-ahead' ? 'CLI ahead of stack' : verdict.direction === 'cli-behind' ? 'CLI behind stack' : 'builds differ'}`,
        lines: [both, why, ...cliUpdateInstructions(channel, verdict.how === 'version' ? verdict.stack : undefined).map((line) => `  ${line}`)],
      };
    }
  }
}

const INSPECT_FORMAT = [
  'reference={{.Config.Image}}',
  'labelVersion={{index .Config.Labels "org.opencontainers.image.version"}}',
  'revision={{index .Config.Labels "org.opencontainers.image.revision"}}',
].join('\n');

/** A label Docker has no value for renders as `` on some daemons and `<no value>` on others. Both mean absent. */
function present(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  return value === '' || value === '<no value>' ? null : value;
}

export function parseStackInspect(stdout: string): Omit<StackImageFacts, 'repoTags'> {
  const fields = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  return {
    reference: present(fields.get('reference')) ?? '',
    labelVersion: present(fields.get('labelVersion')),
    revision: present(fields.get('revision')),
  };
}

export type InspectExec = (cmd: string, args: string[]) => { ok: boolean; stdout: string };

/**
 * Read the running Hub's build, or null when no Hub container is running (or Docker is not there).
 *
 * Tries each known container name rather than a substring match on "hub": a node with an
 * `hub-tailscale` sidecar and app containers carrying the word would otherwise match the wrong one.
 */
export function readStackBuild(
  exec: InspectExec = (cmd, args) => runCapture(cmd, args),
  names: readonly string[] = HUB_CONTAINER_NAMES,
): StackBuild | null {
  for (const container of names) {
    const inspected = exec('docker', ['inspect', container, '--format', INSPECT_FORMAT]);
    if (!inspected.ok) continue;
    const facts = parseStackInspect(inspected.stdout);
    // Second call, and only when there is something to look up: the repo tags are the third and
    // weakest source, and a node whose image was deleted from under the container has none.
    const tags = facts.reference
      ? exec('docker', ['image', 'inspect', facts.reference, '--format', '{{join .RepoTags ","}}'])
      : { ok: false, stdout: '' };
    const repoTags = tags.ok
      ? tags.stdout
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [];
    return resolveStackBuild(container, { ...facts, repoTags });
  }
  return null;
}

/**
 * This `cihub`'s own identity.
 *
 * The commit comes from the compile-time stamp when there is one. A source run has no stamp and
 * every reason to know its commit anyway — it is the checkout — so `git rev-parse HEAD` fills it in.
 * That is one subprocess, on the skew path only, and it is what makes `pnpm cihub doctor` in a
 * working tree comparable against a `:dev` image built from the same commit.
 */
export function readCliBuild(exec: InspectExec = (cmd, args) => runCapture(cmd, args), cwd: string = process.cwd()): CliBuild {
  const stamped = packageRevision();
  if (stamped) return { version: packageVersion(), revision: stamped };
  const head = exec('git', ['-C', cwd, 'rev-parse', 'HEAD']);
  return { version: packageVersion(), revision: head.ok && head.stdout.trim() ? head.stdout.trim() : null };
}

/** Everything the three call sites need, gathered once. */
export interface SkewSnapshot {
  cli: CliBuild;
  stack: StackBuild | null;
  channel: CliInstallChannel;
  verdict: SkewVerdict;
  report: SkewReport;
}

export function gatherSkew(exec: InspectExec = (cmd, args) => runCapture(cmd, args)): SkewSnapshot {
  const cli = readCliBuild(exec);
  const stack = readStackBuild(exec);
  const channel = classifyCliInstall(process.execPath);
  const verdict = compareBuilds(cli, stack);
  return { cli, stack, channel, verdict, report: describeSkew(verdict, channel) };
}
