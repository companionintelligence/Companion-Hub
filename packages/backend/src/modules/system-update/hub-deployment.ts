/**
 * What the running Hub is, and how compose created it, read from Docker instead of assumed.
 *
 * The self-updater used to answer both questions from its own configuration, and both answers were
 * wrong on most of the fleet (measured 2026-09-17, 16 Hubs):
 *
 * - "Which build is this?" came from `CI_HUB_VERSION`, a value the install's env file carries and no
 *   build ever stamps. It read `0.2.53`, `v0.2.22`, `4.5.0`, `latest` and `local-paint-*` on 10 of
 *   the 16. beta-red, running a `ci-hub:dev` build newer than 0.2.71, read `v0.2.22`, so the daily
 *   check decided it was out of date.
 * - "Which release line does the operator want?" was not asked at all. The daily check rewrote
 *   `CI_HUB_IMAGE=…:dev` to `…:0.2.71` on core-2, core-4, core-6, core-17, beta-red and beta-max, and
 *   each node left the channel its operator had put it on.
 * - "How was this stack started?" came from a fixed layout: `/data/docker-compose.yml`, `/data/.env`,
 *   `ROOT_FOLDER_HOST` as the project directory and `ENV_FILE=.env`. On core-4 and core-14, which run
 *   from a source checkout with `.env.prod`, compose failed daily from 09-12 to 09-15 with `bind source
 *   path does not exist: /home/ci/devel/CI-Hub/.internal/.env`. It had already recreated the queue, so
 *   RabbitMQ sat in `Created` and every app lifecycle command failed for hours. On core-6 the same
 *   relative `.env` did not exist inside the updater container, `env_file` is `required: false`, and
 *   the Hub came back without JWT_SECRET, DEVICE_ID, DOMAIN and CI_CLOUD_URL.
 *
 * The container knows all three answers: its image reference and OCI labels say what it runs, and the
 * `com.docker.compose.*` labels plus its bind mounts say how compose made it. `scripts/lib/compose-
 * discovery.ts` reads the same labels for `cihub pool update`; this is the in-container half, which
 * also has to translate container paths back to host paths. Everything here is pure, so each fleet
 * case above is a recorded fixture in the tests.
 */
import path from 'node:path';
import * as semver from 'semver';
import { HUB_STACK_IMAGE_REPO } from '@/common/constants';

/** The retired GHCR package. A version pin there is still a release pin, just an unpullable one (#920). */
export const LEGACY_HUB_STACK_IMAGE_REPO = 'ghcr.io/companionintelligence/ci-os-hub';

/**
 * A Hub stack version as the release pipeline publishes it (`0.2.71`, `0.2.72-rc.1`), with an
 * optional leading `v`: the shape the desktop accepts as a pin (`is_version_image_tag`). The
 * version is written into the Hub `.env` as `KEY=value` lines, and the desktop reads that file
 * at launch, so anything else (a line break above all) is refused rather than trimmed.
 */
const HUB_VERSION_TAG_PATTERN = /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export const HUB_VERSION_TAG_MESSAGE = 'targetVersion must be a Hub version such as 0.2.71';

export function isHubVersionTag(value: string): boolean {
  return HUB_VERSION_TAG_PATTERN.test(value);
}

/** The subset of `docker inspect --type container` this module reads. */
export interface DockerContainerInspect {
  Name?: string;
  Image?: string;
  Config?: { Image?: string; Labels?: Record<string, string> | null } | null;
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string }> | null;
}

/** The subset of `docker image inspect` this module reads. */
export interface DockerImageInspect {
  RepoTags?: string[] | null;
}

export interface ImageReference {
  repository: string;
  tag: string | null;
  digest: string | null;
}

/** Split `registry:5000/org/repo:tag@sha256:…`. A colon before the last `/` is a registry port, not a tag. */
export function parseImageReference(reference: string): ImageReference {
  const trimmed = reference.trim();
  const at = trimmed.indexOf('@');
  const name = at >= 0 ? trimmed.slice(0, at) : trimmed;
  const digest = at >= 0 ? trimmed.slice(at + 1) : null;
  const colon = name.lastIndexOf(':');
  if (colon > name.lastIndexOf('/')) {
    return { repository: name.slice(0, colon), tag: name.slice(colon + 1), digest };
  }
  return { repository: name, tag: null, digest };
}

/**
 * The release line an image reference follows.
 *
 * Only `pin` is something the updater may advance. `floating` covers the channel tags (`dev`,
 * `staging`, `latest`) and every other non-version tag the fleet runs (`pr-auto-76b1c7bc1`); a digest
 * and a foreign repository (a local build such as `ci-hub-ci-hub:latest`) are choices just as
 * deliberate. Rewriting any of them to a version tag is the channel change the fleet did not ask for.
 */
export type HubImageChannel =
  | { kind: 'pin'; version: string }
  | { kind: 'floating'; tag: string }
  | { kind: 'digest' }
  | { kind: 'foreign'; repository: string };

export function classifyHubImage(reference: string): HubImageChannel {
  const ref = parseImageReference(reference);
  if (ref.repository !== HUB_STACK_IMAGE_REPO && ref.repository !== LEGACY_HUB_STACK_IMAGE_REPO) {
    return { kind: 'foreign', repository: ref.repository };
  }
  if (ref.digest) {
    return { kind: 'digest' };
  }
  if (ref.tag && isHubVersionTag(ref.tag)) {
    return { kind: 'pin', version: ref.tag.replace(/^v/i, '') };
  }
  return { kind: 'floating', tag: ref.tag ?? 'latest' };
}

function describeChannel(channel: HubImageChannel): string {
  switch (channel.kind) {
    case 'pin':
      return `release pin ${channel.version}`;
    case 'floating':
      return `the floating '${channel.tag}' tag`;
    case 'digest':
      return 'an image digest';
    case 'foreign':
      return `an image outside the Hub release repository (${channel.repository})`;
  }
}

export interface RunningHubBuild {
  /** Container name without Docker's leading `/`: `ci-hub`, or `ci-os-hub` on the legacy topology. */
  container: string;
  /** `Config.Image`: the reference compose created the container from. */
  reference: string;
  channel: HubImageChannel;
  /** The release this build is, only when something other than the env file proves it. */
  version: string | null;
  /** `org.opencontainers.image.revision`: the commit, which a `dev` build has and a version lacks. */
  revision: string | null;
}

const OCI_VERSION_LABEL = 'org.opencontainers.image.version';
const OCI_REVISION_LABEL = 'org.opencontainers.image.revision';

/**
 * The build this container runs, from its image, never from `CI_HUB_VERSION`.
 *
 * The OCI version label alone is not enough today: `docker/metadata-action` stamps the FIRST tag it
 * is given, and build-container.yml listed the channel tag first, so the published `0.2.71` image
 * says `org.opencontainers.image.version=latest` (checked against GHCR, 2026-09-17). Hence three
 * sources in order: a version tag in the reference itself, a version-shaped label (release builds
 * after that workflow fix), and a version tag Docker holds for the same image ID (`:latest` pulled
 * alongside `:0.2.71`). A `dev` build matches none, and `null` is the true answer for it.
 */
export function resolveRunningHubBuild(container: DockerContainerInspect, image: DockerImageInspect | null): RunningHubBuild {
  const reference = container.Config?.Image?.trim() || container.Image?.trim() || '';
  const labels = container.Config?.Labels ?? {};
  const channel = classifyHubImage(reference);
  const label = (key: string): string | null => {
    const value = labels[key]?.trim();
    return value ? value : null;
  };

  let version: string | null = channel.kind === 'pin' ? channel.version : null;
  const labelVersion = label(OCI_VERSION_LABEL);
  if (!version && labelVersion && isHubVersionTag(labelVersion)) {
    version = labelVersion.replace(/^v/i, '');
  }
  if (!version) {
    const tagged = (image?.RepoTags ?? [])
      .map((tag) => classifyHubImage(tag))
      .flatMap((tagChannel) => (tagChannel.kind === 'pin' && semver.valid(tagChannel.version) ? [tagChannel.version] : []))
      .sort(semver.rcompare);
    version = tagged[0] ?? null;
  }

  return {
    container: (container.Name ?? '').replace(/^\//, ''),
    reference,
    channel,
    version,
    revision: label(OCI_REVISION_LABEL),
  };
}

/** What `current` should say: the release when it is known, otherwise the tag and commit actually running. */
export function describeRunningBuild(build: RunningHubBuild): string {
  if (build.version) return build.version;
  const commit = build.revision ? `@${build.revision.slice(0, 9)}` : '';
  switch (build.channel.kind) {
    case 'floating':
      return `${build.channel.tag}${commit}`;
    case 'digest':
      return `digest${commit}`;
    case 'foreign':
      return `${build.reference}${commit}`;
    default:
      return build.reference;
  }
}

/**
 * Why the self-updater must leave this node alone, or null when it may move it to another release.
 *
 * Both the running image and the declared `CI_HUB_IMAGE` have to be release pins. The running image
 * alone would miss an operator who has just switched the env file to `:dev` and not recreated yet;
 * the env file alone is exactly the source that was wrong on 10 of 16 Hubs. There is no override on
 * purpose: moving a node between channels is the operator's edit to `CI_HUB_IMAGE`, not something an
 * update button or a timer infers.
 */
export function channelUpdateRefusal(build: RunningHubBuild, declaredImage: string | null): string | null {
  if (build.channel.kind !== 'pin') {
    return `This Hub runs ${build.reference || 'an unidentified image'} (${describeChannel(build.channel)}), so the self-updater will not move it to a release. To change release lines, set CI_HUB_IMAGE in the Hub env file and recreate the Hub.`;
  }
  const declared = declaredImage?.trim();
  if (declared) {
    const declaredChannel = classifyHubImage(declared);
    if (declaredChannel.kind !== 'pin') {
      return `The Hub env file sets CI_HUB_IMAGE=${declared} (${describeChannel(declaredChannel)}), so the self-updater will not replace it with a release pin.`;
    }
  }
  return null;
}

/**
 * The newest release above `currentVersion`, or null. A stable pin never auto-advances onto a
 * pre-release; a pre-release pin may move to a newer pre-release or to the release itself.
 */
export function selectReleaseTarget(currentVersion: string, tags: readonly string[]): string | null {
  const current = semver.valid(currentVersion);
  if (!current) return null;
  const allowPrerelease = semver.prerelease(current) !== null;
  const candidates = tags
    .filter((tag) => isHubVersionTag(tag) && !/^v/i.test(tag) && semver.valid(tag) !== null)
    .filter((tag) => semver.gt(tag, current) && (allowPrerelease || semver.prerelease(tag) === null))
    .sort(semver.rcompare);
  return candidates[0] ?? null;
}

/** Everything the updater container needs to recreate the Hub the way compose created it. */
export interface ComposeUpdatePlan {
  container: string;
  project: string;
  /** `com.docker.compose.service`: `ci-hub`, or `ci-os-hub` on core-4's legacy compose file. */
  service: string;
  workingDir: string;
  configFiles: string[];
  envFiles: string[];
  /** Host path bound at the Hub's `/data/.env`. Becomes `ENV_FILE`, which feeds both `env_file` and that bind. */
  envFileHost: string;
  /** Host path bound at the Hub's `/data/docker-compose.yml`, which `COMPOSE_FILE_HOST` feeds. */
  composeFileHost: string | null;
  /** Host paths the updater container binds at the SAME path, so compose reads them where the daemon will look. */
  mirrorPaths: string[];
}

export type ComposeUpdatePlanResult = { ok: true; plan: ComposeUpdatePlan } | { ok: false; reason: string };

const COMPOSE_LABEL = {
  project: 'com.docker.compose.project',
  service: 'com.docker.compose.service',
  workingDir: 'com.docker.compose.project.working_dir',
  configFiles: 'com.docker.compose.project.config_files',
  envFile: 'com.docker.compose.project.environment_file',
} as const;

/**
 * Directories the updater image itself runs from. Binding a host path over one of them would replace
 * `sh` or the docker CLI underneath the script that needs them.
 */
const RESERVED_HELPER_ROOTS = ['/', '/bin', '/sbin', '/usr', '/lib', '/etc', '/proc', '/sys', '/dev', '/app', '/tmp'];

function splitPathLabel(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && entry !== '<no value>');
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`);
}

/**
 * The compose invocation that created this Hub, in host paths, or the reason it cannot be reproduced.
 *
 * Labels record paths as the compose CLIENT saw them. A stack started on the host records host paths
 * (every fleet node on 2026-09-17); one recreated by an older in-container updater recorded
 * `/data/docker-compose.yml` and `/data/.env`. A label path that sits under one of the Hub's own bind
 * destinations is therefore translated through that bind; anything else already is a host path.
 *
 * Refusing is the safe answer to every ambiguity here, because the failure it replaces was not a
 * clean error: it was a half-recreated stack on core-4 and a Hub without its secrets on core-6.
 */
export function resolveComposeUpdatePlan(
  container: DockerContainerInspect,
  mountTargets: { envFile: string; composeFile: string },
): ComposeUpdatePlanResult {
  const labels = container.Config?.Labels ?? {};
  const name = (container.Name ?? '').replace(/^\//, '');
  const project = labels[COMPOSE_LABEL.project]?.trim();
  const service = labels[COMPOSE_LABEL.service]?.trim();
  if (!project || !service) {
    return {
      ok: false,
      reason: `The Hub container ${name || '(unnamed)'} has no docker compose project or service label, so the updater cannot tell how to recreate it. Update it from the host that started it.`,
    };
  }

  const binds = (container.Mounts ?? []).filter(
    (mount): mount is { Type: string; Source: string; Destination: string } =>
      mount.Type === 'bind' && typeof mount.Source === 'string' && typeof mount.Destination === 'string',
  );
  const toHostPath = (value: string): string => {
    const bind = binds.filter((candidate) => isWithin(value, candidate.Destination)).sort((a, b) => b.Destination.length - a.Destination.length)[0];
    return bind ? bind.Source + value.slice(bind.Destination.length) : value;
  };

  const configFiles = splitPathLabel(labels[COMPOSE_LABEL.configFiles]).map(toHostPath);
  const firstConfigFile = configFiles[0];
  if (firstConfigFile === undefined) {
    return { ok: false, reason: `The Hub container ${name} does not record which compose files created it (${COMPOSE_LABEL.configFiles}).` };
  }
  const workingDirLabel = labels[COMPOSE_LABEL.workingDir]?.trim();
  const workingDir = workingDirLabel ? toHostPath(workingDirLabel) : path.posix.dirname(firstConfigFile);

  const envBind = binds.find((bind) => bind.Destination === mountTargets.envFile);
  if (!envBind) {
    return {
      ok: false,
      reason: `The Hub container ${name} has no bind mount at ${mountTargets.envFile}, so the updater cannot record the new version in the env file compose reads.`,
    };
  }
  const labelEnvFiles = splitPathLabel(labels[COMPOSE_LABEL.envFile]).map(toHostPath);
  const envFiles = labelEnvFiles.length > 0 ? labelEnvFiles : [envBind.Source];
  // The new pin is written through the Hub's own /data/.env. If compose interpolates from a different
  // file, the recreate would run on the new image while that file still names the old one, and the
  // next `cihub up` or desktop start would quietly roll the node back.
  if (envFiles.length !== 1 || envFiles[0] !== envBind.Source) {
    return {
      ok: false,
      reason: `Compose started this Hub with --env-file ${envFiles.join(', ')}, but the Hub's ${mountTargets.envFile} is ${envBind.Source}. The updater can only pin the new version in the file it has mounted, so update this node from the host.`,
    };
  }
  const composeBind = binds.find((bind) => bind.Destination === mountTargets.composeFile);

  const hostPaths = [workingDir, ...configFiles, ...envFiles];
  for (const hostPath of hostPaths) {
    // `--mount` is comma-separated and the script single-quotes values; a Windows path cannot be
    // mirrored into a Linux container at all. The desktop's host listener updates those installs.
    if (!hostPath.startsWith('/') || /[,"\\\r\n]/.test(hostPath)) {
      return { ok: false, reason: `The compose path ${hostPath} cannot be mirrored into the updater container. Update this node from the host.` };
    }
    const reserved = RESERVED_HELPER_ROOTS.find((root) => (root === '/' ? hostPath === '/' : isWithin(hostPath, root)));
    if (reserved) {
      return { ok: false, reason: `The compose path ${hostPath} is inside ${reserved}, which the updater container needs for itself.` };
    }
    const overlap = (container.Mounts ?? []).find(
      (mount) => typeof mount.Destination === 'string' && (isWithin(hostPath, mount.Destination) || isWithin(mount.Destination, hostPath)),
    );
    if (overlap) {
      return {
        ok: false,
        reason: `The compose path ${hostPath} overlaps the Hub's own mount at ${overlap.Destination}, so it cannot be mirrored into the updater container.`,
      };
    }
  }

  // Files inside the working directory come along with it.
  const mirrorPaths = [...new Set(hostPaths)].filter((candidate) => candidate === workingDir || !isWithin(candidate, workingDir));

  return {
    ok: true,
    plan: {
      container: name,
      project,
      service,
      workingDir,
      configFiles,
      envFiles,
      envFileHost: envBind.Source,
      composeFileHost: composeBind?.Source ?? null,
      mirrorPaths,
    },
  };
}

/** Value of `KEY=value` in env-file text, unquoted. Null when the key is absent. */
export function readEnvFileValue(content: string, key: string): string | null {
  let value: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match?.[1] !== key) continue;
    const raw = (match[2] ?? '').trim();
    value = /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
  }
  return value;
}
