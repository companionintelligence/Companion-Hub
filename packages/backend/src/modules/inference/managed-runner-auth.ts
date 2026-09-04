import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';

export type AuthenticatedManagedRunner = 'dspark' | 'mtplx';

const API_KEY_ENV: Record<AuthenticatedManagedRunner, string> = {
  dspark: 'DSPARK_API_KEY',
  mtplx: 'MTPLX_API_KEY',
};

/**
 * The desktop writes one private key per managed host runner into the Hub state
 * mount. An explicit environment variable wins so remote/operator-managed
 * servers can use their own credential without touching desktop state.
 */
export function readManagedRunnerApiKey(
  runner: AuthenticatedManagedRunner,
  env: NodeJS.ProcessEnv = process.env,
  dataDir: string = DATA_DIR,
): string | undefined {
  const configured = env[API_KEY_ENV[runner]]?.trim();
  if (configured) return configured;

  try {
    const managed = fs.readFileSync(path.join(dataDir, 'state', 'inference-runners', `${runner}.api-key`), 'utf8').trim();
    return managed || undefined;
  } catch {
    return undefined;
  }
}

export function bearerHeaders(apiKey: string | undefined): Record<string, string> | undefined {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
}
