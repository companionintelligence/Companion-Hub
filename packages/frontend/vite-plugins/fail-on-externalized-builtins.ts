import { isBuiltin } from 'node:module';
import type { Plugin } from 'vite';

/**
 * Build-time guard: a Node builtin that ends up in the browser bundle fails the production build.
 *
 * When client code (or a dependency) imports a Node builtin such as `node:util`, Vite does not fail. It swaps the
 * module for an empty stub and prints one warning, `Module "node:util" has been externalized for browser
 * compatibility, imported by "<file>"`. The build still exits 0, `tsc` still passes (the types come from `@types/node`
 * or an `any` module declaration) and the Node-based unit tests still pass, so the break only shows up in the browser,
 * the first time the stubbed function is called. That is how Dependabot #2037 (`better-ajv-errors` 3.x, which calls
 * `styleText` from `node:util` unguarded) broke the compose-JSON editor, and #2044 had to revert it.
 *
 * The warning is the only signal, so this plugin turns it into an error. It hooks the bundler's `onLog`, which sees
 * the warning from every plugin, including Vite's own resolver. Unit tests live in `src/tests/` because the frontend
 * vitest project only collects `src/**`.
 */

/** A deliberate, reviewed exception: this importer may get an empty stub for this builtin. */
export interface ExternalizedBuiltinException {
  /** The builtin, with or without the `node:` prefix (`node:util` and `util` match the same entry). */
  specifier: string;
  /** Substring of the importing file's path, forward slashes, for example `/node_modules/some-pkg/`. */
  importer: string;
  /** Why an empty stub is safe there: what the importer does when the module has no exports. */
  reason: string;
}

/** Empty on purpose. Add an entry only after checking that the importer never reaches the stub in the browser. */
export const ALLOWED_EXTERNALIZED_BUILTINS: readonly ExternalizedBuiltinException[] = [];

const EXTERNALIZED_MARKER = /has been externalized for browser compatibility/;
const EXTERNALIZED_DETAILS = /Module "([^"]+)" has been externalized for browser compatibility(?:, imported by "([^"]*)")?/;

function logMessage(log: unknown): string {
  if (typeof log === 'string') return log;
  if (log && typeof log === 'object') {
    const { message } = log as { message?: unknown };
    if (typeof message === 'string') return message;
  }
  return '';
}

const bareName = (specifier: string): string => specifier.replace(/^node:/, '');

/**
 * Throws when `log` is Vite's "externalized for browser compatibility" warning for a Node builtin that is not in
 * `allowed`. Any other log, and the same warning for a non-builtin module (a package's own `browser: { x: false }`
 * mapping), passes. A message that carries the marker but not the expected shape also throws, so a Vite wording
 * change breaks the build loudly instead of switching the guard off.
 */
export function assertNoExternalizedBuiltin(log: unknown, allowed: readonly ExternalizedBuiltinException[] = ALLOWED_EXTERNALIZED_BUILTINS): void {
  const message = logMessage(log);
  if (!EXTERNALIZED_MARKER.test(message)) return;

  const details = EXTERNALIZED_DETAILS.exec(message);
  const specifier = details?.[1];
  if (!specifier) {
    throw new Error(
      `[fail-on-externalized-builtins] Vite logged an "externalized for browser compatibility" message in a shape this guard does not recognise, so it cannot tell whether a Node builtin is being stubbed out: ${message}\nUpdate EXTERNALIZED_DETAILS in packages/frontend/vite-plugins/fail-on-externalized-builtins.ts to match.`,
    );
  }
  if (!isBuiltin(specifier)) return;

  const importer = (details[2] ?? '').replaceAll('\\', '/');
  const isAllowed = allowed.some((entry) => bareName(entry.specifier) === bareName(specifier) && importer.includes(entry.importer));
  if (isAllowed) return;

  throw new Error(
    [
      `[fail-on-externalized-builtins] Node builtin "${specifier}" is imported by browser code${importer ? ` in "${importer}"` : ''}.`,
      'Vite replaces it with an empty stub, so calling into it throws in the browser while tsc and the Node tests stay green.',
      'Fix the importer: for a dependency, pin or revert the version that started using the builtin (look at the last bump of that package).',
      `If the stub is deliberate and safe, add { specifier: '${specifier}', importer: '<path substring>', reason: '<why>' } to ALLOWED_EXTERNALIZED_BUILTINS in packages/frontend/vite-plugins/fail-on-externalized-builtins.ts.`,
    ].join('\n'),
  );
}

/**
 * Vite plugin form of {@link assertNoExternalizedBuiltin}. Build only: `vite dev` and vitest never run it.
 *
 * `onLog` only records the violation. Throwing from it does not work: Rolldown swallows the exception, drops the log
 * and carries on, so the build exits 0 with the warning gone (verified with better-ajv-errors 3.0.2). `buildEnd` runs
 * after module resolution, where every externalization warning has been logged, and an error there does fail the build.
 */
export function failOnExternalizedBuiltins(allowed: readonly ExternalizedBuiltinException[] = ALLOWED_EXTERNALIZED_BUILTINS): Plugin {
  const violations = new Set<string>();
  return {
    name: 'ci-hub:fail-on-externalized-builtins',
    apply: 'build',
    onLog(_level, log) {
      try {
        assertNoExternalizedBuiltin(log, allowed);
      } catch (error) {
        violations.add(error instanceof Error ? error.message : String(error));
      }
    },
    buildEnd() {
      if (violations.size === 0) return;
      const found = [...violations];
      violations.clear();
      throw new Error(found.join('\n\n'));
    },
  };
}
