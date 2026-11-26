/**
 * An action named by a tag runs whatever its owner points the tag at next, with the job's token and
 * secrets: the signing credentials, the R2 token, the registry passwords. Each is pinned to a full
 * commit SHA, with the release it was taken from as a comment. GitHub's own actions (`actions/*`,
 * `github/*`) too: a smaller risk than a third party's, but a tag of theirs moves just the same.
 * Only this repository's own (`./`) and `docker://` images are left out.
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

const remote = uses.filter(({ ref }) => !ref.startsWith('./') && !ref.startsWith('docker://'));

describe('GitHub Actions from other repositories', () => {
  it("are found, GitHub's own among them", () => {
    expect(remote.length).toBeGreaterThan(0);
    expect(remote.some(({ ref }) => /^(actions|github)\//.test(ref))).toBe(true);
  });

  it('are each pinned to a full commit SHA', () => {
    const unpinned = remote.filter(({ ref }) => !/@[0-9a-f]{40}$/.test(ref)).map(({ file, ref }) => `${file}: ${ref}`);
    expect(unpinned).toEqual([]);
  });
});
