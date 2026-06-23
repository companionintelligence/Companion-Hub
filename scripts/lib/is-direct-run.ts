import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when the calling module was invoked as a script entrypoint (e.g. `tsx scripts/foo.ts`),
 * not when imported by the CLI bundle or another module.
 *
 * Pass `import.meta.url` and `import.meta.main` from the module that owns the direct-run block.
 */
export function isDirectScriptRun(moduleUrl: string, isMain: boolean | undefined): boolean {
  if (isMain === true) {
    return true;
  }

  if (isMain === false) {
    return false;
  }

  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  const modulePath = moduleUrl.startsWith('file://') ? fileURLToPath(moduleUrl) : path.resolve(moduleUrl);
  return path.resolve(entry) === modulePath;
}
