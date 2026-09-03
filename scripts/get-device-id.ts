/**
 * Print the stable device ID for this machine using the same resolver as the Hub backend.
 *
 * Usage:
 *   pnpm exec tsx scripts/get-device-id.ts
 *   cihub device-id
 */
import { resolveDeviceId } from '../packages/backend/src/modules/registration/device-id.resolver.js';
import { isDirectScriptRun } from './lib/is-direct-run.js';
import { resolveCanonicalDataDir } from './lib/paths.js';

/** Resolve the device ID from the shared backend registration resolver. */
export async function getDeviceId(): Promise<string> {
  return resolveDeviceId({ dataDir: resolveCanonicalDataDir() });
}

const isDirectRun = isDirectScriptRun(import.meta.url, import.meta.main);

if (isDirectRun) {
  getDeviceId()
    .then((deviceId) => {
      console.log(deviceId);
    })
    .catch((error) => {
      console.error('Unable to resolve device ID:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
