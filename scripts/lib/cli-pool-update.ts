/**
 * `cihub pool update` — pull the published image and redeploy, without a build toolchain.
 *
 * `cihub up`/`cihub setup` always pass `--build` (see `runDockerComposeUp` in cli-lifecycle.ts),
 * which is right for `local` (source dev, no `image:` to pull) and wrong for every other
 * environment now that CI publishes `ghcr.io/companionintelligence/ci-hub:<env>` on every merge
 * (confirmed for `dev` 2026-09-08). A fleet node with no GitHub Packages token cannot build at
 * all — that gap is documented history (`docker save | docker load`, 497 MB, by hand, per node).
 * This command is deliberately narrow instead of changing that shared path: pull, redeploy,
 * verify. It never builds and never touches the git checkout beyond a fast-forward it is certain
 * cannot lose anything.
 */
import { buildComposeBaseArgs } from './hub-context.js';
import { runCapture } from './cli-proc.js';

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

/** `docker compose ... pull` / `... up -d --remove-orphans`, sharing the same base args as every other lifecycle command. */
export function buildPoolUpdateComposeArgs(envFileName: string, composeFiles: string[]): { pullArgs: string[]; upArgs: string[] } {
  const base = buildComposeBaseArgs(envFileName, composeFiles);
  return {
    pullArgs: [...base, 'pull'],
    upArgs: [...base, 'up', '-d', '--remove-orphans'],
  };
}
