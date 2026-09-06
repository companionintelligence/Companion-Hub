/**
 * Where the CLI is running: inside a CI-Hub checkout, or as a packaged appliance install.
 *
 * Lifecycle commands shell out to the repo's helper scripts and Compose files, so several
 * commands are only meaningful inside a checkout. Keeping the detection here lets the
 * command modules depend on it without reaching back into `cihub-cli.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { printMessageBox } from './cli-ui.js';
import { runCapture } from './cli-proc.js';

export function checkDockerAvailable(): boolean {
  return runCapture('docker', ['info']).ok;
}

/**
 * Commands that drive setup/lifecycle shell out to the repo's helper scripts
 * (tsx scripts/*.ts) and Docker Compose files, all resolved from process.cwd().
 * A global/npm install of cihub run outside a CI-Hub checkout has none of these,
 * so fail early with an actionable message instead of a cryptic tsx/docker error.
 */
export function isHubRepoRoot(cwd: string = process.cwd()): boolean {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath) || !existsSync(join(cwd, 'scripts'))) return false;
  try {
    return (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string }).name === 'ci-hub';
  } catch {
    return false;
  }
}

/** True when the CLI is not running inside a CI-Hub checkout (a packaged/global prod install). */
export function isApplianceMode(cwd: string = process.cwd()): boolean {
  return !isHubRepoRoot(cwd);
}

export function requireRepoRoot(action: string): void {
  if (isHubRepoRoot()) return;
  printMessageBox(
    'Run from a CI-Hub checkout',
    [
      `${action} runs CI-Hub's setup scripts and Docker Compose files,`,
      'so it must be run from a CI-Hub repository directory (the one containing',
      'package.json and docker-compose.local.yml).',
      '',
      'Packaged/global installs support: --help, man, version, status,',
      'config, and the app/models Docker passthrough commands.',
    ],
    'red',
  );
  process.exit(2);
}
