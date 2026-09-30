/**
 * Guards the build-time values vite.config.ts bakes into the frontend bundle.
 *
 * `pnpm run build` and `pnpm run bundle` run through turbo, which hands a task only the environment
 * variables turbo.json declares for it. The Dockerfile set CI_HUB_VERSION and CI_HUB_ENVIRONMENT, turbo
 * dropped both, and release images shipped a page with no version that asked the test download server
 * for desktop updates (#1692). Nothing failed; the values were just empty.
 *
 * This asks turbo itself, through a dry run, instead of re-reading turbo.json, so turbo's own rules
 * decide: per-package task entries, and the `VITE_*` variables it passes to a Vite package unasked.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const turboBin = path.join(repoRoot, 'node_modules/turbo/bin/turbo');
const viteConfig = fs.readFileSync(path.join(repoRoot, 'packages/frontend/vite.config.ts'), 'utf-8');

/** Both run the frontend's Vite build into `dist/`. The Dockerfile runs `bundle` after `build`, so the image ships what `bundle` baked. */
const FRONTEND_BUILD_TASKS = ['frontend#build', 'frontend#bundle'];

/** Each `define` key `import.meta.env.NAME` is fed by the build-time variable of the same name. */
const bakedNames = [...viteConfig.matchAll(/['"]import\.meta\.env\.([A-Z][A-Z0-9_]*)['"]\s*:/g)].flatMap((match) => (match[1] ? [match[1]] : []));

interface TurboEnvironment {
  /** `NAME=hash` for each variable turbo.json declares that is set. */
  configured: string[];
  /** `NAME=hash` for each variable turbo adds on its own, such as `VITE_*` for a Vite package. */
  inferred: string[];
}

interface TurboDryRun {
  globalCacheInputs: { environmentVariables: TurboEnvironment };
  /** `inputs` maps each hashed file, relative to the package, to its hash. */
  tasks: { taskId: string; environmentVariables: TurboEnvironment; inputs: Record<string, string> }[];
}

/**
 * Variables turbo both hands to a task and puts in its cache key. Handing one over without hashing it
 * (`passThroughEnv`) is not enough: turbo would then replay a bundle baked with another version.
 */
function hashedNames(environment: TurboEnvironment): string[] {
  return [...environment.configured, ...environment.inferred].map((entry) => entry.slice(0, entry.indexOf('=')));
}

describe('turbo hands the frontend build every variable vite.config.ts bakes in', () => {
  let dryRun: TurboDryRun;

  beforeAll(() => {
    // turbo only lists the variables that are set, so each one gets a value.
    const env: Record<string, string | undefined> = { ...process.env, TURBO_TELEMETRY_DISABLED: '1' };
    for (const name of bakedNames) env[name] = `probe-${name}`;
    const output = execFileSync(process.execPath, [turboBin, 'run', 'build', 'bundle', '--filter=frontend', '--dry=json'], {
      cwd: repoRoot,
      env,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    dryRun = JSON.parse(output) as TurboDryRun;
  });

  it('finds the define entries it guards', () => {
    // A pattern that stopped matching would let every check below pass on an empty list.
    expect(bakedNames).toEqual(expect.arrayContaining(['CI_CLOUD_URL', 'CI_HUB_VERSION', 'CI_HUB_ENVIRONMENT']));
  });

  it.each(FRONTEND_BUILD_TASKS)('%s gets each of them, in its cache key', (taskId) => {
    const task = dryRun.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) throw new Error(`${taskId} is missing from the turbo dry run`);
    const hashed = new Set([...hashedNames(dryRun.globalCacheInputs.environmentVariables), ...hashedNames(task.environmentVariables)]);
    expect(
      bakedNames.filter((name) => !hashed.has(name)),
      `declare these under "env" for ${taskId} in turbo.json`,
    ).toEqual([]);
  });

  // vite.config.ts also reads these variables from the env files at the repo root. A package-relative
  // `.env*` input never matches them, so a changed root file would replay a bundle baked from the old one.
  it.each(FRONTEND_BUILD_TASKS)("%s hashes the repo root's env files", (taskId) => {
    const task = dryRun.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) throw new Error(`${taskId} is missing from the turbo dry run`);
    expect(Object.keys(task.inputs)).toContain('../../.env.example');
  });
});
