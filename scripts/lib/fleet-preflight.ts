/**
 * Is this machine safe to hand a package transaction, before anything is typed on it?
 *
 * The load gate in `fleet-hardware.ts` already answers one question — is the box too busy — and it
 * stays exactly where it is. This file answers the four others that a 2026-09-10 pass over eighteen
 * nodes found nobody was asking, each of which turned an install into a late, confusing failure or
 * a machine needing hands-on recovery:
 *
 *   · **A wedged dpkg.** One node's package system was broken for weeks. The documented cause was a
 *     failed kernel removal; the real one was grub-customizer's `*_proxy` scripts in `/etc/grub.d`,
 *     which emit an invalid `grub.cfg` once a kernel they name is gone, so `update-grub` refuses it
 *     and every kernel postinst fails. `dpkg --audit` and `apt-get check` showed the wedge instantly.
 *     Nothing looked.
 *   · **No way back from a bad boot.** Two nodes run `GRUB_TIMEOUT_STYLE=hidden` with
 *     `GRUB_TIMEOUT=0`, and one of them has no IPMI. A kernel or initramfs that fails to boot there is
 *     unrecoverable without a trip. Nothing warned before an operation that touches those.
 *   · **No passwordless sudo.** Three nodes lacked it for the `ci` account (they run sudo-rs; every
 *     working node has `/etc/sudoers.d/ci-passwordless`). Installs failed at step six rather than
 *     step zero. One of the three is CI-OS, whose account is unprivileged **by design** — that is a
 *     report, never a fault to fix.
 *   · **A phantom 24-hour unattended-upgrade.** It was `unattended-upgrade-shutdown
 *     --wait-for-signal`, an idle boot-time hook that holds no lock. A real lock holder and that
 *     process look alike in `ps`; only the lock table tells them apart, so that is what is read.
 *
 * Every check is a pure function over command output, so each one is testable against the real
 * output that misled us. The SSH round trip is a single script and a single call; the verdict is
 * decided here and rendered by the CLI.
 */

import { sshCapture, type SshTarget } from './fleet-ssh.js';

/**
 * Section marker in the probe output. Also what excludes our own shell from the process listing:
 * the whole script travels in the login shell's argv, so any process carrying it is us.
 */
export const PROBE_MARKER = '__CIHUB_PF__';

export type PreflightSeverity = 'block' | 'warn' | 'info';

export type PreflightCheck = 'sudo' | 'dpkg' | 'grub-customizer' | 'boot-recovery' | 'apt-lock';

export const PREFLIGHT_CHECKS: readonly PreflightCheck[] = ['sudo', 'dpkg', 'grub-customizer', 'boot-recovery', 'apt-lock'];

export interface PreflightFinding {
  check: PreflightCheck;
  /** Nothing to report. When false, `severity` says how much it matters. */
  ok: boolean;
  /**
   * `block` stops the node unless forced; `warn` is printed and the run continues; `info` is a fact
   * worth a line and nothing more (the CI-OS account that has no sudo on purpose).
   */
  severity: PreflightSeverity;
  /** What was observed, in one line. */
  value: string;
  /** Where it was read from — the evidence, so a reader can re-check it by hand. */
  via: string;
  /** What to do about it. Only when there is something to do. */
  fix?: string;
}

/** Context the pure checks need that does not come from the machine itself. */
export interface PreflightContext {
  /**
   * True when the operation about to run can touch the kernel, initramfs or GRUB. Turns the
   * boot-recovery and grub-customizer findings from `warn` into `block`: a bad boot on a node with
   * no console and no menu window is exactly the outcome those two checks exist to prevent.
   */
  touchesBoot?: boolean;
  /**
   * The roster's out-of-band console for this node, if an operator recorded one (`oob` in
   * `fleet.json`): an IPMI address, a NanoKVM, a PiKVM. Anything present means a failed boot can be
   * reached without a trip. The host cannot see an external KVM, so this is the only source for it.
   */
  rosterOob?: string;
}

const ok = (check: PreflightCheck, value: string, via: string): PreflightFinding => ({ check, ok: true, severity: 'info', value, via });

/** `dpkg --audit` names offenders as lines starting with one space; its prose does not. */
function auditPackages(audit: string): string[] {
  return audit
    .split('\n')
    .map((line) => /^ (\S+)/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

const list = (items: readonly string[], max = 4): string =>
  items.length > max ? `${items.slice(0, max).join(', ')}, +${items.length - max} more` : items.join(', ');

/**
 * Is the package system wedged?
 *
 * `dpkg --audit` prints nothing on a healthy machine; anything at all is a package half-configured or
 * unpacked-but-unconfigured, and every later `apt`/`dpkg` run will try to finish it first and fail
 * the same way. `apt-get check` catches what the audit does not (unmet dependencies, an interrupted
 * dpkg). A lock failure or a permission failure from `apt-get check` is **not** a wedge — the first
 * belongs to `aptLockHolder`, the second to `sudoPosture` — so neither is counted here.
 */
export function dpkgWedged(input: { audit: string; auditCode: number | null; aptCheck: string; aptCheckCode: number | null }): PreflightFinding {
  const via = 'dpkg --audit; apt-get check';
  if (input.auditCode === 127 || /dpkg: (command )?not found/i.test(input.audit)) {
    return ok('dpkg', 'no dpkg on this node', via);
  }
  const pending = auditPackages(input.audit);
  const apt = input.aptCheck;
  const aptLocked = /could not get lock|unable to acquire the dpkg frontend lock \(.*\), is another process/i.test(apt);
  const aptUnprivileged = /permission denied|are you root\?/i.test(apt);
  const aptBroken =
    input.aptCheckCode !== null && input.aptCheckCode !== 0 && !aptLocked && !aptUnprivileged
      ? apt
          .split('\n')
          .filter((line) => line.startsWith('E:'))
          .map((line) => line.replace(/^E:\s*/, ''))
      : [];

  if (pending.length === 0 && aptBroken.length === 0) {
    const caveat = aptLocked
      ? ' (apt-get check could not take the lock; see apt-lock)'
      : aptUnprivileged
        ? ' (apt-get check needs root; audit only)'
        : '';
    return ok('dpkg', `clean${caveat}`, via);
  }

  const parts: string[] = [];
  if (pending.length) parts.push(`${pending.length} package(s) half-configured or unconfigured: ${list(pending)}`);
  if (aptBroken.length) parts.push(aptBroken.join('; '));
  const kernelInvolved = pending.some((p) => /^linux-(image|headers|modules)/.test(p)) || /kernel|initramfs|grub/i.test(apt);
  return {
    check: 'dpkg',
    ok: false,
    severity: 'block',
    value: parts.join(' — '),
    via,
    fix: `run 'dpkg --configure -a' (then 'apt-get -f install') on the node and read the first error.${
      kernelInvolved
        ? ' A kernel postinst failing inside update-grub is the grub-customizer proxy wedge — see that finding; removing the proxies is the fix, not retrying.'
        : ''
    } Every package operation on this node fails until this is clear.`,
  };
}

/**
 * Are grub-customizer's proxy scripts installed?
 *
 * grub-customizer rewrites `/etc/grub.d` into `*_proxy` wrappers plus a `.script_sources.txt`
 * manifest (and usually `bin/` and `proxifiedScripts/`). The wrappers render the menu from a saved
 * list of kernels; once one of those kernels is removed, the generated `grub.cfg` is invalid,
 * `update-grub` refuses to install it, and every kernel postinst from then on fails — the wedge that
 * kept one node's dpkg broken for weeks under a wrong diagnosis. Present-but-not-yet-broken is a
 * hazard that a kernel operation will trip, so it blocks those and warns the rest.
 */
export function grubCustomizerProxies(input: { grubDir: string }, ctx: PreflightContext = {}): PreflightFinding {
  const via = 'ls -1a /etc/grub.d';
  const entries = input.grubDir
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== '.' && l !== '..');
  if (entries.length === 0) return ok('grub-customizer', 'no /etc/grub.d (not a GRUB system)', via);
  const proxies = entries.filter((e) => /_proxy$/.test(e) || e === '.script_sources.txt');
  const traces = entries.filter((e) => e === 'bin' || e === 'proxifiedScripts');
  if (proxies.length === 0) return ok('grub-customizer', 'none', via);
  return {
    check: 'grub-customizer',
    ok: false,
    severity: ctx.touchesBoot ? 'block' : 'warn',
    value: `grub-customizer proxies present: ${list([...proxies, ...traces])}`,
    via,
    fix: "remove the *_proxy files and .script_sources.txt from /etc/grub.d (restore the originals from proxifiedScripts/), then run 'update-grub' and confirm it succeeds. Until then the next kernel remove or install wedges dpkg.",
  };
}

/** Last assignment wins, as it does when the file is sourced. Quotes are optional. */
function grubVar(text: string, name: string): string | undefined {
  let value: string | undefined;
  for (const line of text.split('\n')) {
    const m = new RegExp(`^\\s*${name}=\\s*"?([^"#]*?)"?\\s*(#.*)?$`).exec(line);
    if (m) value = m[1]?.trim();
  }
  return value;
}

/**
 * Can a boot that fails here be recovered without a trip?
 *
 * Ubuntu's default is `GRUB_TIMEOUT_STYLE=hidden` with `GRUB_TIMEOUT=0`: no menu, no window in which
 * to choose the previous kernel. That is fine on a machine with an out-of-band console — IPMI, or a
 * KVM plugged into it — because the console can still reach GRUB on the retry. On a machine with
 * neither, a kernel or initramfs that does not come up is a machine that does not come up. Two of
 * this fleet's nodes are in that state and nothing said so before operations that touch boot.
 *
 * IPMI is read from the host (`/sys/class/ipmi`); an external KVM is invisible to the host and must
 * be in the roster.
 */
export function unrecoverableBoot(input: { grubDefault: string; ipmi: string }, ctx: PreflightContext = {}): PreflightFinding {
  const via = '/etc/default/grub; /sys/class/ipmi; roster oob';
  const ipmiPresent = input.ipmi.split('\n').some((l) => l.trim());
  const oobConsole = ctx.rosterOob?.trim() ? `roster: ${ctx.rosterOob.trim()}` : ipmiPresent ? 'ipmi (on host)' : undefined;

  if (!input.grubDefault.trim()) return ok('boot-recovery', `no /etc/default/grub${oobConsole ? `; console ${oobConsole}` : ''}`, via);

  const style = (grubVar(input.grubDefault, 'GRUB_TIMEOUT_STYLE') ?? 'menu').toLowerCase();
  const timeoutRaw = grubVar(input.grubDefault, 'GRUB_TIMEOUT');
  const timeout = timeoutRaw === undefined ? 5 : Number(timeoutRaw);
  const noWindow = style === 'hidden' && timeout === 0;
  const grub = `GRUB_TIMEOUT_STYLE=${style} GRUB_TIMEOUT=${timeoutRaw ?? '(default 5)'}`;

  if (!noWindow) return ok('boot-recovery', `${grub}${oobConsole ? `; console ${oobConsole}` : '; no out-of-band console known'}`, via);
  if (oobConsole) return ok('boot-recovery', `${grub}, reachable via ${oobConsole}`, via);
  return {
    check: 'boot-recovery',
    ok: false,
    severity: ctx.touchesBoot ? 'block' : 'warn',
    value: `${grub}, no IPMI on the host, no console in the roster — a failed boot needs physical access`,
    via,
    fix: 'give the node a console and record it in fleet.json as "oob" (e.g. "nanokvm 192.168.0.115"); and set GRUB_TIMEOUT_STYLE=menu, GRUB_TIMEOUT=5 in /etc/default/grub then \'update-grub\', so that console can pick the previous kernel.',
  };
}

/** Does `/etc/os-release` say this is CI-OS? It keeps `ID=ubuntu` for apt's sake; the name is the tell. */
export function isCiOs(osRelease: string): boolean {
  return /^(PRETTY_NAME|NAME)=["']?CI[ -]?OS\b/im.test(osRelease);
}

/**
 * Can this account become root without a prompt?
 *
 * `ssh -n` has no TTY, so a sudo that wants a password does not ask — it fails, six steps in, with a
 * message about a terminal. `sudo -n true` answers the question in one round trip at step zero.
 *
 * CI-OS is the exception that must stay one: its `ci` account is unprivileged by design, so that
 * result is reported as information, never as a block. Fixing it would be undoing a decision.
 */
export function sudoPosture(input: {
  uid: string;
  user: string;
  sudoOutput: string;
  sudoCode: number | null;
  sudoVersion: string;
  osRelease: string;
  sudoersDir: string;
}): PreflightFinding {
  const via = 'sudo -n true; sudo --version; /etc/sudoers.d; /etc/os-release';
  const user = input.user.trim() || 'this account';
  if (input.uid.trim() === '0') return ok('sudo', `root (${user})`, via);

  const flavour = /sudo-rs/i.test(input.sudoVersion) ? 'sudo-rs' : /^sudo version/i.test(input.sudoVersion.trim()) ? 'sudo' : undefined;
  if (input.sudoCode === 0) {
    const grant = input.sudoersDir
      .split('\n')
      .map((l) => l.trim())
      .find((f) => f === `${user}-passwordless` || f === 'ci-passwordless' || f === `${user}-ci-os`);
    return ok('sudo', `passwordless${flavour ? ` (${flavour})` : ''}${grant ? ` via /etc/sudoers.d/${grant}` : ''}`, via);
  }

  const noBinary = input.sudoCode === 127 || /sudo: (command )?not found/i.test(input.sudoOutput);
  const notInSudoers = /not in the sudoers file|is not allowed to run sudo|not allowed to execute/i.test(input.sudoOutput);
  const observed = noBinary
    ? 'no sudo binary'
    : notInSudoers
      ? `${user} is not in sudoers`
      : `sudo wants a password${flavour ? ` (${flavour})` : ''}`;

  if (isCiOs(input.osRelease)) {
    return {
      check: 'sudo',
      ok: false,
      severity: 'info',
      value: `${observed} — CI OS: this account is unprivileged by design`,
      via,
    };
  }
  return {
    check: 'sudo',
    ok: false,
    severity: 'block',
    value: `${observed}; every root step of an install fails late over ssh -n`,
    via,
    fix: noBinary
      ? `install sudo on the node, then grant ${user} passwordless sudo (below)`
      : `on the node, once, with a password: echo '${user} ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/${user}-passwordless && sudo chmod 0440 /etc/sudoers.d/${user}-passwordless — the shape every working node in this fleet already has`,
  };
}

interface Proc {
  pid: string;
  seconds: number;
  args: string;
}

/** `ps -eo pid=,etimes=,args=` rows, minus our own probe (its argv carries the section marker). */
function parseProcs(text: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of text.split('\n')) {
    if (line.includes(PROBE_MARKER) || /grep -/.test(line)) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    procs.push({ pid: m[1] as string, seconds: Number(m[2]), args: (m[3] as string).trim() });
  }
  return procs;
}

const age = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return '';
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
};

const IDLE_SHUTDOWN_HOOK = /unattended-upgrade-shutdown\b.*--wait-for-signal/;
/** Command words that hold the dpkg lock for as long as they run. */
const HOLDS_DPKG = /(^|\/)(dpkg|apt-get|apt|aptitude|unattended-upgrade|unattended-upgrade-shutdown|synaptic)( |$)/;
/** Commands that touch apt without taking the dpkg lock — a download or list refresh in flight. */
const TOUCHES_APT = /(^|\/)(apt\.systemd\.daily)( |$)/;
const FREE_OF_LOCKS = /(^|\/)(apt-get|apt)(\s+-\S+)*\s+(update|check|download|source|changelog|showsrc|policy|search|show|list)\b/;

/**
 * Is somebody holding the package lock, and is it somebody real?
 *
 * The lock table is the evidence; the process list is the description. A row in `lslocks` on
 * `/var/lib/dpkg/lock*` is a transaction in progress, and starting another behind it fails or —
 * worse — waits. `unattended-upgrade-shutdown --wait-for-signal` sits in `ps` on every Ubuntu box
 * from boot onwards, holds no lock, and was read as a 24-hour stuck upgrade on this fleet. It is
 * reported as what it is and never flagged.
 */
export function aptLockHolder(input: { locks: string; processes: string }): PreflightFinding {
  const via = 'lslocks; ps -eo pid,etimes,args';
  const procs = parseProcs(input.processes);
  const byPid = new Map(procs.map((p) => [p.pid, p]));

  const lockRows = input.locks
    .split('\n')
    .map((line) => /^\s*(\S+)\s+(\d+)\s+(\S+)/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ command: m[1] as string, pid: m[2] as string, path: m[3] as string }));
  const dpkgLocks = lockRows.filter((r) => r.path.startsWith('/var/lib/dpkg/lock'));
  const aptLocks = lockRows.filter((r) => r.path.startsWith('/var/lib/apt/') || r.path.startsWith('/var/cache/apt/'));

  const describe = (pid: string, command: string): string => {
    const p = byPid.get(pid);
    const since = p ? ` for ${age(p.seconds)}` : '';
    return `PID ${pid} ${p ? p.args.slice(0, 80) : command}${since}`;
  };

  if (dpkgLocks.length) {
    const holder = dpkgLocks[0] as { command: string; pid: string; path: string };
    return {
      check: 'apt-lock',
      ok: false,
      severity: 'block',
      value: `dpkg lock held by ${describe(holder.pid, holder.command)}`,
      via,
      fix: 'wait for it, or read its journal if it has been running for hours. Never delete the lock file.',
    };
  }

  const idle = procs.filter((p) => IDLE_SHUTDOWN_HOOK.test(p.args));
  const active = procs.filter((p) => !IDLE_SHUTDOWN_HOOK.test(p.args) && (HOLDS_DPKG.test(p.args) || TOUCHES_APT.test(p.args)));
  const holders = active.filter((p) => HOLDS_DPKG.test(p.args) && !FREE_OF_LOCKS.test(p.args));

  if (holders.length) {
    // Running and lock-holding by nature, but no lock row: lslocks is missing or unreadable here.
    const p = holders[0] as Proc;
    const what = /unattended-upgrade-shutdown/.test(p.args) ? 'node is shutting down' : 'package transaction running';
    return {
      check: 'apt-lock',
      ok: false,
      severity: 'block',
      value: `${what}: PID ${p.pid} ${p.args.slice(0, 80)} for ${age(p.seconds)} (no lock table to confirm)`,
      via,
      fix: 'wait for it, or read its journal if it has been running for hours.',
    };
  }
  if (aptLocks.length || active.length) {
    const what = aptLocks.length
      ? `apt list/archive lock held by ${describe((aptLocks[0] as { pid: string; command: string }).pid, (aptLocks[0] as { command: string }).command)}`
      : `${(active[0] as Proc).args.slice(0, 80)} running for ${age((active[0] as Proc).seconds)}`;
    return {
      check: 'apt-lock',
      ok: false,
      severity: 'warn',
      value: `${what}; dpkg itself is free`,
      via,
      fix: 'usually an apt update or download; it finishes on its own.',
    };
  }
  const idleNote = idle.length ? ' (unattended-upgrade-shutdown --wait-for-signal is the idle boot-time hook — holds no lock)' : '';
  return ok('apt-lock', `free${idleNote}`, via);
}

/**
 * One round trip. Every read is best-effort and sectioned, so a missing tool costs its section and
 * nothing else; `rc=` lines carry the exit status the pure checks need. Root-needing reads go through
 * `sudo -n` only once it has been shown to work, so a node without sudo still reports what it can.
 *
 * `-o DPkg::Lock::Timeout=0` is load-bearing: newer apt waits for a held lock by default, which would
 * turn "the lock is held" into an SSH timeout that says nothing.
 */
export const PREFLIGHT_PROBE_SCRIPT = [
  `sec() { echo "${PROBE_MARKER} $1"; }`,
  'sec uid; id -u',
  'sec user; id -un',
  'sec os_release; cat /etc/os-release 2>/dev/null',
  'sec sudo_version; sudo --version 2>/dev/null | head -1',
  'sec sudo_n; sudo -n true 2>&1; echo "rc=$?"',
  'if [ "$(id -u)" = 0 ]; then S=""; elif sudo -n true >/dev/null 2>&1; then S="sudo -n"; else S=""; fi',
  'sec sudoers_d; $S ls -1 /etc/sudoers.d 2>/dev/null',
  'sec dpkg_audit; $S dpkg --audit 2>&1; echo "rc=$?"',
  'sec apt_check; DEBIAN_FRONTEND=noninteractive $S apt-get -q -o DPkg::Lock::Timeout=0 check 2>&1; echo "rc=$?"',
  'sec grub_d; ls -1a /etc/grub.d 2>/dev/null',
  'sec grub_default; cat /etc/default/grub 2>/dev/null',
  'sec ipmi; ls -1 /sys/class/ipmi 2>/dev/null; [ -e /dev/ipmi0 ] && echo /dev/ipmi0',
  "sec locks; $S lslocks -n -o COMMAND,PID,PATH 2>/dev/null | grep -E '/var/lib/dpkg|/var/lib/apt|/var/cache/apt'",
  "sec procs; ps -eo pid=,etimes=,args= 2>/dev/null | grep -E '(^|/| )(apt|apt-get|aptitude|dpkg|unattended-upgrade[a-z-]*|apt\\.systemd\\.daily|synaptic)( |$)' | grep -v -e grep -e CIHUB_PF",
  'sec end',
  'true',
].join('\n');

export interface PreflightProbe {
  sections: Map<string, string>;
  /** The `end` marker arrived, so every section is present. */
  complete: boolean;
}

export function parsePreflightProbe(raw: string): PreflightProbe {
  const sections = new Map<string, string>();
  let current: string | undefined;
  let buffer: string[] = [];
  const flush = () => {
    if (current !== undefined) sections.set(current, buffer.join('\n').trim());
    buffer = [];
  };
  for (const line of raw.split('\n')) {
    if (line.startsWith(`${PROBE_MARKER} `)) {
      flush();
      current = line.slice(PROBE_MARKER.length + 1).trim();
      continue;
    }
    if (current !== undefined) buffer.push(line);
  }
  flush();
  return { sections, complete: sections.has('end') };
}

/** Split a section that ends in `rc=N` into its text and status. */
function withRc(section: string | undefined): { text: string; code: number | null } {
  if (section === undefined) return { text: '', code: null };
  const lines = section.split('\n');
  const last = lines[lines.length - 1] ?? '';
  const m = /^rc=(\d+)$/.exec(last.trim());
  if (!m) return { text: section, code: null };
  return { text: lines.slice(0, -1).join('\n').trim(), code: Number(m[1]) };
}

/** Which probe sections each check reads. A check whose sections did not arrive is *not measured*. */
const SECTIONS_FOR: Record<PreflightCheck, readonly string[]> = {
  sudo: ['uid', 'user', 'sudo_n'],
  dpkg: ['dpkg_audit', 'apt_check'],
  'grub-customizer': ['grub_d'],
  'boot-recovery': ['grub_default', 'ipmi'],
  'apt-lock': ['locks', 'procs'],
};

/**
 * Run every check over one probe's output. Pure: the SSH call is the caller's.
 *
 * A section the probe never reached — the SSH budget ran out mid-script — is reported as not
 * measured and rated `warn`, never as a pass. An unmeasured safety check that reads as clean is the
 * same failure this file exists to end.
 */
export function evaluatePreflight(probe: PreflightProbe, ctx: PreflightContext = {}): PreflightFinding[] {
  const s = (name: string) => probe.sections.get(name) ?? '';
  const measured = (check: PreflightCheck) => SECTIONS_FOR[check].every((name) => probe.sections.has(name));
  const unmeasured = (check: PreflightCheck): PreflightFinding => ({
    check,
    ok: false,
    severity: 'warn',
    value: 'not measured — the probe output ended before this section',
    via: 'preflight probe',
  });
  const sudo = withRc(probe.sections.get('sudo_n'));
  const audit = withRc(probe.sections.get('dpkg_audit'));
  const apt = withRc(probe.sections.get('apt_check'));
  return [
    measured('sudo')
      ? sudoPosture({
          uid: s('uid'),
          user: s('user'),
          sudoOutput: sudo.text,
          sudoCode: sudo.code,
          sudoVersion: s('sudo_version'),
          osRelease: s('os_release'),
          sudoersDir: s('sudoers_d'),
        })
      : unmeasured('sudo'),
    measured('dpkg') ? dpkgWedged({ audit: audit.text, auditCode: audit.code, aptCheck: apt.text, aptCheckCode: apt.code }) : unmeasured('dpkg'),
    measured('grub-customizer') ? grubCustomizerProxies({ grubDir: s('grub_d') }, ctx) : unmeasured('grub-customizer'),
    measured('boot-recovery') ? unrecoverableBoot({ grubDefault: s('grub_default'), ipmi: s('ipmi') }, ctx) : unmeasured('boot-recovery'),
    measured('apt-lock') ? aptLockHolder({ locks: s('locks'), processes: s('procs') }) : unmeasured('apt-lock'),
  ];
}

export type PreflightVerdict = 'ok' | 'info' | 'warn' | 'block';

export interface PreflightNodeReport {
  node: string;
  findings: PreflightFinding[];
  /** The worst thing found. */
  verdict: PreflightVerdict;
  /** Set when the probe itself could not run; `findings` is then empty. */
  error?: string;
  ms: number;
}

const RANK: Record<PreflightVerdict, number> = { ok: 0, info: 1, warn: 2, block: 3 };

export function preflightVerdict(findings: readonly PreflightFinding[]): PreflightVerdict {
  let worst: PreflightVerdict = 'ok';
  for (const f of findings) {
    if (f.ok) continue;
    if (RANK[f.severity] > RANK[worst]) worst = f.severity;
  }
  return worst;
}

/**
 * Probe one node and evaluate it. Never throws: a fleet sweep must describe every node, including
 * the one whose probe did not come back.
 */
export async function preflightNode(
  target: SshTarget,
  node: { name: string; oob?: string },
  opts: { touchesBoot?: boolean; timeoutMs?: number } = {},
): Promise<PreflightNodeReport> {
  const started = Date.now();
  const res = await sshCapture(target, `bash <<'CIHUB_PF_EOF'\n${PREFLIGHT_PROBE_SCRIPT}\nCIHUB_PF_EOF`, opts.timeoutMs ?? 60_000);
  const probe = parsePreflightProbe(res.out);
  // Output over exit status, as everywhere in fleet: the script ends in `true`, but a node that
  // answered with sections has told us what we asked. Only an empty reply is a failure.
  if (probe.sections.size === 0) {
    return {
      node: node.name,
      findings: [],
      verdict: 'block',
      error: res.err || `ssh exited ${res.code} with no readable output`,
      ms: Date.now() - started,
    };
  }
  const findings = evaluatePreflight(probe, { touchesBoot: opts.touchesBoot, rosterOob: node.oob });
  return { node: node.name, findings, verdict: preflightVerdict(findings), ms: Date.now() - started };
}

/**
 * Should the operation go ahead on this node?
 *
 * `block` stops it unless `force`; a probe that could not run is a block too — "could not tell" is
 * not "clear" for a check whose whole purpose is that nothing looked. `warn` and `info` never stop
 * anything; they are printed by the caller.
 */
export function gatePreflight(report: PreflightNodeReport, opts: { force?: boolean } = {}): { proceed: boolean; detail: string } {
  if (report.error) {
    return opts.force
      ? { proceed: true, detail: `preflight could not run (${report.error.slice(0, 120)}) — continuing under --force` }
      : { proceed: false, detail: `preflight could not run: ${report.error.slice(0, 160)}. Re-run with --force to proceed unchecked.` };
  }
  const blocking = report.findings.filter((f) => !f.ok && f.severity === 'block');
  const warning = report.findings.filter((f) => !f.ok && f.severity === 'warn');
  const summary = (fs: readonly PreflightFinding[]) => fs.map((f) => `${f.check}: ${f.value}`).join('; ');
  if (blocking.length) {
    return opts.force
      ? { proceed: true, detail: `BLOCK overridden by --force — ${summary(blocking)}` }
      : { proceed: false, detail: `${summary(blocking).replace(/\.$/, '')}. Re-run with --force to override.` };
  }
  const info = report.findings.filter((f) => !f.ok && f.severity === 'info');
  if (warning.length) return { proceed: true, detail: `warn — ${summary(warning)}${info.length ? `; note — ${summary(info)}` : ''}` };
  if (info.length) return { proceed: true, detail: `clear; note — ${summary(info)}` };
  return { proceed: true, detail: 'sudo, dpkg, grub, boot recovery and apt lock all clear' };
}
