import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseEnvFile } from '../env-file';

/** Resolve ROOT_FOLDER_HOST for a named env file (CLI / compose helpers). */
export function resolveRootFolderHost(envFileName: string): string {
  const vars = parseEnvFile(envFileName);
  const configured = process.env.ROOT_FOLDER_HOST || vars.ROOT_FOLDER_HOST || '.internal';
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

/**
 * Resolve ROOT_FOLDER_HOST during init scripts (init-hub-data-dirs, init-docker-config).
 * Honors ENV_FILE, process.env.ROOT_FOLDER_HOST, then CI_HUB_STATE_PATH / STATE_PATH.
 */
export function resolveRootFolderHostForRuntime(): string {
  const envFile = process.env.ENV_FILE || '.env.dev';
  const envPath = path.isAbsolute(envFile) ? envFile : path.join(process.cwd(), envFile);
  if (existsSync(envPath)) {
    const vars = parseEnvFile(envFile);
    const configured = vars.ROOT_FOLDER_HOST;
    if (configured) {
      return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
    }
  }
  const fromEnv = process.env.ROOT_FOLDER_HOST;
  if (fromEnv) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(process.cwd(), fromEnv);
  }
  const internal = process.env.CI_HUB_STATE_PATH || process.env.STATE_PATH || '.internal';
  return path.isAbsolute(internal) ? internal : path.resolve(process.cwd(), internal);
}
