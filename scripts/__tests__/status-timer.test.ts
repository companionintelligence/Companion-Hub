import { describe, expect, it } from 'vitest';

import {
  classifyStatusTimerOutput,
  describeStatusTimerOutcome,
  installStatusTimerScript,
  renderStatusService,
  renderStatusTimer,
  STATUS_TIMER_UNIT,
} from '../lib/status-timer';

describe('status timer units', () => {
  it('runs the CLI flag the timer exists to run', () => {
    expect(renderStatusService('/usr/local/bin/cihub')).toContain('ExecStart=/usr/local/bin/cihub status --write-status-file');
  });

  it('does not park the unit in failed state before the Hub has written anything', () => {
    // Exit 1 means "no status file yet", which is normal on a fresh install.
    expect(renderStatusService()).toContain('SuccessExitStatus=0 1');
  });

  it('fires every 15 minutes and catches up after downtime', () => {
    const timer = renderStatusTimer();

    expect(timer).toContain('OnCalendar=*:0/15');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('WantedBy=timers.target');
  });
});

describe('installStatusTimerScript', () => {
  const script = installStatusTimerScript();

  it('installs into the user unit dir, honouring XDG_CONFIG_HOME', () => {
    expect(script).toContain('${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user');
  });

  it('enables the timer and asks for lingering so it survives logout', () => {
    expect(script).toContain(`systemctl --user enable --now ${STATUS_TIMER_UNIT}`);
    expect(script).toContain('loginctl enable-linger');
  });

  it('bails out loudly when there is no user session instead of pretending', () => {
    expect(script).toContain('status-timer-no-user-session');
    expect(script).toContain('systemctl --user show-environment');
  });

  it('writes the file once at install so the Desktop is not empty until the first tick', () => {
    expect(script).toContain('status --write-status-file');
  });
});

describe('classifyStatusTimerOutput', () => {
  it('reports a clean install', () => {
    expect(classifyStatusTimerOutput('status-timer-installed\n', true)).toBe('installed');
  });

  it('distinguishes a timer with no lingering from a clean one', () => {
    // It works today and stops when the operator logs out — a different fact from
    // "installed", and the node listing says so.
    expect(classifyStatusTimerOutput('status-timer-no-linger\nstatus-timer-installed\n', true)).toBe('no-linger');
  });

  it('reports a node with no user session', () => {
    expect(classifyStatusTimerOutput('status-timer-no-user-session\n', true)).toBe('no-user-session');
  });

  it('treats a missing success marker as failure even on exit 0', () => {
    // The script is run over SSH; a truncated or interrupted run must not read as
    // success just because the channel closed cleanly.
    expect(classifyStatusTimerOutput('', true)).toBe('failed');
    expect(classifyStatusTimerOutput('status-timer-installed', false)).toBe('failed');
  });

  it('describes every outcome in words an operator can act on', () => {
    for (const outcome of ['installed', 'no-linger', 'no-user-session', 'failed'] as const) {
      expect(describeStatusTimerOutcome(outcome).length).toBeGreaterThan(10);
    }
  });
});
