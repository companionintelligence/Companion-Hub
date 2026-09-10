import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseEnvFile } from '../env-file';

/** Resolve ROOT_FOLDER_HOST for a named env file (CLI / compose helpers). */
export function resolveRootFolderHost(envFileName: string): string {
  const vars = parseEnvFile(envFileName);
  const configured = process.env.ROOT_FOLDER_HOST || vars.ROOT_FOLDER_HOST || '.internal';
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

/** Folder name the desktop app uses under the platform data dir (mirrors Rust `get_hub_data_dir`). */
export const CANONICAL_DATA_DIR_NAME = 'companion-hub';

/**
 * Canonical prod data directory, mirroring the Tauri desktop `get_hub_data_dir()`
 * (`dirs::data_dir()/companion-hub`). A `CI_HUB_DATA_DIR` override always wins so the
 * desktop can pass an explicit location when it invokes the bundled CLI.
 *
 * - Linux:   $XDG_DATA_HOME/companion-hub        (default ~/.local/share/companion-hub)
 * - macOS:   ~/Library/Application Support/companion-hub
 * - Windows: %APPDATA%/companion-hub             (Roaming)
 */
export function resolveCanonicalDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env.CI_HUB_DATA_DIR?.trim();
  if (override) return override;

  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, CANONICAL_DATA_DIR_NAME);
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', CANONICAL_DATA_DIR_NAME);
  }
  const xdgData = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdgData, CANONICAL_DATA_DIR_NAME);
}

/**
 * Home directory of the user who invoked a `sudo`'d command, or null when not under sudo.
 *
 * `sudo` sets `HOME=/root` but leaves `SUDO_USER`, so anything resolving a per-user path
 * under sudo silently looks in root's home. There is no portable Node API for another
 * user's home directory, so this reconstructs it from the platform's conventional root and
 * only returns it if it actually exists — a wrong guess yields null rather than a
 * confidently wrong path.
 */
export function resolveInvokingUserHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const user = env.SUDO_USER?.trim();
  if (!user || user === 'root' || platform === 'win32') return null;
  const candidate = platform === 'darwin' ? path.join('/Users', user) : path.join('/home', user);
  return exists(candidate) ? candidate : null;
}

/**
 * Every location a Hub device key could legitimately live, in the order to try them.
 *
 * A key is read from exactly one file, but which file depends on how the Hub was installed
 * and how the CLI was invoked, and getting that wrong produces a false negative that reads
 * as a statement about the Hub. `cihub pool status` under sudo reported "Hub not paired" on
 * a node that was at that moment routing inference to three peers, because it checked
 * `<cwd>/.internal/state/settings.json` while the key sat in the canonical data dir of the
 * user who owns the Hub.
 *
 * Order is deliberate: an explicitly configured ROOT_FOLDER_HOST wins, then the canonical
 * data dir a desktop/appliance install uses, then — only under sudo — the canonical dir of
 * the invoking user, which is the case above.
 */
export function settingsCandidatesFrom(
  rootFolderHost: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync,
): string[] {
  const candidates = [
    path.join(rootFolderHost, 'state', 'settings.json'),
    path.join(resolveCanonicalDataDir(env, platform, home), 'state', 'settings.json'),
  ];

  // An explicit CI_HUB_DATA_DIR already names the answer; widening past it would search
  // somewhere the operator did not point us.
  if (!env.CI_HUB_DATA_DIR?.trim()) {
    const invokingHome = resolveInvokingUserHome(env, platform, exists);
    if (invokingHome) {
      // Drop XDG_DATA_HOME: under sudo it is root's, or unset. The invoking user's default
      // is what we are reconstructing.
      const { XDG_DATA_HOME: _dropped, ...rest } = env;
      candidates.push(path.join(resolveCanonicalDataDir(rest, platform, invokingHome), 'state', 'settings.json'));
    }
  }

  return candidates.filter((candidate, i) => candidates.indexOf(candidate) === i);
}

/** `settingsCandidatesFrom` for a named env file. */
export function resolveSettingsCandidates(
  envFileName: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  return settingsCandidatesFrom(resolveRootFolderHost(envFileName), env, platform, home);
}

export type ProdApplianceContext = {
  /** Canonical data dir where a desktop-installed prod Hub keeps its state. */
  dataDir: string;
  /** Seeded runtime env file (`.env.dev` on Unix, `.env` on Windows; both written by the desktop). */
  envFilePath: string;
  /** Seeded prod compose file. */
  composePath: string;
  /** True when both the compose file and an env file are present (a real prod install exists). */
  exists: boolean;
};

/**
 * Resolve the canonical prod data dir and the desktop-seeded `.env` / compose paths so the
 * CLI can manage a prod install from anywhere (no CI-Hub checkout required).
 */
export function resolveProdApplianceContext(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): ProdApplianceContext {
  const dataDir = resolveCanonicalDataDir(env, platform, home);
  // The desktop writes a primary env file plus a compat copy with identical content.
  const primaryEnv = path.join(dataDir, platform === 'win32' ? '.env' : '.env.dev');
  const compatEnv = path.join(dataDir, platform === 'win32' ? '.env.dev' : '.env');
  const envFilePath = existsSync(primaryEnv) ? primaryEnv : existsSync(compatEnv) ? compatEnv : primaryEnv;
  const composePath = path.join(dataDir, 'docker-compose.prod.yml');
  const exists = existsSync(composePath) && (existsSync(primaryEnv) || existsSync(compatEnv));
  return { dataDir, envFilePath, composePath, exists };
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
