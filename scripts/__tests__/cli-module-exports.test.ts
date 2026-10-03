import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findComposeName } from '../lib/cli-doctor';

/**
 * Guards a bug class the `refactor(cli): split cihub-cli.ts into per-command modules` commit could
 * introduce and nothing else catches: a helper that was module-local before the split gets imported
 * by a sibling without gaining an `export`.
 *
 * Nothing here is typechecked in CI — `turbo run tsc` runs per package and `scripts/` is not one —
 * and tsx transpiles without checking types, so the missing export survives to runtime and the
 * import lands as `undefined`. The command then dies on `(0, mod.fn) is not a function`, a raw stack
 * trace where every neighbouring command prints a message box. That is exactly how `cihub models`
 * broke: `findComposeName` lost its `export` in the split and every `models` subcommand threw.
 */

const SCRIPTS_ROOT = resolve(import.meta.dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every name a module makes importable, including `export { a, type B, c as d }` re-export blocks. */
function exportedNames(source: string): { names: Set<string>; hasStar: boolean } {
  const names = new Set<string>();
  for (const [, name] of source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(name);
  for (const [, name] of source.matchAll(/^export\s+(?:declare\s+)?(?:const|let|var|class|type|interface|enum)\s+(\w+)/gm)) names.add(name);
  for (const [, block] of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of block.split(',')) {
      const cleaned = part.trim().replace(/^type\s+/, '');
      if (!cleaned) continue;
      names.add((cleaned.split(/\s+as\s+/).pop() ?? cleaned).trim());
    }
  }
  return { names, hasStar: /^export\s+\*/m.test(source) };
}

/** Resolve a relative specifier to a file on disk, tolerating the `.js` suffix these modules use. */
function resolveTarget(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not this shape; try the next
    }
  }
  return null;
}

describe('cross-module imports under scripts/', () => {
  it('every named import resolves to a real export in the target module', () => {
    const broken: string[] = [];
    for (const file of walk(SCRIPTS_ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const [, block, specifier] of source.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"](\.[^'"]+)['"]/gm)) {
        const target = resolveTarget(file, specifier);
        if (!target) continue;
        const { names, hasStar } = exportedNames(readFileSync(target, 'utf8'));
        if (hasStar) continue;
        for (const part of block.split(',')) {
          const name = part
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0]
            ?.trim();
          if (!name || names.has(name)) continue;
          broken.push(`${relative(SCRIPTS_ROOT, file)} imports '${name}' from ${relative(SCRIPTS_ROOT, target)}, which does not export it`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('exports findComposeName, which cli-models and cihub-cli both import', () => {
    // The specific regression: a value import, so a missing export is a runtime TypeError, not a type error.
    expect(typeof findComposeName).toBe('function');
  });
});
