import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The in-tree KERI module (packages/common/src/keri) is frozen: it is not interoperable, so nothing that
 * runs for real may depend on it (see FROZEN.md in that folder). This keeps that true.
 *
 * It reads every non-test source file under `packages/<name>/src` and `scripts/` and fails on any import
 * of the module from outside its own folder, whether by package path (`@ci-hub/common/keri/...`) or by a
 * relative path that lands inside it. It lives here, and not in a package, so it also sees `scripts/`.
 * The `exports["./keri/*"]` entry stays: the tests and `tsc` resolve through it.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const KERI_DIR = join('packages', 'common', 'src', 'keri');
const KERI_PACKAGE_PATH = '@ci-hub/common/keri';

/**
 * Non-test files that may load the module, and why. Both ways are checked below: a file not listed here
 * fails, and a file listed here that no longer loads the module fails too, so the list cannot go stale.
 */
const ALLOWED: Record<string, string> = {
  'scripts/verify-keri-toip.ts': 'a standalone round-trip script that exercises the frozen module itself; it is not a consumer',
};

/** Folders that hold tests, fixtures, or build output rather than shipped source. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'target', '.turbo', '__tests__', '__mocks__', 'tests', 'test']);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec)\.[^.]+$/;

/** Every module specifier a source text loads: static imports, re-exports, `import()`, and `require()`. */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

function moduleSpecifiers(source: string): string[] {
  return SPECIFIER_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1] ?? ''));
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

/** True when `specifier`, written in `file`, loads the KERI module: by package path, or by a relative path into its folder. */
function loadsKeriModule(specifier: string, file: string, keriDir: string): boolean {
  if (specifier === KERI_PACKAGE_PATH || specifier.startsWith(`${KERI_PACKAGE_PATH}/`)) {
    return true;
  }
  return specifier.startsWith('.') && isInside(resolve(dirname(file), specifier), keriDir);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(full);
    }
    return entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) ? [full] : [];
  });
}

/** `scripts/` and each package's `src/`, as they exist under `root`. */
function scanRoots(root: string): string[] {
  const packagesDir = join(root, 'packages');
  const packageSources = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, 'src'));
  return [join(root, 'scripts'), ...packageSources].filter((dir) => existsSync(dir));
}

/** "<file> imports <specifier>" for every non-test file outside the module's own folder that loads it, sorted. */
function findKeriImports(root: string): string[] {
  const keriDir = join(root, KERI_DIR);
  const found: string[] = [];
  for (const dir of scanRoots(root)) {
    for (const file of sourceFiles(dir)) {
      if (isInside(file, keriDir)) {
        continue;
      }
      for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
        if (loadsKeriModule(specifier, file, keriDir)) {
          found.push(`${relative(root, file).split(sep).join('/')} imports ${specifier}`);
        }
      }
    }
  }
  return found.sort();
}

/** True when a "<file> imports <specifier>" entry comes from one of `files`. The space keeps `a.ts` from matching `a.tsx`. */
function isFoundIn(entry: string, files: string[]): boolean {
  return files.some((file) => entry.startsWith(`${file} `));
}

/** What the guard reports: every entry that does not come from an allowed file. */
function unexpectedImports(found: string[], allowed: string[]): string[] {
  return found.filter((entry) => !isFoundIn(entry, allowed));
}

/** The entries that come from one file. An allowed file with none no longer loads the module, so its exception is stale. */
function importsOf(found: string[], file: string): string[] {
  return found.filter((entry) => isFoundIn(entry, [file]));
}

describe('the import detector', () => {
  const keriDir = join(REPO_ROOT, KERI_DIR);
  const from = join(REPO_ROOT, 'packages', 'backend', 'src', 'service.ts');

  it.each([
    ["import { a } from '@ci-hub/common/keri/cesr';", '@ci-hub/common/keri/cesr'],
    ["import type { A } from '@ci-hub/common/keri/aid';", '@ci-hub/common/keri/aid'],
    ["import '@ci-hub/common/keri/said';", '@ci-hub/common/keri/said'],
    ["export { a } from '../packages/common/src/keri/tel';", '../packages/common/src/keri/tel'],
    ["export * from '@ci-hub/common/keri/acdc';", '@ci-hub/common/keri/acdc'],
    ["const m = await import('@ci-hub/common/keri/oobi');", '@ci-hub/common/keri/oobi'],
    ["const m = require('@ci-hub/common/keri/http-sig');", '@ci-hub/common/keri/http-sig'],
    ["import {\n  a,\n  b,\n} from '@ci-hub/common/keri/cesr';", '@ci-hub/common/keri/cesr'],
  ])('reads the specifier out of %j', (source, specifier) => {
    expect(moduleSpecifiers(source)).toContain(specifier);
  });

  it('counts the package path and a relative path into the folder, and nothing that only looks similar', () => {
    expect(loadsKeriModule('@ci-hub/common/keri', from, keriDir)).toBe(true);
    expect(loadsKeriModule('@ci-hub/common/keri/cesr', from, keriDir)).toBe(true);
    expect(loadsKeriModule('../../common/src/keri/cesr', from, keriDir)).toBe(true);
    expect(loadsKeriModule('@ci-hub/common/kerix', from, keriDir)).toBe(false);
    expect(loadsKeriModule('@ci-hub/common/schemas', from, keriDir)).toBe(false);
    expect(loadsKeriModule('./keri-notes', from, keriDir)).toBe(false);
  });
});

describe('findKeriImports on a synthetic checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'keri-import-guard-'));
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports each non-test file that loads the module and none that does not', () => {
    // The module's own folder, and tests of every kind, may load it.
    put('packages/common/src/keri/aid.ts', "import { x } from './cesr.js';\n");
    put('packages/common/src/keri/__tests__/a.test.ts', "import { x } from '../cesr.js';\n");
    put('packages/backend/src/a.test.ts', "import { x } from '@ci-hub/common/keri/cesr';\n");
    put('packages/backend/src/tests/helper.ts', "import { x } from '@ci-hub/common/keri/cesr';\n");
    put('packages/backend/src/__tests__/b.ts', "import { x } from '@ci-hub/common/keri/cesr';\n");
    put('packages/backend/src/node_modules/pkg/index.js', "require('@ci-hub/common/keri/cesr');\n");
    // Lookalikes and unrelated imports.
    put('packages/backend/src/clean.ts', "import { y } from '@ci-hub/common/schemas';\nimport { z } from '@ci-hub/common/kerix';\n");
    put('scripts/lib/ok.ts', "import { x } from './helper';\n");
    // The ways to load it from outside.
    put('packages/backend/src/service.ts', "import { x } from '@ci-hub/common/keri/cesr';\n");
    put('packages/backend/src/lazy.ts', "const m = await import('@ci-hub/common/keri/aid');\n");
    put('packages/frontend/src/deep/view.tsx', "import { x } from '@ci-hub/common/keri/oobi';\n");
    put('packages/common/src/other.ts', "import { x } from './keri/cesr.js';\n");
    put('scripts/tool.ts', "import { x } from '../packages/common/src/keri/cesr';\n");

    expect(findKeriImports(root)).toEqual([
      'packages/backend/src/lazy.ts imports @ci-hub/common/keri/aid',
      'packages/backend/src/service.ts imports @ci-hub/common/keri/cesr',
      'packages/common/src/other.ts imports ./keri/cesr.js',
      'packages/frontend/src/deep/view.tsx imports @ci-hub/common/keri/oobi',
      'scripts/tool.ts imports ../packages/common/src/keri/cesr',
    ]);
  });

  it('lets an allowed file through and still reports any other file that loads the module', () => {
    // A checkout of its own, one folder down, so the files above do not count.
    const checkout = join(root, 'allowed');
    put('allowed/scripts/verify-keri-toip.ts', "import { a } from '../packages/common/src/keri/aid';\n");
    put('allowed/packages/backend/src/service.ts', "import { x } from '@ci-hub/common/keri/cesr';\n");

    const found = findKeriImports(checkout);

    expect(found).toHaveLength(2);
    expect(unexpectedImports(found, ['scripts/verify-keri-toip.ts'])).toEqual(['packages/backend/src/service.ts imports @ci-hub/common/keri/cesr']);
    expect(importsOf(found, 'scripts/verify-keri-toip.ts')).toEqual(['scripts/verify-keri-toip.ts imports ../packages/common/src/keri/aid']);
  });
});

describe('the allow-list filter', () => {
  const found = [
    'packages/backend/src/service.ts imports @ci-hub/common/keri/cesr',
    'scripts/verify-keri-toip.ts imports ../packages/common/src/keri/aid',
    'scripts/verify-keri-toip.ts imports ../packages/common/src/keri/tel',
    // A file whose name only starts like the allowed one.
    'scripts/verify-keri-toip.tsx imports @ci-hub/common/keri/oobi',
  ];

  it('removes every entry of an allowed file and nothing else', () => {
    expect(unexpectedImports(found, ['scripts/verify-keri-toip.ts'])).toEqual([
      'packages/backend/src/service.ts imports @ci-hub/common/keri/cesr',
      'scripts/verify-keri-toip.tsx imports @ci-hub/common/keri/oobi',
    ]);
  });

  it('removes nothing when nothing is allowed', () => {
    expect(unexpectedImports(found, [])).toEqual(found);
  });

  it('removes everything when every file is allowed', () => {
    const everyFile = ['packages/backend/src/service.ts', 'scripts/verify-keri-toip.ts', 'scripts/verify-keri-toip.tsx'];
    expect(unexpectedImports(found, everyFile)).toEqual([]);
  });

  it('finds the entries of one file, none for a file that loads nothing, and none for a name that is only a prefix', () => {
    expect(importsOf(found, 'scripts/verify-keri-toip.ts')).toEqual([
      'scripts/verify-keri-toip.ts imports ../packages/common/src/keri/aid',
      'scripts/verify-keri-toip.ts imports ../packages/common/src/keri/tel',
    ]);
    expect(importsOf(found, 'scripts/gone.ts')).toEqual([]);
    expect(importsOf(found, 'scripts/verify-keri-toip')).toEqual([]);
  });
});

describe('the repository', () => {
  let found: string[] = [];

  beforeAll(() => {
    found = findKeriImports(REPO_ROOT);
  });

  it('has no non-test source that imports the frozen KERI module', () => {
    expect(
      unexpectedImports(found, Object.keys(ALLOWED)),
      'The KERI module is frozen and not interoperable (packages/common/src/keri/FROZEN.md): do not import it. ' +
        'Unfreezing is a reviewed change, not an edit to this list.',
    ).toEqual([]);
  });

  it('lists only exceptions that exist and still load the module', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(importsOf(found, file).length, `${file} (${reason}) no longer loads the module: remove it from ALLOWED`).toBeGreaterThan(0);
    }
  });
});
