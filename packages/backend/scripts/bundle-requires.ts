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
 * `createRequire(import.meta.url)('pkg')`, called in place with a literal specifier. @nestjs/common
 * 12's JSDoc for loadPackageSync recommends `() => createRequire(import.meta.url)('pkg')` as the
 * loader, so the next @nestjs/* release can ship it. A non-literal specifier (@nestjs/common's own
 * `createRequire(import.meta.url)(packageName)` fallback) is left alone: esbuild could not bundle it
 * either way, and rewriting it would only change the text.
 */
const INLINE_CREATE_REQUIRE = /(?<![\w$.])(?:[\w$]+\.)?createRequire\([ \t]*import\.meta\.url[ \t]*\)(?=[ \t]*\([ \t]*["'])/g;

/**
 * Makes a module's createRequire lookups visible to esbuild: its own `require` binding is removed so
 * its `require('x')` calls fall through to the free `require`, and an in-place
 * `createRequire(import.meta.url)('x')` becomes `require('x')`. esbuild then resolves and bundles
 * them exactly as it does in a CommonJS file. Returns undefined when the source has neither shape,
 * so esbuild loads the file untouched.
 *
 * The binding's line is replaced by a comment, not deleted, and the in-place rewrite stays on its
 * line, so the source map's line numbers still match.
 */
export function stripLocalCreateRequire(source: string): string | undefined {
  if (!source.includes('createRequire')) {
    return undefined;
  }
  let changed = false;
  const contents = source
    .replace(LOCAL_CREATE_REQUIRE, (_line, indent: string) => {
      changed = true;
      return `${indent}/* local createRequire removed by packages/backend/scripts/bundle-requires.ts so esbuild bundles these requires */`;
    })
    .replace(INLINE_CREATE_REQUIRE, () => {
      changed = true;
      return 'require';
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
  /**
   * What does the lookup: `__require` (esbuild's shim), `require` (the banner's), `require5`, any
   * other name bound to a createRequire result, `import`, or an in-place call such as
   * `node_module.createRequire(parent)`.
   */
  via: string;
  /** 1-based line in the bundle. */
  line: number;
}

const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;
/**
 * A function that makes a require, by its own name: `createRequire`, esbuild's `createRequire5`, the
 * banner's `__createRequire`, Node's old `createRequireFromPath`. It may sit behind one property
 * access (`module.createRequire`, a namespace import's `nodeModule.createRequire`), which the
 * patterns using this allow for.
 */
const CREATE_REQUIRE_NAME = String.raw`[\w$]*createRequire[\w$]*`;
/**
 * A local name for createRequire that does not contain the word, which esbuild prints as the package
 * wrote it: `import { createRequire as cr } from "module"`, or a destructuring
 * `const { createRequire: cr } = __require("module")` (the `} =` rules out an object literal's key).
 */
const CREATE_REQUIRE_ALIAS = new RegExp(
  String.raw`\bimport\s*\{[^}]*?\bcreateRequire\s+as\s+(${IDENTIFIER})|\{[^{}]*?\bcreateRequire\s*:\s*(${IDENTIFIER})[^{}]*\}\s*=(?![=>])`,
  'g',
);
/** The argument list of a call on one line, allowing one level of nested parentheses: `(import.meta.url)`, `(join(dir, "x"))`. */
const ONE_LINE_ARGUMENTS = String.raw`\((?:[^()\n]|\([^()\n]*\))*\)`;
/** A call through esbuild's renamed copy of a local `require`, whether or not its binding was found. */
const RENAMED_REQUIRE_CALL = /(?<![\w$.])(require\d+)(?:\.resolve)?\(/g;
/** A string literal on one line, escapes included. */
const STRING_LITERAL = /(["'\x60])(?:\\.|(?!\1)[^\\\n])*\1/g;

const escapeName = (name: string) => name.replace(/\$/g, '\\$');

/**
 * The text before a match on its line puts it inside a comment: a JSDoc line, an open block comment,
 * or after `//`. String literals are emptied first, so `" // "` or `"lib/*.js"` earlier on the line
 * does not hide a real call after it.
 */
function isInComment(linePrefix: string): boolean {
  const code = linePrefix.replace(STRING_LITERAL, '$1$1');
  return /^\s*\*/.test(code) || code.lastIndexOf('/*') > code.lastIndexOf('*/') || /(^|\s)\/\//.test(code);
}

/**
 * Lists the literal module specifiers the bundle loads at runtime instead of carrying them inline,
 * in these shapes:
 *  - a call through esbuild's `__require` shim or the banner's `require`;
 *  - a call through any name bound to a createRequire result: esbuild's `requireN` renames, and a
 *    binding made through an alias, as in `import { createRequire as cr }` then `r = cr(...)`;
 *  - createRequire called in place, as in `createRequire(import.meta.url)("x")` or
 *    `node_module.createRequire(parent)("x")`, under its own name or an alias;
 *  - each of the above as `.resolve("x")`, and dynamic `import("x")`.
 * Specifiers may be quoted with ', " or a backtick.
 *
 * It sees only these shapes. A lookup written another way (a non-literal specifier such as
 * `__require(mod)`, which has nothing to check against, or a require function passed through a
 * variable whose binding does not name createRequire or an alias of it) is not reported, so a new
 * shape found in a bundle belongs here, with a test.
 *
 * Text, not a parse: a 470k-line bundle is too slow to parse on every build. Three shapes that look
 * like calls but are not are skipped: a match directly after a quote or backtick (ajv's standalone
 * code templates hold `'require("ajv/dist/runtime/equal")'`), a specifier containing `${`, and a
 * match in a comment (JSDoc types such as `{import('estree').Program}`). esbuild prints one
 * statement per line, which is what makes the line-based comment test hold.
 */
export function findRuntimeLookups(bundle: string): RuntimeLookup[] {
  const factories = new Set<string>();
  for (const [, imported, destructured] of bundle.matchAll(CREATE_REQUIRE_ALIAS)) {
    factories.add(imported ?? destructured ?? '');
  }
  factories.delete('');
  const factory = [CREATE_REQUIRE_NAME, ...[...factories].map(escapeName)].join('|');

  const callers = new Set(['__require', 'require']);
  const binding = new RegExp(String.raw`(?<![\w$.])(${IDENTIFIER})\s*=\s*(?:[\w$]+\.)?(?:${factory})\(`, 'g');
  for (const [, name = ''] of bundle.matchAll(binding)) {
    callers.add(name);
  }
  for (const [, name = ''] of bundle.matchAll(RENAMED_REQUIRE_CALL)) {
    callers.add(name);
  }

  const names = [...callers].map(escapeName).join('|');
  // Group 1 is a named caller, group 2 an in-place createRequire call. The in-place form may follow a
  // `.` (`__require("module").createRequire(x)("y")`); a named caller may not, or `foo.require("x")`,
  // a method of some object, would count.
  const callee = String.raw`(?<![\w$.'"\x60])(${names}|import)|(?<![\w$'"\x60])((?:[\w$]+\.)?(?:${factory})\s*${ONE_LINE_ARGUMENTS})`;
  const call = new RegExp(String.raw`(?:${callee})(?:\.resolve)?\(\s*(["'\x60])([^"'\x60\n]+)\3\s*\)`, 'g');

  const lookups: RuntimeLookup[] = [];
  let line = 1;
  let lineStart = 0;
  for (const match of bundle.matchAll(call)) {
    const [, named, inPlace, , specifier = ''] = match;
    const via = named ?? inPlace ?? '';
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
