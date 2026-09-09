/**
 * The systemd user timer that keeps `CI_HUB_STATUS.md` on the operator's Desktop.
 *
 * **A user unit, not a system one.** The file belongs on a person's Desktop, and a
 * root-owned system unit writing into `/home/<someone>/Desktop` leaves a file that
 * user may not be able to replace. `packages/desktop/src-tauri/src/inference_runners.rs`
 * already installs `--user` units for the inference runners; this follows it.
 *
 * That choice costs one thing and it is paid explicitly: a user unit stops when the
 * user logs out, so the installer enables lingering. Without that, the status file
 * would silently stop refreshing on a machine nobody is sitting at — which is
 * exactly the machine an audit is about.
 */

export const STATUS_TIMER_UNIT = 'companion-hub-status.timer';
export const STATUS_SERVICE_UNIT = 'companion-hub-status.service';

/** Every 15 minutes on the quarter hour, matching the Hub's own write cadence. */
export const STATUS_TIMER_CALENDAR = '*:0/15';

export function renderStatusService(cihubPath = '/usr/local/bin/cihub'): string {
  return [
    '[Unit]',
    'Description=Copy the CI-Hub status report to the desktop',
    'Documentation=https://github.com/companionintelligence/CI-Hub/blob/dev/docs/CLI.md',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${cihubPath} status --write-status-file`,
    // The Hub may not have written its first report yet on a fresh install; that is
    // a normal transient, not a unit that should sit in a failed state forever.
    'SuccessExitStatus=0 1',
    '',
  ].join('\n');
}

export function renderStatusTimer(calendar = STATUS_TIMER_CALENDAR): string {
  return [
    '[Unit]',
    'Description=Refresh the CI-Hub status report on the desktop',
    '',
    '[Timer]',
    `OnCalendar=${calendar}`,
    // A machine that was asleep or off should refresh on wake rather than wait for
    // the next quarter hour with a stale file on screen.
    'Persistent=true',
    'AccuracySec=1min',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

/**
 * Shell to install and start the timer for the SSH user, idempotently.
 *
 * Written as a script rather than a sequence of `ssh` calls because it runs once
 * per node inside the same session `fleet install` already opened.
 */
export function installStatusTimerScript(cihubPath = '/usr/local/bin/cihub'): string {
  return [
    'set -eu',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template.
    'unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"',
    'mkdir -p "$unit_dir"',
    `cat >"$unit_dir/${STATUS_SERVICE_UNIT}" <<'UNIT'`,
    renderStatusService(cihubPath),
    'UNIT',
    `cat >"$unit_dir/${STATUS_TIMER_UNIT}" <<'UNIT'`,
    renderStatusTimer(),
    'UNIT',
    // Without a user D-Bus session `systemctl --user` cannot talk to anything, which
    // is reported rather than silently skipped: the caller decides whether a node
    // with no timer is acceptable.
    'if ! systemctl --user show-environment >/dev/null 2>&1; then',
    '  echo "status-timer-no-user-session"',
    '  exit 0',
    'fi',
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${STATUS_TIMER_UNIT}`,
    // Survive logout. Best-effort: it needs polkit or root, and a node where it
    // fails still refreshes whenever someone is logged in.
    'loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || echo "status-timer-no-linger"',
    `${cihubPath} status --write-status-file || true`,
    'echo "status-timer-installed"',
  ].join('\n');
}

export type StatusTimerOutcome = 'installed' | 'no-user-session' | 'no-linger' | 'failed';

/** Read the script's markers back into a verdict, so each node reports what it got. */
export function classifyStatusTimerOutput(stdout: string, ok: boolean): StatusTimerOutcome {
  if (stdout.includes('status-timer-no-user-session')) return 'no-user-session';
  if (!ok || !stdout.includes('status-timer-installed')) return 'failed';
  if (stdout.includes('status-timer-no-linger')) return 'no-linger';
  return 'installed';
}

export function describeStatusTimerOutcome(outcome: StatusTimerOutcome): string {
  switch (outcome) {
    case 'installed':
      return 'status report refreshes every 15 minutes';
    case 'no-linger':
      return 'timer installed, but it only runs while this user is logged in (lingering was refused)';
    case 'no-user-session':
      return 'no systemd user session on this node — status file will not refresh on its own';
    default:
      return 'timer could not be installed';
  }
}
