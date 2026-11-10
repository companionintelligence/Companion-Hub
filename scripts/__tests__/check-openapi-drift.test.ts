/**
 * `check:openapi` ran `pnpm gen:swagger`, which writes the tracked swagger.json, and only then compared.
 * A drifted tree failed the check and was left rewritten, so the evidence was gone and the tree dirty.
 *
 * The script runs for real from a copy in a temp repo, with a fake `pnpm` first on PATH. Like the real
 * generator, the fake writes to `CI_HUB_SWAGGER_OUT` when it is set and to the tracked file when not.
 * Its `gen:api-client` writes nothing, which matches the temp repo's empty client folder.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../check-openapi-drift.cjs');
const trackedSwagger = 'packages/backend/src/swagger.json';

const fakePnpm = `#!/bin/sh
case "$*" in
  *gen:swagger*)
    [ -n "$FAKE_SWAGGER_FAIL" ] && exit 1
    printf '%s' "$FAKE_SWAGGER" > "\${CI_HUB_SWAGGER_OUT:-${trackedSwagger}}"
    ;;
esac
`;

// The fake is a shell script.
describe.skipIf(process.platform === 'win32')('check-openapi-drift', () => {
  let root: string;
  let repo: string;
  let bin: string;
  let temp: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cihub-openapi-drift-'));
    repo = path.join(root, 'repo');
    bin = path.join(root, 'bin');
    temp = path.join(root, 'tmp');
    for (const dir of [
      bin,
      temp,
      path.join(repo, 'scripts'),
      path.join(repo, 'packages/backend/src'),
      path.join(repo, 'packages/frontend/src/api-client'),
    ])
      mkdirSync(dir, { recursive: true });
    copyFileSync(script, path.join(repo, 'scripts/check-openapi-drift.cjs'));
    writeFileSync(path.join(bin, 'pnpm'), fakePnpm);
    chmodSync(path.join(bin, 'pnpm'), 0o755);
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (committed: string, env: Record<string, string>) => {
    writeFileSync(path.join(repo, trackedSwagger), committed);
    return spawnSync(process.execPath, [path.join(repo, 'scripts/check-openapi-drift.cjs')], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: temp, ...env },
    });
  };

  const tracked = () => readFileSync(path.join(repo, trackedSwagger), 'utf8');

  it('fails on a drifted swagger.json and leaves the committed file as it was', () => {
    const result = run('{"hand":"edit"}\n', { FAKE_SWAGGER: '{"generated":true}\n' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/backend/src/swagger.json is out of date. Run pnpm gen:swagger and commit.');
    expect(tracked()).toBe('{"hand":"edit"}\n');
    expect(readdirSync(temp)).toEqual([]);
  });

  it('passes on a matching swagger.json without leaving a temp folder', () => {
    const result = run('{"generated":true}\n', { FAKE_SWAGGER: '{"generated":true}\n' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('openapi drift check passed');
    expect(tracked()).toBe('{"generated":true}\n');
    expect(readdirSync(temp)).toEqual([]);
  });

  it('says so when gen:swagger fails, and leaves the committed file as it was', () => {
    const result = run('{"hand":"edit"}\n', { FAKE_SWAGGER_FAIL: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('openapi drift: pnpm gen:swagger failed');
    expect(tracked()).toBe('{"hand":"edit"}\n');
    expect(readdirSync(temp)).toEqual([]);
  });
});
