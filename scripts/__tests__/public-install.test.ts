/**
 * A fresh clone must `pnpm install` with no credentials. GitHub Packages' npm registry demands a
 * token even for a public package, so one dependency served from it locks every outside
 * contributor out at step one. The CI-Common packages the brand checks need live in
 * tools/ci-common, a separate opt-in install; the workspace itself must never reach that registry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const GITHUB_PACKAGES = 'npm.pkg.github.com';

describe('workspace installs without a registry token', () => {
  it('pnpm-lock.yaml resolves nothing from GitHub Packages', () => {
    const lock = fs.readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf-8');
    const hits = lock.split('\n').filter((line) => line.includes(GITHUB_PACKAGES));
    expect(hits).toEqual([]);
  });

  it('no root .npmrc routes a scope to GitHub Packages or reads a token', () => {
    const npmrc = path.join(repoRoot, '.npmrc');
    const content = fs.existsSync(npmrc) ? fs.readFileSync(npmrc, 'utf-8') : '';
    expect(content).not.toContain(GITHUB_PACKAGES);
    expect(content).not.toContain('_authToken');
  });

  it('the frontend imports the committed token copy, not the package', () => {
    const globals = fs.readFileSync(path.join(repoRoot, 'packages/frontend/src/styles/globals.css'), 'utf-8');
    expect(globals).toContain("@import './ci-tokens.css';");
    expect(globals).not.toMatch(/@import\s+['"]@companionintelligence\//);
  });
});
