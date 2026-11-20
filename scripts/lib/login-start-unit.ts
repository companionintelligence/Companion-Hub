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
 * **The user stays in charge.** `cihub up` enables the service once. A user who disables it
 * (`systemctl --user disable`) or deletes the file keeps it that way: a marker file records
 * that `cihub` installed it before, and later runs only refresh a file that is still there.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOGIN_START_UNIT = 'companion-hub-login-start.service';
const SCRIPT_NAME = 'login-start.sh';
const MARKER_NAME = '.login-start-installed';

/** How long the script waits for Docker, and then for a missing bind source, in 2 s steps. */
const DOCKER_WAIT_STEPS = 60;
const SOURCE_WAIT_STEPS = 30;

export interface LoginStartPaths {
  unitFile: string;
  scriptFile: string;
  markerFile: string;
}

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

export function renderLoginStartService(scriptFile: string): string {
  return [
    '[Unit]',
    'Description=Start the Companion Hub containers that could not start at boot',
    'Documentation=https://github.com/companionintelligence/CI-Hub/blob/dev/docs/CLI.md#after-a-reboot-on-linux',
    // An uninstall that removed the script leaves nothing to run, which is not a failure.
    `ConditionPathExists=${scriptFile}`,
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=/bin/sh ${systemdQuote(scriptFile)}`,
    // Docker can take a while to answer after boot, and a missing source gets its own wait.
    'TimeoutStartSec=10min',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * POSIX sh, so the service needs nothing but `docker` and runs whichever `cihub` installed it
 * (a checkout, the .deb's /usr/bin/cihub, npm, a standalone binary). Every exit is 0: a login
 * with nothing to start, or no Docker, is normal and must not leave a failed unit behind.
 */
export function renderLoginStartScript(): string {
  return `#!/bin/sh
# Written by cihub (scripts/lib/login-start-unit.ts). Starts the Companion Hub containers that
# Docker could not start at boot because a bind-mounted file was not there yet, which happens
# when the home folder is unlocked at login. A container someone stopped is left alone.
set -u
log() { echo "companion-hub-login-start: $*"; }

i=0
until docker info >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge ${DOCKER_WAIT_STEPS} ]; then
    log "Docker did not answer within $((${DOCKER_WAIT_STEPS} * 2)) s; started nothing"
    exit 0
  fi
  sleep 2
done

ids=$( {
  docker ps -aq --filter label=ci-hub.managed=true --filter status=exited
  docker ps -aq --filter label=ci-hub.managed=true --filter status=created
  docker ps -aq --filter label=com.docker.compose.project=ci-hub --filter status=exited
  docker ps -aq --filter label=com.docker.compose.project=ci-hub --filter status=created
} | sort -u)

# One line per candidate: <0 for ci-hub, 1 otherwise>|<name>|<missing source>. Sorted, so the
# Hub starts first and brings back what its own boot handles (Traefik).
candidates=""
for id in $ids; do
  info=$(docker inspect --format '{{.Name}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.Error}}' "$id" 2>/dev/null) || continue
  name=\${info%%|*}; name=\${name#/}
  rest=\${info#*|}
  policy=\${rest%%|*}
  error=\${rest#*|}
  case "$policy" in unless-stopped|always) ;; *) continue ;; esac
  case "$error" in *"error mounting"*) ;; *) continue ;; esac
  src=$(printf '%s\\n' "$error" | sed -n 's/.*mount src=\\([^,]*\\),.*/\\1/p')
  [ -n "$src" ] || continue
  if [ "$name" = "ci-hub" ]; then rank=0; else rank=1; fi
  candidates="$candidates$rank|$name|$src
"
done

if [ -z "$candidates" ]; then
  exit 0
fi

printf '%s' "$candidates" | sort | while IFS='|' read -r rank name src; do
  [ -n "$name" ] || continue
  j=0
  while [ ! -e "$src" ] && [ "$j" -lt ${SOURCE_WAIT_STEPS} ]; do
    j=$((j + 1))
    sleep 2
  done
  if [ ! -e "$src" ]; then
    log "left $name stopped: $src is still missing"
    continue
  fi
  if docker start "$name" >/dev/null 2>&1; then
    log "started $name, which could not mount $src at boot"
  else
    log "could not start $name"
  fi
done
exit 0
`;
}

export type LoginStartOutcome = 'installed' | 'refreshed' | 'unchanged' | 'left-removed' | 'not-linux' | 'no-user-session' | 'failed';

export interface LoginStartDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
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
