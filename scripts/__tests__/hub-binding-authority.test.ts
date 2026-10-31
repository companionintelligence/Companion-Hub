import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The Hub has no authority over identity bindings (docs/security/hub-portal-trust.md): which person owns
 * a computer is decided by Portal and recorded on the box itself, and the Hub is a client of both. It never
 * reads, writes, or names a binding. That is true today by absence, and this keeps it true: nothing under
 * `packages/` may carry the file name, the service name, or the state folder of the box's identity record.
 *
 * It is a property of the code, not a security boundary: a compromised Hub controls Docker on the appliance,
 * and that reaches root, so the box still has to defend its own record.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** Lower-case on purpose: the comparison is case-insensitive. */
const FORBIDDEN = ['bindings.json', 'ci-os-identity', '/var/lib/ci-os/identity'];

/** Build output and dependencies, which are neither the Hub's code nor under review. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'target', '.turbo', '.git', 'coverage']);
const MAX_BYTES = 2 * 1024 * 1024;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : filesUnder(full);
    }
    return entry.isFile() ? [full] : [];
  });
}

/** "<file>: <how> <name>" for each forbidden name in a file's path or text under `dir`, sorted. Binary and very large files are not read. */
function findBindingAuthority(root: string, dir: string): string[] {
  const found: string[] = [];
  for (const file of filesUnder(dir)) {
    const shown = relative(root, file).split(sep).join('/');
    const lowerPath = shown.toLowerCase();
    for (const name of FORBIDDEN) {
      if (lowerPath.includes(name)) {
        found.push(`${shown}: path contains ${name}`);
      }
    }
    if (statSync(file).size > MAX_BYTES) {
      continue;
    }
    const bytes = readFileSync(file);
    if (bytes.subarray(0, 4096).includes(0)) {
      continue;
    }
    const text = bytes.toString('utf8').toLowerCase();
    for (const name of FORBIDDEN) {
      if (text.includes(name)) {
        found.push(`${shown}: text mentions ${name}`);
      }
    }
  }
  return found.sort();
}

describe('the scan for identity-binding authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-binding-authority-'));
  const put = (file: string, content: string | Buffer) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports a file named like a binding record, and a file that names the service or its state folder, in any letter case', () => {
    put('packages/backend/src/bindings.json', '{}');
    put('packages/backend/src/service.ts', "const dir = '/var/lib/ci-os/identity';\n");
    put('packages/frontend/src/page.tsx', '// calls Ci-OS-Identity over a socket\n');
    // Not reported: unrelated text, build output, dependencies, and binary files.
    put('packages/backend/src/clean.ts', "export const x = 'identity';\n");
    put('packages/backend/node_modules/pkg/bindings.json', '{}');
    put('packages/desktop/src-tauri/target/debug/note.txt', 'ci-os-identity');
    put('packages/frontend/public/logo.bin', Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from('ci-os-identity')]));

    expect(findBindingAuthority(root, join(root, 'packages'))).toEqual([
      'packages/backend/src/bindings.json: path contains bindings.json',
      'packages/backend/src/service.ts: text mentions /var/lib/ci-os/identity',
      'packages/frontend/src/page.tsx: text mentions ci-os-identity',
    ]);
  });
});

describe('the Hub', () => {
  it('has no identity-binding file, service name, or state folder anywhere under packages/', () => {
    expect(
      findBindingAuthority(REPO_ROOT, join(REPO_ROOT, 'packages')),
      'The Hub is a client of Portal and of the box, never a source of identity bindings (docs/security/hub-portal-trust.md). ' +
        'If this is deliberate, change that page and get the security review first.',
    ).toEqual([]);
    // It reads every file under packages/, which takes seconds on a busy machine.
  }, 60_000);
});
