/**
 * A third-party action named by a tag runs whatever its owner points the tag at next, with the
 * job's token and secrets: the signing credentials, the R2 token, the registry passwords. Each is
 * pinned to a full commit SHA, with the tag it was taken from as a comment. GitHub's own actions
 * (`actions/*`, `github/*`) and this repository's (`./`) are left as they are.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function workflowFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return workflowFiles(full);
    return /\.ya?ml$/.test(entry.name) ? [full] : [];
  });
}

const uses = [...workflowFiles(path.join(repoRoot, '.github/workflows')), ...workflowFiles(path.join(repoRoot, '.github/actions'))].flatMap((file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.match(/^\s*(?:-\s+)?uses:\s*['"]?([^\s'"]+)/)?.[1])
    .filter((ref): ref is string => Boolean(ref))
    .map((ref) => ({ file: path.relative(repoRoot, file), ref })),
);

const thirdParty = uses.filter(({ ref }) => !ref.startsWith('./') && !/^(actions|github)\//.test(ref) && !ref.startsWith('docker://'));

describe('third-party GitHub Actions', () => {
  it('are found', () => {
    expect(thirdParty.length).toBeGreaterThan(0);
  });

  it('are each pinned to a full commit SHA', () => {
    const unpinned = thirdParty.filter(({ ref }) => !/@[0-9a-f]{40}$/.test(ref)).map(({ file, ref }) => `${file}: ${ref}`);
    expect(unpinned).toEqual([]);
  });
});
