/**
 * `cihub pool update` — pull the published image and redeploy, without a build toolchain.
 *
 * `cihub up`/`cihub setup` always pass `--build` (see `runDockerComposeUp` in cli-lifecycle.ts),
 * which is right for `local` (source dev, no `image:` to pull). `getComposeFiles` (cli-compose-env.ts)
 * now layers `docker-compose.dev-image.yml` onto `dev`/`staging`/`prod` alike whenever the matching
 * env file sets `CI_HUB_IMAGE`, so a node that has pinned that var already gets a pull instead of a
 * from-source build. This command covers what that doesn't: a fleet node with `CI_HUB_IMAGE` unset
 * entirely, which still falls back to building — something a node with no GitHub Packages token
 * cannot do at all (that gap is documented history: `docker save | docker load`, 497 MB, by hand,
 * per node). It never builds and never touches the git checkout beyond a fast-forward it is certain
 * cannot lose anything.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildComposeBaseArgs } from './hub-context.js';
import { composeArgsFromIdentity, type ComposeIdentity } from './compose-discovery.js';
import { runCapture } from './cli-proc.js';
import type { HubEnv } from './cli-types.js';

/**
 * The one compose file this whole command exists to route around: `docker-compose.prod.yml`
 * declares the `ci-hub` service `build:`-only, no `image:` at all, so `docker compose pull` has
 * nothing to fetch and `up` falls back to a from-source build. `getComposeFiles` (cli-compose-env.ts)
 * already layers `docker-compose.dev-image.yml` for this when the env file sets `CI_HUB_IMAGE`, but
 * a fleet node running `prod` with that var unset has nothing to key off. This overlay is
 * env-agnostic and always applied so `pool update` gets a pull path regardless of whether
 * `CI_HUB_IMAGE` is set, defaulting the tag to the env being updated (see `resolvePoolUpdateImage`).
 */
const PULL_IMAGE_OVERLAY = 'docker-compose.pull-image.yml';

export interface GitUpdateFacts {
  /** False outside a git checkout entirely, e.g. a pure appliance install. */
  isRepo: boolean;
  /** Null when detached HEAD. */
  branch: string | null;
  /** True on any uncommitted change, staged or not, tracked or not — `git status --porcelain` non-empty. */
  dirty: boolean;
}

export type GitUpdateDecision = { action: 'pull' } | { action: 'skip'; reason: string };

/**
 * Pure decision: given the facts, is a fast-forward pull of `dev` certain to be lossless?
 *
 * Deliberately conservative — this only ever fast-forwards a clean checkout that is already on
 * `dev`. Anything else (dirty tree, a feature branch, no repo at all) is left alone and reported,
 * never reset or stashed on the operator's behalf: CLAUDE.md's multi-agent safety rule is a hard
 * "never without explicit confirmation" for any destructive git command, and there is no way for
 * this command to tell "safe to discard" from "the operator's in-progress work" from here.
 */
export function decideGitUpdate(facts: GitUpdateFacts): GitUpdateDecision {
  if (!facts.isRepo) return { action: 'skip', reason: 'not a git checkout — nothing to update here' };
  if (facts.dirty) {
    return {
      action: 'skip',
      reason: 'working tree has uncommitted changes — commit, stash, or discard them yourself first so a pull cannot lose anything',
    };
  }
  if (facts.branch !== 'dev') {
    return {
      action: 'skip',
      reason: `on branch '${facts.branch ?? '(detached HEAD)'}', not dev — switch manually if you want this checkout tracking dev`,
    };
  }
  return { action: 'pull' };
}

/** Impure half: reads the facts `decideGitUpdate` needs, from whatever directory the CLI is running in. */
export function gatherGitUpdateFacts(cwd: string = process.cwd()): GitUpdateFacts {
  const isRepo = runCapture('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']).ok;
  if (!isRepo) return { isRepo: false, branch: null, dirty: false };
  const branch = runCapture('git', ['-C', cwd, 'branch', '--show-current']).stdout || null;
  const dirty = runCapture('git', ['-C', cwd, 'status', '--porcelain']).stdout !== '';
  return { isRepo: true, branch, dirty };
}

/**
 * Append the pull-image overlay when it is actually reachable from `cwd` — a bare relative
 * filename, same convention `getComposeFiles` uses for every other compose file, so it resolves
 * correctly for a checkout run from its own root. An appliance install's data dir has its own
 * *seeded copies* of the base compose files and never this one, so absence here is expected on
 * that path, not an error: skip it and let the caller report why, rather than handing `docker
 * compose` a `-f` argument that does not exist.
 */
export function composeFilesForPoolUpdate(cwd: string, baseComposeFiles: string[]): { files: string[]; overlayApplied: boolean } {
  if (!existsSync(path.join(cwd, PULL_IMAGE_OVERLAY))) return { files: baseComposeFiles, overlayApplied: false };
  return { files: [...baseComposeFiles, PULL_IMAGE_OVERLAY], overlayApplied: true };
}

/**
 * The image the overlay pulls. Respects an operator-set `CI_HUB_IMAGE` (the same variable
 * `docker-compose.dev-image.yml` already reads) and otherwise defaults to the tag matching the
 * environment being updated — `ghcr.io/companionintelligence/ci-hub:dev` for `pool update dev`,
 * and so on. A fleet deliberately running `prod`-shaped compose with `dev`-tagged content (this
 * project's own test fleet does) sets `CI_HUB_IMAGE` to override the default explicitly, rather
 * than this command guessing which tag a `prod` env "really" means.
 */
export function resolvePoolUpdateImage(env: HubEnv, existingEnvValue: string | undefined): string {
  return existingEnvValue?.trim() || `ghcr.io/companionintelligence/ci-hub:${env}`;
}

/** `docker compose ... pull` / `... up -d --remove-orphans`, sharing the same base args as every other lifecycle command. */
export function buildPoolUpdateComposeArgs(
  envFileName: string,
  composeFiles: string[],
  identity: ComposeIdentity | null = null,
): { pullArgs: string[]; upArgs: string[] } {
  // Prefer the stack that is actually running over the one this checkout would have created. On a
  // machine this CLI installed the two agree and nothing changes; on a drifted one they do not, and
  // the assumptions lose in four distinct ways — see compose-discovery.ts for the measured list.
  const base = identity
    ? composeArgsFromIdentity(identity, { project: 'ci-hub', envFiles: [envFileName], configFiles: composeFiles })
    : buildComposeBaseArgs(envFileName, composeFiles);
  return {
    pullArgs: [...base, 'pull'],
    // `--no-build` because the published image IS the artifact being deployed. Two fleet nodes carry
    // a compose file with a build stanza and no npm auth token, so an update that is allowed to fall
    // back to building fails on `pnpm install --frozen-lockfile` instead of pulling the image that
    // was already built for them.
    upArgs: [...base, 'up', '-d', '--remove-orphans', '--no-build'],
  };
}
