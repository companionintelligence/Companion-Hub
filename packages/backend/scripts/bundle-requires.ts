import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import type { Plugin } from 'esbuild';

/*
 * build.ts bundles the backend into one ESM file, /app/main.js, and the runtime image installs only
 * the handful of packages the Dockerfile's `npm install` names. Anything the bundle still looks up
 * on disk at runtime and that is not in that set crashes the Hub, so this file holds the two halves
 * that keep the bundle self-contained: a plugin that lets esbuild see the requires it would otherwise
 * miss, and a check that fails the build when one slips through anyway.
 *
 * What went wrong (NestJS 12): @nestjs/serve-static, @nestjs/mapped-types, @nestjs/terminus and
 * @nestjs/swagger ship as ESM and load optional dependencies through their OWN
 * `const require = createRequire(import.meta.url)`. esbuild only bundles calls to the free `require`;
 * a local binding of that name is an ordinary function to it, so it renamed each one (require2 …
 * require6) and left `require5("express")` as a runtime lookup. The image has no express in
 * node_modules, and the Hub crash-looped at boot with `The "express" package is missing`.
 */

/**
 * A module-level `const require = createRequire(import.meta.url)` on a line of its own, which is how
 * every package that does this writes it. Anything less regular is left alone: the bundle check
 * below catches whatever this misses.
 */
const LOCAL_CREATE_REQUIRE =
  /^([ \t]*)(?:const|let|var)[ \t]+require[ \t]*=[ \t]*(?:[\w$]+\.)?createRequire\([ \t]*import\.meta\.url[ \t]*\)[ \t]*;?[ \t]*$/gm;

/**
 * Removes a module's own `require` binding so its `require('x')` calls fall through to the free
 * `require`, which esbuild resolves and bundles exactly as it does in a CommonJS file. Returns
 * undefined when the source declares no such binding, so esbuild loads the file untouched.
 *
 * The line is replaced by a comment, not deleted, so the source map's line numbers still match.
 */
export function stripLocalCreateRequire(source: string): string | undefined {
  if (!source.includes('createRequire')) {
    return undefined;
  }
  let changed = false;
  const contents = source.replace(LOCAL_CREATE_REQUIRE, (_line, indent: string) => {
    changed = true;
    return `${indent}/* local createRequire removed by packages/backend/scripts/bundle-requires.ts so esbuild bundles these requires */`;
  });
  return changed ? contents : undefined;
}

/** esbuild plugin applying {@link stripLocalCreateRequire} to every JavaScript file under node_modules. */
export const bundleLocalRequires: Plugin = {
  name: 'bundle-local-requires',
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/].*\.m?js$/ }, async (args) => {
      const contents = stripLocalCreateRequire(await readFile(args.path, 'utf8'));
      return contents === undefined ? undefined : { contents, loader: 'js' };
    });
  },
};

/** One module the bundle will try to load from disk when the code around it runs. */
export interface RuntimeLookup {
  specifier: string;
  /** The function doing the lookup: `__require` (esbuild's shim), `require` (the banner's), `require5`, `import`. */
  via: string;
  /** 1-based line in the bundle. */
  line: number;
}

const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;
/** `require5 = createRequire5(import.meta.url)`, `const req = module.createRequire(...)`, the banner's `__createRequire`. */
const CREATE_REQUIRE_BINDING = new RegExp(String.raw`(?<![\w$.])(${IDENTIFIER})\s*=\s*(?:[\w$]+\.)?[\w$]*createRequire\d*\(`, 'g');
/** A call through esbuild's renamed copy of a local `require`, whether or not its binding was found. */
const RENAMED_REQUIRE_CALL = /(?<![\w$.])(require\d+)(?:\.resolve)?\(/g;

/** The text before a match on its line puts it inside a comment: a JSDoc line, an open block comment, or after `//`. */
function isInComment(linePrefix: string): boolean {
  return /^\s*\*/.test(linePrefix) || linePrefix.lastIndexOf('/*') > linePrefix.lastIndexOf('*/') || /(^|\s)\/\//.test(linePrefix);
}

/**
 * Lists every literal module specifier the bundle loads at runtime instead of carrying it inline:
 * calls through esbuild's `__require` shim, the banner's `require`, any other function bound to a
 * `createRequire(...)` result (esbuild's `requireN` renames among them), and dynamic `import()`.
 *
 * Text, not a parse: a 470k-line bundle is too slow to parse on every build. Three shapes that look
 * like calls but are not are skipped: a match directly after a quote or backtick (ajv's standalone
 * code templates hold `'require("ajv/dist/runtime/equal")'`), a specifier containing `${`, and a
 * match in a comment (JSDoc types such as `{import('estree').Program}`). esbuild prints one
 * statement per line, which is what makes the line-based comment test hold.
 * Non-literal lookups such as `__require(mod)` are not reported; there is nothing to check them against.
 */
export function findRuntimeLookups(bundle: string): RuntimeLookup[] {
  const callers = new Set(['__require', 'require']);
  for (const [, name = ''] of bundle.matchAll(CREATE_REQUIRE_BINDING)) {
    callers.add(name);
  }
  for (const [, name = ''] of bundle.matchAll(RENAMED_REQUIRE_CALL)) {
    callers.add(name);
  }

  const names = [...callers].map((name) => name.replace(/\$/g, '\\$')).join('|');
  const call = new RegExp(String.raw`(?<![\w$.'"\x60])(${names}|import)(?:\.resolve)?\(\s*(["'])([^"'\x60\n]+)\2\s*\)`, 'g');

  const lookups: RuntimeLookup[] = [];
  let line = 1;
  let lineStart = 0;
  for (const match of bundle.matchAll(call)) {
    const [, via = '', , specifier = ''] = match;
    const offset = match.index ?? 0;
    // Matches arrive in order, so the line count only ever moves forward.
    for (let next = bundle.indexOf('\n', lineStart); next !== -1 && next < offset; next = bundle.indexOf('\n', lineStart)) {
      line += 1;
      lineStart = next + 1;
    }
    if (specifier.includes('${') || isInComment(bundle.slice(lineStart, offset))) {
      continue;
    }
    lookups.push({ specifier, via, line });
  }
  return lookups;
}

/** Whether esbuild treats `specifier` as covered by `external`: an exact entry, or a subpath of a package entry. */
function isExternal(specifier: string, externals: readonly string[]): boolean {
  return externals.some((entry) => specifier === entry || specifier.startsWith(`${entry}/`));
}

export interface BundleCheck {
  /** Lookups that are neither builtins, declared externals, nor allowlisted: the Hub would fail to load them. */
  unexpected: RuntimeLookup[];
  /** Allowlist entries the bundle no longer contains, worth pruning. */
  unusedAllowlist: string[];
}

/**
 * Checks the bundle's runtime lookups against what the runtime image can satisfy.
 *
 * @param externals Packages deliberately left out of the bundle. Builtins are NOT passed here and are
 *   judged by `isBuiltin` alone: esbuild's subpath rule makes `process/` external because `process`
 *   is, but Node refuses `require('process/')` (the trailing slash rules out the builtin), so the
 *   builtin list must not wave such a specifier through.
 * @param allowlist Specifiers known to be looked up at runtime and to be absent there, each with the
 *   reason that is safe.
 */
export function checkBundle(bundle: string, externals: readonly string[], allowlist: Readonly<Record<string, string>>): BundleCheck {
  const seen = new Set<string>();
  const unexpected: RuntimeLookup[] = [];
  for (const lookup of findRuntimeLookups(bundle)) {
    seen.add(lookup.specifier);
    if (isBuiltin(lookup.specifier) || isExternal(lookup.specifier, externals) || Object.hasOwn(allowlist, lookup.specifier)) {
      continue;
    }
    unexpected.push(lookup);
  }
  return { unexpected, unusedAllowlist: Object.keys(allowlist).filter((specifier) => !seen.has(specifier)) };
}
