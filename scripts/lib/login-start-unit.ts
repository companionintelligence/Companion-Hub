/**
 * The systemd user service that starts the Hub's containers after the user logs in, when they
 * could not start at boot.
 *
 * **Why it exists.** The Hub's containers bind-mount files from a folder under the home folder
 * (the data dir on an installed Hub, the checkout on a developer's). When the home folder is
 * only unlocked at login (eCryptfs, fscrypt, systemd-homed), Docker restarts its
 * `unless-stopped` containers at boot before those files exist. Each fails with "error mounting
 * … not a directory" (exit 127), and Docker never retries a container that failed to start. The
 * desktop app covers its own install with a login autostart entry (`login_autostart.rs`); a Hub
 * started by `cihub up` had nothing. Measured on a dev box, 2026-11-20: Docker gave up on
 * `ci-hub` and `traefik` 0.3 s before the login mounted the home folder.
 *
 * **What it starts.** Only containers Docker itself would have started: a Hub container (the
 * `ci-hub.managed=true` label, or the `ci-hub` compose project), with an `unless-stopped` or
 * `always` restart policy, that is not running, whose last start failed with a bind-mount
 * error, and whose missing source is there now. A Hub someone stopped (`cihub down`, the
 * desktop's Stop Hub) has no such error, so it stays stopped. `ci-hub` goes first: its own boot
 * brings back a Traefik that is still down, so the rest is usually a no-op.
 *
 * **One copy.** The script and the unit template are `scripts/login-start/`, baked into the CLI
 * by `generate-bundled-hub-assets.ts`. The desktop's headless mode installs the same files at the
 * same paths (`packages/desktop/src-tauri/src/login_start_unit.rs`).
 *
 * **The user stays in charge.** `cihub up` enables the service once. A user who disables it
 * (`systemctl --user disable`) or deletes the file keeps it that way: a marker file records
 * that `cihub` installed it before, and later runs only refresh a file that is still there.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUNDLED_LOGIN_START_SCRIPT, BUNDLED_LOGIN_START_SERVICE } from './bundled-hub-assets.generated.js';

export const LOGIN_START_UNIT = 'companion-hub-login-start.service';
const SCRIPT_NAME = 'login-start.sh';
const MARKER_NAME = '.login-start-installed';

export interface LoginStartPaths {
  unitFile: string;
  scriptFile: string;
  markerFile: string;
}

/**
 * Where both installers put it. `packages/desktop/src-tauri/src/login_start_unit.rs` uses the
 * same three paths, so `cihub up` and the desktop's headless mode share one unit and one marker.
 */
export function loginStartPaths(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): LoginStartPaths {
  const configHome = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homeDir, '.config');
  const ownDir = path.join(configHome, 'companion-hub');
  return {
    unitFile: path.join(configHome, 'systemd', 'user', LOGIN_START_UNIT),
    scriptFile: path.join(ownDir, SCRIPT_NAME),
    markerFile: path.join(ownDir, MARKER_NAME),
  };
}

/** systemd quotes a path with spaces in ExecStart= with double quotes; `\` and `"` are escaped. */
function systemdQuote(value: string): string {
  return /[\s"\\]/.test(value) ? `"${value.replace(/[\\"]/g, '\\$&')}"` : value;
}

/** The unit, from `scripts/login-start/companion-hub-login-start.service`. */
export function renderLoginStartService(scriptFile: string): string {
  return BUNDLED_LOGIN_START_SERVICE.replace('@SCRIPT_PATH@', scriptFile).replace('@SCRIPT_EXEC@', systemdQuote(scriptFile));
}

/**
 * The script, from `scripts/login-start/companion-hub-login-start.sh`. POSIX sh, so the service
 * needs nothing but `docker` and runs whichever `cihub` installed it (a checkout, the .deb's
 * /usr/bin/cihub, npm, a standalone binary).
 */
export function renderLoginStartScript(): string {
  return BUNDLED_LOGIN_START_SCRIPT;
}

export type LoginStartOutcome = 'installed' | 'refreshed' | 'unchanged' | 'left-removed' | 'not-linux' | 'root' | 'no-user-session' | 'failed';

export interface LoginStartDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** The effective uid; root gets no unit. */
  uid?: number;
  /** Runs `systemctl --user <args>`; returns true on exit 0. */
  systemctl?: (args: string[]) => boolean;
}

function defaultSystemctl(args: string[]): boolean {
  const result = spawnSync('systemctl', ['--user', ...args], { stdio: 'ignore', timeout: 15_000 });
  return result.status === 0;
}

function readOr(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Install or refresh the service. Best-effort and quiet: it never throws, and the caller prints
 * only what the outcome says is worth saying.
 */
export function ensureLoginStartUnit(deps: LoginStartDeps = {}): LoginStartOutcome {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') return 'not-linux';
  // `scripts/install.sh` runs `sudo -E cihub up`. Root's home is not the folder unlocked at a
  // person's login, and a unit in root's config would run only when root logs in, so a root
  // install gets nothing; the Hub it starts comes back by its restart policy.
  if ((deps.uid ?? process.geteuid?.()) === 0) return 'root';
  const systemctl = deps.systemctl ?? defaultSystemctl;
  const paths = loginStartPaths(deps.env ?? process.env, deps.homeDir ?? os.homedir());

  try {
    const installedBefore = existsSync(paths.markerFile);
    const unitPresent = existsSync(paths.unitFile);
    if (installedBefore && !unitPresent) return 'left-removed';
    // No user manager (a container, CI, some SSH setups): nothing would ever run the unit.
    if (!systemctl(['show-environment'])) return 'no-user-session';

    const script = renderLoginStartScript();
    const unit = renderLoginStartService(paths.scriptFile);
    const changed = readOr(paths.scriptFile) !== script || readOr(paths.unitFile) !== unit;
    if (changed) {
      mkdirSync(path.dirname(paths.scriptFile), { recursive: true });
      mkdirSync(path.dirname(paths.unitFile), { recursive: true });
      writeFileSync(paths.scriptFile, script, { mode: 0o755 });
      chmodSync(paths.scriptFile, 0o755);
      writeFileSync(paths.unitFile, unit);
      systemctl(['daemon-reload']);
    }

    if (installedBefore) return changed ? 'refreshed' : 'unchanged';
    // First install only: a later `enable` would undo a user's `disable`.
    if (!systemctl(['enable', LOGIN_START_UNIT])) return 'failed';
    writeFileSync(paths.markerFile, `${new Date().toISOString()}\n`);
    return 'installed';
  } catch {
    return 'failed';
  }
}

/** Disable and delete the service, for `cihub uninstall`. Returns true when nothing is left. */
export function removeLoginStartUnit(deps: LoginStartDeps = {}): boolean {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') return true;
  const systemctl = deps.systemctl ?? defaultSystemctl;
  const paths = loginStartPaths(deps.env ?? process.env, deps.homeDir ?? os.homedir());
  if (existsSync(paths.unitFile)) {
    systemctl(['disable', LOGIN_START_UNIT]);
  }
  try {
    for (const file of [paths.unitFile, paths.scriptFile, paths.markerFile]) rmSync(file, { force: true });
    if (existsSync(paths.unitFile)) return false;
    systemctl(['daemon-reload']);
    return true;
  } catch {
    return false;
  }
}

export function describeLoginStartOutcome(outcome: LoginStartOutcome): string | null {
  switch (outcome) {
    case 'installed':
      return `Installed ${LOGIN_START_UNIT}: after you log in, it starts Hub containers that could not start at boot (a home folder unlocked at login). Turn it off with: systemctl --user disable ${LOGIN_START_UNIT}`;
    case 'failed':
      return `Could not install ${LOGIN_START_UNIT}. If the home folder is unlocked at login, start the Hub after a reboot with: docker start ci-hub`;
    default:
      return null;
  }
}
