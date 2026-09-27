import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where a Bun standalone binary mounts its bundle: `/$bunfs/root/<binary>` on Linux and macOS,
 * `B:/~BUN/root/<binary>` on Windows. A module URL under it belongs to the compiled `cihub`.
 */
const BUN_STANDALONE_ROOT = /[\\/](?:\$bunfs|~BUN)[\\/]/;

/**
 * True when the calling module was invoked as a script entrypoint (e.g. `tsx scripts/foo.ts`),
 * not when imported by the CLI bundle or another module.
 *
 * Pass `import.meta.url` and `import.meta.main` from the module that owns the direct-run block.
 * Always pass both: Bun rewrites `import.meta.main` to a literal `false` in every module it bundles,
 * and that literal is what keeps an entry block from running inside the compiled CLI.
 */
export function isDirectScriptRun(moduleUrl: string, isMain: boolean | undefined): boolean {
  if (isMain === true) {
    return true;
  }

  if (isMain === false) {
    return false;
  }

  // tsx runs these scripts as CommonJS, where import.meta.main is undefined, so fall back to argv.
  // Inside the compiled CLI that comparison is worthless: every bundled module's URL is the
  // binary's own, and so is argv[1], so it would call each of them the entrypoint.
  if (BUN_STANDALONE_ROOT.test(moduleUrl)) {
    return false;
  }

  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  const modulePath = moduleUrl.startsWith('file://') ? fileURLToPath(moduleUrl) : path.resolve(moduleUrl);
  return path.resolve(entry) === modulePath;
}
