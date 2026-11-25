/**
 * The runner stage of the Dockerfile installs the backend's native and runtime-loaded packages with
 * npm, outside the pnpm lockfile. Unpinned, they ran at whatever version npm had on the day of the
 * build. Each must be pinned to an exact version, and to the one version pnpm-lock.yaml resolves.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

/** The `name@version` arguments of the runner stage's `npm install --no-save` line. */
function runtimeInstallArgs(dockerfile: string): string[] {
  const line = dockerfile.split('\n').find((text) => /^\s*npm install --no-save\b/.test(text));
  if (!line) {
    throw new Error('the Dockerfile has no `npm install --no-save` line');
  }
  return line
    .trim()
    .split(/\s+/)
    .slice(2)
    .filter((arg) => !arg.startsWith('-'));
}

/** `name@version` split at the version's `@`, which a scoped name's leading `@` is not. */
function splitSpec(spec: string): { name: string; version: string | null } {
  const at = spec.lastIndexOf('@');
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: null };
}

/** Every version pnpm-lock.yaml's `packages:` section resolves for `name`. */
function lockedVersions(lockfile: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const found = new Set<string>();
  for (const match of lockfile.matchAll(new RegExp(`^ {2}'?${escaped}@(\\d[^(':]*)`, 'gm'))) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

describe('Dockerfile runtime npm install', () => {
  const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');
  const lockfile = readFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  const specs = runtimeInstallArgs(dockerfile).map(splitSpec);

  it('installs something', () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  it.each(specs.map((spec) => [spec.name, spec]))('pins %s to the one version pnpm-lock.yaml resolves', (_name, spec) => {
    expect(spec.version, `${spec.name} has no exact version`).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    const locked = lockedVersions(lockfile, spec.name);
    expect(locked, `pnpm-lock.yaml resolves ${spec.name} to ${locked.join(', ') || 'nothing'}`).toEqual([spec.version]);
  });

  // It runs with the Sentry auth token in its environment.
  it('runs the Sentry CLI at an exact version', () => {
    const uses = [...dockerfile.matchAll(/@sentry\/cli@(\S+)/g)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const used of uses) {
      expect(used).toBe('${SENTRY_CLI_VERSION}');
    }
    expect(dockerfile).toMatch(/^ARG SENTRY_CLI_VERSION=\d+\.\d+\.\d+$/m);
  });
});
