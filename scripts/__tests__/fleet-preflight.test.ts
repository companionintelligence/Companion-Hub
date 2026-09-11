/**
 * Fleet preflight — the checks nothing ran before a package transaction.
 *
 * Every fixture below is shaped like the real output that misled somebody on 2026-09-10:
 *
 *   · `dpkg --audit` naming the half-configured kernel packages on the node whose wedge went
 *     undiagnosed for weeks, and the `/etc/grub.d` listing that was the actual cause.
 *   · `/etc/default/grub` from the two nodes with no boot-menu window, one of them without IPMI.
 *   · `sudo -n true` from a sudo-rs node with no NOPASSWD grant, and from the CI-OS node whose account
 *     is unprivileged on purpose.
 *   · `ps` showing `unattended-upgrade-shutdown --wait-for-signal` — the idle boot-time hook that was
 *     read as a 24-hour stuck upgrade — next to a genuine lock holder.
 *
 * The false-positive cases matter as much as the true ones: a preflight that blocks a healthy node
 * is one that gets `--force`d out of habit.
 */

import { describe, expect, it } from 'vitest';
import {
  aptLockHolder,
  dpkgWedged,
  evaluatePreflight,
  gatePreflight,
  grubCustomizerProxies,
  isCiOs,
  parsePreflightProbe,
  PREFLIGHT_CHECKS,
  PREFLIGHT_PROBE_SCRIPT,
  PROBE_MARKER,
  preflightVerdict,
  sudoPosture,
  unrecoverableBoot,
  type PreflightFinding,
  type PreflightNodeReport,
} from '../lib/fleet-preflight.js';

// --- Fixtures ---------------------------------------------------------------------------------

/** razer, 2026-09-10: three kernel packages stuck for weeks. */
const RAZER_AUDIT = `The following packages are only half configured, probably due to problems
configuring them the first time.  The configuration should be retried using
dpkg --configure <package> or the configure menu option in dselect:
 linux-image-6.8.0-45-generic Signed kernel image generic
 linux-image-generic-hwe-22.04 Complete Generic Linux kernel and headers
 linux-headers-6.8.0-45-generic Linux kernel headers for version 6.8.0 on 64 bit x86 SMP
`;

const APT_CHECK_INTERRUPTED = `Reading package lists...
Building dependency tree...
Reading state information...
E: dpkg was interrupted, you must manually run 'dpkg --configure -a' to correct the problem.`;

const APT_CHECK_UNMET = `Reading package lists...
Building dependency tree...
Reading state information...
You might want to run 'apt --fix-broken install' to correct these.
The following packages have unmet dependencies:
 rocm-dkms : Depends: rock-dkms but it is not installed
E: Unmet dependencies. Try 'apt --fix-broken install' with no packages (or specify a solution).`;

const APT_CHECK_CLEAN = `Reading package lists...
Building dependency tree...
Reading state information...`;

const APT_CHECK_LOCKED = `E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4021 (apt-get)
N: Be aware that removing the lock file is not a solution and may break your system.
E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?`;

const APT_CHECK_UNPRIVILEGED = `E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)
E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?`;

/** razer's /etc/grub.d after grub-customizer. The proxies, the manifest, and the two directories it leaves. */
const RAZER_GRUB_D = `.
..
00_header
05_debian_theme
10_linux_proxy
20_linux_xen
30_os-prober_proxy
30_uefi-firmware
35_fwupd
40_custom
41_custom
.script_sources.txt
bin
proxifiedScripts
README`;

const STOCK_GRUB_D = `.
..
00_header
05_debian_theme
10_linux
10_linux_zfs
20_linux_xen
30_os-prober
30_uefi-firmware
35_fwupd
40_custom
41_custom
README`;

/** core-10 and razer: Ubuntu's default, no window in which to pick the previous kernel. */
const GRUB_HIDDEN_ZERO = `# If you change this file, run 'update-grub' afterwards to update
# /boot/grub/grub.cfg.
GRUB_DEFAULT=0
GRUB_TIMEOUT_STYLE=hidden
GRUB_TIMEOUT=0
GRUB_DISTRIBUTOR=\`( . /etc/os-release; echo \${NAME} )\`
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"
GRUB_CMDLINE_LINUX=""
#GRUB_TIMEOUT=10`;

const GRUB_MENU_FIVE = `GRUB_DEFAULT=0
GRUB_TIMEOUT_STYLE=menu
GRUB_TIMEOUT="5"
GRUB_CMDLINE_LINUX_DEFAULT=""`;

const OS_RELEASE_UBUNTU = `PRETTY_NAME="Ubuntu 24.04.3 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
ID=ubuntu
ID_LIKE=debian`;

/** CI-OS keeps ID=ubuntu so apt and ROCm behave; the name is the tell. */
const OS_RELEASE_CI_OS = `PRETTY_NAME="CI OS"
NAME="CI OS"
VERSION_ID="24.04"
ID=ubuntu
ID_LIKE=debian
UBUNTU_CODENAME=noble`;

/** The idle boot-time hook, alone. Up for a day, holding nothing. */
const PS_IDLE_HOOK = '   1187   86412 /usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal';

/** The same hook next to a real transaction. */
const PS_ACTIVE_UPGRADE = `   1187   86412 /usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal
  40210    3612 /usr/bin/python3 /usr/bin/unattended-upgrade
  40388    3598 /usr/bin/dpkg --status-fd 10 --configure --pending`;

const LSLOCKS_ACTIVE_UPGRADE = `unattended-upgr 40210 /var/lib/dpkg/lock-frontend
dpkg            40388 /var/lib/dpkg/lock`;

const finding = (over: Partial<PreflightFinding>): PreflightFinding => ({ check: 'sudo', ok: true, severity: 'info', value: '', via: '', ...over });
const report = (over: Partial<PreflightNodeReport>): PreflightNodeReport => ({ node: 'n', findings: [], verdict: 'ok', ms: 1, ...over });

// --- dpkg -------------------------------------------------------------------------------------

describe('dpkgWedged', () => {
  it('blocks on the audit that showed razer wedged, and names the kernel packages', () => {
    const f = dpkgWedged({ audit: RAZER_AUDIT, auditCode: 0, aptCheck: APT_CHECK_INTERRUPTED, aptCheckCode: 100 });
    expect(f.ok).toBe(false);
    expect(f.severity).toBe('block');
    expect(f.value).toContain('3 package(s)');
    expect(f.value).toContain('linux-image-6.8.0-45-generic');
    expect(f.value).toContain('dpkg was interrupted');
    // The wedge was misdiagnosed for weeks as a kernel removal; the fix line points at the real cause.
    expect(f.fix).toContain('grub-customizer');
  });

  it('blocks on unmet dependencies even when the audit is clean', () => {
    const f = dpkgWedged({ audit: '', auditCode: 0, aptCheck: APT_CHECK_UNMET, aptCheckCode: 100 });
    expect(f.ok).toBe(false);
    expect(f.severity).toBe('block');
    expect(f.value).toContain('Unmet dependencies');
    expect(f.value).not.toContain('package(s) half-configured');
  });

  it('passes a clean machine', () => {
    const f = dpkgWedged({ audit: '', auditCode: 0, aptCheck: APT_CHECK_CLEAN, aptCheckCode: 0 });
    expect(f.ok).toBe(true);
    expect(f.value).toBe('clean');
    expect(f.via).toContain('dpkg --audit');
  });

  it('does not read a held lock as a wedge', () => {
    // That is the apt-lock check's finding. Counting it twice would block a node for one cause.
    const f = dpkgWedged({ audit: '', auditCode: 0, aptCheck: APT_CHECK_LOCKED, aptCheckCode: 100 });
    expect(f.ok).toBe(true);
    expect(f.value).toContain('see apt-lock');
  });

  it('does not read a permission failure as a wedge', () => {
    // No sudo means apt-get check could not run; the sudo finding says so. The audit still counts.
    const clean = dpkgWedged({ audit: '', auditCode: 0, aptCheck: APT_CHECK_UNPRIVILEGED, aptCheckCode: 100 });
    expect(clean.ok).toBe(true);
    expect(clean.value).toContain('needs root');
    const wedged = dpkgWedged({ audit: RAZER_AUDIT, auditCode: 0, aptCheck: APT_CHECK_UNPRIVILEGED, aptCheckCode: 100 });
    expect(wedged.severity).toBe('block');
  });

  it('is not applicable on a machine without dpkg', () => {
    expect(dpkgWedged({ audit: 'bash: line 9: dpkg: command not found', auditCode: 127, aptCheck: '', aptCheckCode: 127 }).ok).toBe(true);
    expect(dpkgWedged({ audit: 'sudo: dpkg: command not found', auditCode: 1, aptCheck: '', aptCheckCode: 1 }).value).toBe('no dpkg on this node');
  });
});

// --- grub-customizer --------------------------------------------------------------------------

describe('grubCustomizerProxies', () => {
  it('finds the proxies and the manifest on razer', () => {
    const f = grubCustomizerProxies({ grubDir: RAZER_GRUB_D });
    expect(f.ok).toBe(false);
    expect(f.value).toContain('10_linux_proxy');
    expect(f.value).toContain('30_os-prober_proxy');
    expect(f.value).toContain('.script_sources.txt');
    expect(f.fix).toContain('update-grub');
  });

  it('warns for an ordinary install and blocks for one that touches boot', () => {
    expect(grubCustomizerProxies({ grubDir: RAZER_GRUB_D }).severity).toBe('warn');
    expect(grubCustomizerProxies({ grubDir: RAZER_GRUB_D }, { touchesBoot: true }).severity).toBe('block');
  });

  it('passes a stock /etc/grub.d', () => {
    const f = grubCustomizerProxies({ grubDir: STOCK_GRUB_D });
    expect(f.ok).toBe(true);
    expect(f.value).toBe('none');
  });

  it('is not applicable where there is no /etc/grub.d', () => {
    expect(grubCustomizerProxies({ grubDir: '' }).ok).toBe(true);
  });
});

// --- boot-recovery ----------------------------------------------------------------------------

describe('unrecoverableBoot', () => {
  it('flags hidden + 0 with no IPMI and nothing in the roster (core-10)', () => {
    const f = unrecoverableBoot({ grubDefault: GRUB_HIDDEN_ZERO, ipmi: '' });
    expect(f.ok).toBe(false);
    expect(f.severity).toBe('warn');
    expect(f.value).toContain('GRUB_TIMEOUT_STYLE=hidden');
    expect(f.value).toContain('GRUB_TIMEOUT=0');
    expect(f.value).toContain('physical access');
    expect(f.fix).toContain('"oob"');
  });

  it('blocks the same node before an operation that touches boot', () => {
    expect(unrecoverableBoot({ grubDefault: GRUB_HIDDEN_ZERO, ipmi: '' }, { touchesBoot: true }).severity).toBe('block');
  });

  it('passes the same GRUB settings when the host has IPMI', () => {
    const f = unrecoverableBoot({ grubDefault: GRUB_HIDDEN_ZERO, ipmi: 'ipmi0' }, { touchesBoot: true });
    expect(f.ok).toBe(true);
    expect(f.value).toContain('ipmi');
  });

  it('passes when the roster records an out-of-band console the host cannot see', () => {
    // A NanoKVM on the HDMI port is invisible from inside the machine; the roster is the only source.
    const f = unrecoverableBoot({ grubDefault: GRUB_HIDDEN_ZERO, ipmi: '' }, { touchesBoot: true, rosterOob: 'nanokvm 192.168.0.115' });
    expect(f.ok).toBe(true);
    expect(f.value).toContain('nanokvm 192.168.0.115');
  });

  it('passes a visible menu with a timeout, and says no console is known', () => {
    const f = unrecoverableBoot({ grubDefault: GRUB_MENU_FIVE, ipmi: '' });
    expect(f.ok).toBe(true);
    expect(f.value).toContain('GRUB_TIMEOUT=5');
    expect(f.value).toContain('no out-of-band console known');
  });

  it('reads the last assignment, not a commented one', () => {
    // GRUB_HIDDEN_ZERO ends with `#GRUB_TIMEOUT=10`; the effective value is still 0.
    expect(unrecoverableBoot({ grubDefault: GRUB_HIDDEN_ZERO, ipmi: '' }).ok).toBe(false);
    const overridden = `${GRUB_HIDDEN_ZERO}\nGRUB_TIMEOUT=3\nGRUB_TIMEOUT_STYLE=menu`;
    expect(unrecoverableBoot({ grubDefault: overridden, ipmi: '' }).ok).toBe(true);
  });

  it('treats a missing style as menu, which is GRUB’s own default', () => {
    expect(unrecoverableBoot({ grubDefault: 'GRUB_TIMEOUT=0', ipmi: '' }).ok).toBe(true);
  });

  it('is not applicable where there is no /etc/default/grub', () => {
    expect(unrecoverableBoot({ grubDefault: '', ipmi: '' }).ok).toBe(true);
  });
});

// --- sudo -------------------------------------------------------------------------------------

describe('sudoPosture', () => {
  const base = { uid: '1000', user: 'ci', sudoVersion: 'sudo-rs 0.2.6', osRelease: OS_RELEASE_UBUNTU, sudoersDir: '' };

  it('blocks a sudo-rs node that wants a password, with the one-line fix every working node has', () => {
    const f = sudoPosture({ ...base, sudoOutput: 'sudo-rs: Authentication failed, a password is needed', sudoCode: 1 });
    expect(f.ok).toBe(false);
    expect(f.severity).toBe('block');
    expect(f.value).toContain('sudo-rs');
    expect(f.fix).toContain('/etc/sudoers.d/ci-passwordless');
    expect(f.fix).toContain('NOPASSWD:ALL');
  });

  it('reports, and does not block, the CI-OS account that is unprivileged by design', () => {
    const f = sudoPosture({ ...base, osRelease: OS_RELEASE_CI_OS, sudoOutput: 'sudo: a password is required', sudoCode: 1 });
    expect(f.ok).toBe(false);
    expect(f.severity).toBe('info');
    expect(f.value).toContain('by design');
    expect(f.fix).toBeUndefined();
  });

  it('passes a passwordless account and names the grant', () => {
    const f = sudoPosture({ ...base, sudoOutput: '', sudoCode: 0, sudoersDir: 'README\nci-passwordless' });
    expect(f.ok).toBe(true);
    expect(f.value).toContain('passwordless');
    expect(f.value).toContain('/etc/sudoers.d/ci-passwordless');
  });

  it('passes root without asking sudo anything', () => {
    const f = sudoPosture({ ...base, uid: '0', user: 'root', sudoOutput: 'sudo: command not found', sudoCode: 127 });
    expect(f.ok).toBe(true);
    expect(f.value).toContain('root');
  });

  it('tells "not in sudoers" and "no sudo binary" apart from "wants a password"', () => {
    expect(sudoPosture({ ...base, sudoOutput: 'ci is not in the sudoers file.  This incident will be reported.', sudoCode: 1 }).value).toContain(
      'not in sudoers',
    );
    const none = sudoPosture({ ...base, sudoOutput: 'bash: line 5: sudo: command not found', sudoCode: 127 });
    expect(none.value).toContain('no sudo binary');
    expect(none.fix).toContain('install sudo');
  });

  it('recognises CI OS by name, not by ID, which it keeps as ubuntu for apt’s sake', () => {
    expect(isCiOs(OS_RELEASE_CI_OS)).toBe(true);
    expect(isCiOs(OS_RELEASE_UBUNTU)).toBe(false);
    expect(isCiOs('PRETTY_NAME="CI-OS 1.2"\nID=ubuntu')).toBe(true);
  });
});

// --- apt-lock ---------------------------------------------------------------------------------

describe('aptLockHolder', () => {
  it('does not flag the idle unattended-upgrade-shutdown --wait-for-signal hook', () => {
    // The "24-hour stuck unattended-upgrade". It holds no lock and never did.
    const f = aptLockHolder({ locks: '', processes: PS_IDLE_HOOK });
    expect(f.ok).toBe(true);
    expect(f.value).toContain('free');
    expect(f.value).toContain('idle boot-time hook');
  });

  it('blocks on a real dpkg lock holder and describes it from the process list', () => {
    const f = aptLockHolder({ locks: LSLOCKS_ACTIVE_UPGRADE, processes: PS_ACTIVE_UPGRADE });
    expect(f.ok).toBe(false);
    expect(f.severity).toBe('block');
    expect(f.value).toContain('PID 40210');
    expect(f.value).toContain('unattended-upgrade');
    expect(f.value).toContain('for 1h 0m');
    expect(f.value).not.toContain('wait-for-signal');
    expect(f.fix).toContain('Never delete the lock file');
  });

  it('blocks on a lock-holding process even without a lock table, and says the table was missing', () => {
    // lslocks absent or unreadable: dpkg --configure --pending holds the lock by nature.
    const f = aptLockHolder({ locks: '', processes: PS_ACTIVE_UPGRADE });
    expect(f.severity).toBe('block');
    expect(f.value).toContain('no lock table to confirm');
  });

  it('warns rather than blocks for an apt-get update, which takes the lists lock only', () => {
    const f = aptLockHolder({
      locks: 'apt-get 5120 /var/lib/apt/lists/lock',
      processes: `   5120      12 apt-get -q update\n${PS_IDLE_HOOK}`,
    });
    expect(f.ok).toBe(false);
    expect(f.severity).toBe('warn');
    expect(f.value).toContain('dpkg itself is free');
  });

  it('ignores our own probe and the grep that filtered the listing', () => {
    // The whole script rides in the login shell's argv, so it names apt-get, dpkg and the rest.
    const processes = [
      `  60001       2 bash -c [ -s "$HOME/.nvm/nvm.sh" ]; bash <<'CIHUB_PF_EOF' sec() { echo "${PROBE_MARKER} $1"; } ... apt-get -q check ... dpkg --audit`,
      '  60010       0 grep -E (^|/| )(apt|apt-get|dpkg)( |$)',
      PS_IDLE_HOOK,
    ].join('\n');
    expect(aptLockHolder({ locks: '', processes }).ok).toBe(true);
  });

  it('does not mistake dpkg-query for dpkg', () => {
    expect(aptLockHolder({ locks: '', processes: '   7001       1 dpkg-query -W -f=${Package}\\n' }).ok).toBe(true);
  });

  it('passes an idle machine with nothing to say', () => {
    const f = aptLockHolder({ locks: '', processes: '' });
    expect(f.ok).toBe(true);
    expect(f.value).toBe('free');
  });
});

// --- probe parsing and evaluation -------------------------------------------------------------

const section = (name: string, body: string) => `${PROBE_MARKER} ${name}\n${body}`;

function probeOutput(over: Partial<Record<string, string>> = {}): string {
  const defaults: Record<string, string> = {
    uid: '1000',
    user: 'ci',
    os_release: OS_RELEASE_UBUNTU,
    sudo_version: 'Sudo version 1.9.15p5',
    sudo_n: 'rc=0',
    sudoers_d: 'README\nci-passwordless',
    dpkg_audit: 'rc=0',
    apt_check: `${APT_CHECK_CLEAN}\nrc=0`,
    grub_d: STOCK_GRUB_D,
    grub_default: GRUB_MENU_FIVE,
    ipmi: '',
    locks: '',
    procs: PS_IDLE_HOOK,
    end: '',
  };
  return Object.entries({ ...defaults, ...over })
    .map(([k, v]) => section(k, v ?? ''))
    .join('\n');
}

describe('parsePreflightProbe', () => {
  it('splits the output into sections and knows when it is complete', () => {
    const probe = parsePreflightProbe(probeOutput());
    expect(probe.complete).toBe(true);
    expect(probe.sections.get('user')).toBe('ci');
    expect(probe.sections.get('grub_d')).toContain('10_linux');
  });

  it('keeps an rc= line with its section', () => {
    const probe = parsePreflightProbe(probeOutput({ dpkg_audit: `${RAZER_AUDIT}rc=0` }));
    expect(probe.sections.get('dpkg_audit')).toContain('linux-image-6.8.0-45-generic');
    expect(probe.sections.get('dpkg_audit')?.endsWith('rc=0')).toBe(true);
  });

  it('is incomplete without the end marker', () => {
    const cut = probeOutput().split(`${PROBE_MARKER} grub_d`)[0] as string;
    const probe = parsePreflightProbe(cut);
    expect(probe.complete).toBe(false);
    expect(probe.sections.has('grub_d')).toBe(false);
  });
});

describe('evaluatePreflight', () => {
  it('returns every check, in table order, for a clean node', () => {
    const findings = evaluatePreflight(parsePreflightProbe(probeOutput()));
    expect(findings.map((f) => f.check)).toEqual([...PREFLIGHT_CHECKS]);
    expect(findings.every((f) => f.ok)).toBe(true);
    expect(preflightVerdict(findings)).toBe('ok');
  });

  it('reproduces razer: sudo fine, dpkg blocked, proxies present, no boot window', () => {
    const findings = evaluatePreflight(
      parsePreflightProbe(
        probeOutput({
          dpkg_audit: `${RAZER_AUDIT}rc=0`,
          apt_check: `${APT_CHECK_INTERRUPTED}\nrc=100`,
          grub_d: RAZER_GRUB_D,
          grub_default: GRUB_HIDDEN_ZERO,
        }),
      ),
    );
    const by = Object.fromEntries(findings.map((f) => [f.check, f]));
    expect(by.sudo?.ok).toBe(true);
    expect(by.dpkg?.severity).toBe('block');
    expect(by['grub-customizer']?.severity).toBe('warn');
    expect(by['boot-recovery']?.severity).toBe('warn');
    expect(by['apt-lock']?.ok).toBe(true);
    expect(preflightVerdict(findings)).toBe('block');
  });

  it('reproduces localhost-0 (CI-OS): no sudo is information, and the verdict stays info', () => {
    const findings = evaluatePreflight(
      parsePreflightProbe(
        probeOutput({
          os_release: OS_RELEASE_CI_OS,
          sudo_n: 'sudo: a password is required\nrc=1',
          sudoers_d: '',
          apt_check: `${APT_CHECK_UNPRIVILEGED}\nrc=100`,
        }),
      ),
    );
    const by = Object.fromEntries(findings.map((f) => [f.check, f]));
    expect(by.sudo?.severity).toBe('info');
    expect(by.dpkg?.ok).toBe(true);
    expect(preflightVerdict(findings)).toBe('info');
  });

  it('passes the roster console and the boot flag through to the boot check', () => {
    const probe = parsePreflightProbe(probeOutput({ grub_default: GRUB_HIDDEN_ZERO }));
    expect(evaluatePreflight(probe, { touchesBoot: true }).find((f) => f.check === 'boot-recovery')?.severity).toBe('block');
    expect(evaluatePreflight(probe, { touchesBoot: true, rosterOob: 'ipmi 10.0.0.9' }).find((f) => f.check === 'boot-recovery')?.ok).toBe(true);
  });

  it('reports a section the probe never reached as not measured, never as clean', () => {
    // The SSH budget ran out after apt-get check. What did not run must not read as a pass.
    const cut = probeOutput().split(`${PROBE_MARKER} grub_d`)[0] as string;
    const findings = evaluatePreflight(parsePreflightProbe(cut));
    const by = Object.fromEntries(findings.map((f) => [f.check, f]));
    expect(by.sudo?.ok).toBe(true);
    expect(by.dpkg?.ok).toBe(true);
    for (const check of ['grub-customizer', 'boot-recovery', 'apt-lock'] as const) {
      expect(by[check]?.ok).toBe(false);
      expect(by[check]?.severity).toBe('warn');
      expect(by[check]?.value).toContain('not measured');
    }
  });
});

// --- the gate ---------------------------------------------------------------------------------

describe('gatePreflight', () => {
  it('proceeds on a clean report', () => {
    const gate = gatePreflight(report({ findings: [finding({ check: 'dpkg' })] }));
    expect(gate.proceed).toBe(true);
    expect(gate.detail).toContain('all clear');
  });

  it('stops on a block and names the flag that overrides it', () => {
    const gate = gatePreflight(
      report({ findings: [finding({ check: 'dpkg', ok: false, severity: 'block', value: '3 package(s) half-configured' })] }),
    );
    expect(gate.proceed).toBe(false);
    expect(gate.detail).toContain('dpkg: 3 package(s) half-configured');
    expect(gate.detail).toContain('--force');
  });

  it('proceeds under --force and marks the override in the detail', () => {
    const gate = gatePreflight(report({ findings: [finding({ check: 'dpkg', ok: false, severity: 'block', value: 'wedged' })] }), { force: true });
    expect(gate.proceed).toBe(true);
    expect(gate.detail).toContain('overridden by --force');
    expect(gate.detail).toContain('wedged');
  });

  it('proceeds on a warn and carries it in the detail', () => {
    const gate = gatePreflight(report({ findings: [finding({ check: 'boot-recovery', ok: false, severity: 'warn', value: 'no window' })] }));
    expect(gate.proceed).toBe(true);
    expect(gate.detail).toContain('warn');
    expect(gate.detail).toContain('boot-recovery: no window');
  });

  it('proceeds on info and still mentions it, so the CI-OS case is visible without being a fault', () => {
    const gate = gatePreflight(report({ findings: [finding({ check: 'sudo', ok: false, severity: 'info', value: 'unprivileged by design' })] }));
    expect(gate.proceed).toBe(true);
    expect(gate.detail).toContain('unprivileged by design');
  });

  it('treats a probe that could not run as a block, not as clear', () => {
    const gate = gatePreflight(report({ error: 'Timed out after 60000ms', verdict: 'block' }));
    expect(gate.proceed).toBe(false);
    expect(gate.detail).toContain('could not run');
    expect(gatePreflight(report({ error: 'x', verdict: 'block' }), { force: true }).proceed).toBe(true);
  });
});

// --- the probe script -------------------------------------------------------------------------

describe('PREFLIGHT_PROBE_SCRIPT', () => {
  it('reads with sudo only after showing sudo works, so a node without it still reports', () => {
    expect(PREFLIGHT_PROBE_SCRIPT).toContain('elif sudo -n true >/dev/null 2>&1; then S="sudo -n"');
    expect(PREFLIGHT_PROBE_SCRIPT).toContain('$S dpkg --audit');
    expect(PREFLIGHT_PROBE_SCRIPT).toContain('$S apt-get');
  });

  it('never waits on a held apt lock — that would turn the finding into a timeout', () => {
    expect(PREFLIGHT_PROBE_SCRIPT).toContain('DPkg::Lock::Timeout=0');
  });

  it('emits every section the checks read, and an end marker', () => {
    for (const name of ['uid', 'user', 'sudo_n', 'dpkg_audit', 'apt_check', 'grub_d', 'grub_default', 'ipmi', 'locks', 'procs', 'end']) {
      expect(PREFLIGHT_PROBE_SCRIPT).toContain(`sec ${name}`);
    }
  });

  it('excludes its own shell from the process listing', () => {
    // The script rides in the login shell's argv and names every tool it looks for.
    expect(PREFLIGHT_PROBE_SCRIPT).toMatch(/grep -v .*CIHUB_PF/);
  });

  it('ends in true, because its status is a sequence of best-effort reads', () => {
    expect(PREFLIGHT_PROBE_SCRIPT.trim().endsWith('true')).toBe(true);
  });

  it('mutates nothing', () => {
    expect(PREFLIGHT_PROBE_SCRIPT).not.toMatch(/apt-get (install|remove|upgrade|dist-upgrade|autoremove)/);
    expect(PREFLIGHT_PROBE_SCRIPT).not.toMatch(/dpkg (--configure|-i|--remove|--purge)/);
    expect(PREFLIGHT_PROBE_SCRIPT).not.toMatch(/update-grub|rm |tee |>\s*\/etc/);
  });
});
