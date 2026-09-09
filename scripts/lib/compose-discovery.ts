/**
 * What compose actually used to create the running stack — read from the stack itself.
 *
 * Every lifecycle command here builds its `docker compose` invocation from assumptions: the project
 * is named `ci-hub`, the compose files are the ones this checkout ships, the env file is
 * `.env.<env>` beside them. Those assumptions are right on a machine this CLI installed and wrong on
 * a machine that has drifted — and a fleet drifts.
 *
 * Measured while landing one backend fix across seven nodes. Updating them by hand took five
 * attempts, and each failure was a different piece of state the container knew and the command did
 * not:
 *
 *   1. the container is `ci-os-hub` on one node and `ci-hub` on six;
 *   2. one node's data dir had been renamed, so compose inferred project `companion-hub` while the
 *      stack was `ci-hub`, and `up` tried to CREATE a second container rather than replace one;
 *   3. `--env-file` was omitted, so interpolation failed with `ROOT_FOLDER_HOST is missing a value`;
 *   4. two nodes tried to BUILD from source and failed on an npm auth token they do not hold;
 *   5. the published image is supplied by an overlay whose path the container's own config_files
 *      label does not record.
 *
 * Docker records the first four on the container as `com.docker.compose.*` labels. Reading them is
 * strictly better than guessing, because it describes the stack that exists rather than the one this
 * checkout would have made.
 */

import { runCapture } from './cli-proc.js';

/** The compose invocation that created a running container. Every field may be absent on a stack created by hand. */
export interface ComposeIdentity {
  /** Container name we found, e.g. `ci-hub` or `ci-os-hub`. */
  container: string;
  /** `-p` value. Without it, compose infers one from the directory name and can miss the stack entirely. */
  project: string | null;
  /** Absolute path compose ran from. */
  workingDir: string | null;
  /** `-f` files, in order. Order matters: later files override earlier ones. */
  configFiles: string[];
  /** `--env-file` paths. Omitting these is what produces "required variable ... is missing a value". */
  envFiles: string[];
}

/** Container names this project has shipped, newest first. Both are in the field today. */
export const HUB_CONTAINER_NAMES = ['ci-hub', 'ci-os-hub'] as const;

const LABEL = {
  project: 'com.docker.compose.project',
  workingDir: 'com.docker.compose.project.working_dir',
  configFiles: 'com.docker.compose.project.config_files',
  envFile: 'com.docker.compose.project.environment_file',
} as const;

/** Split a compose label that carries a comma-separated path list, dropping empties. */
export function splitLabelPaths(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read one label off a running container. Returns null for "absent", never an empty string, because
 * compose writes `<no value>` for a label it did not set and an empty string is indistinguishable
 * from a label legitimately set to nothing.
 */
export function parseLabelValue(raw: string): string | null {
  const v = raw.trim();
  if (!v || v === '<no value>') return null;
  return v;
}

/**
 * Discover the compose identity of the running Hub, or null when nothing is running.
 *
 * Deliberately tries each known container name rather than taking the first container whose name
 * merely CONTAINS "hub": a node running `ci-openclaw_ci-marketplace-ci-openclaw-1` and a
 * `hub-tailscale` sidecar would both match a substring search, and updating either would be wrong.
 */
export function discoverComposeIdentity(
  names: readonly string[] = HUB_CONTAINER_NAMES,
  exec: (cmd: string, args: string[]) => { ok: boolean; stdout: string } = (cmd, args) => runCapture(cmd, args),
): ComposeIdentity | null {
  for (const container of names) {
    const format = [LABEL.project, LABEL.workingDir, LABEL.configFiles, LABEL.envFile].map((l) => `{{index .Config.Labels "${l}"}}`).join('\n');
    const res = exec('docker', ['inspect', container, '--format', format]);
    if (!res.ok) continue;
    const [project, workingDir, configFiles, envFile] = res.stdout.split('\n').map((l) => parseLabelValue(l ?? ''));
    return {
      container,
      project: project ?? null,
      workingDir: workingDir ?? null,
      configFiles: splitLabelPaths(configFiles),
      envFiles: splitLabelPaths(envFile),
    };
  }
  return null;
}

/**
 * Compose args that target the stack that is actually running.
 *
 * Falls back to the caller's assumptions field by field rather than all-or-nothing: a stack created
 * by hand may record a project and no env file, and the half we learned is still worth using.
 */
export function composeArgsFromIdentity(
  identity: ComposeIdentity | null,
  fallback: { project: string; envFiles: string[]; configFiles: string[] },
): string[] {
  const project = identity?.project ?? fallback.project;
  const envFiles = identity?.envFiles.length ? identity.envFiles : fallback.envFiles;
  const configFiles = identity?.configFiles.length ? identity.configFiles : fallback.configFiles;
  const args = ['compose', '--project-name', project];
  for (const e of envFiles) args.push('--env-file', e);
  for (const f of configFiles) args.push('-f', f);
  return args;
}
