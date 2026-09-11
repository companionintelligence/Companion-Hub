/**
 * Remote desktop on fleet nodes, bound to the tailnet and nothing else.
 *
 * Measured on this fleet (2026-09-10): RDP was running on 3 of 18 nodes and every one of them was
 * listening on `*:3389` — every interface, including the LAN. The other sixteen were then brought
 * up by hand, and that pass taught three things this module exists to remember:
 *
 *   · **xrdp 0.10 accepts and SILENTLY IGNORES the legacy `address=` key.** With `address=<tailnet
 *     ip>` and `port=3389` in `/etc/xrdp/xrdp.ini` it still listened on `*:3389`. The bind lives in
 *     the `port` directive as a URL — `port=tcp://<ip>:3389` — and nowhere else. The ini rewrite
 *     below removes any `address=` line for that reason: a key that looks like it binds and does not
 *     is worse than no key at all.
 *   · **gnome-remote-desktop in `--system` mode cannot bind an address.** Two nodes run it. The fix
 *     there is a firewall guard on tcp/3389 — accept from `tailscale0` and `lo`, reject everything
 *     else with a TCP reset so a LAN client sees "refused" instead of a hang — installed as a
 *     systemd oneshot that is idempotent and removes itself on stop.
 *   · **`--reject-with tcp-reset` requires `-p tcp`.** The first guard attempt failed on exactly
 *     that; the rule text below is tested for the order.
 *
 * Tailnet-only binding is not a preference and there is no flag to bind `*:3389`. Authentication
 * to these machines is the tailnet ACL; an RDP listener on the LAN is a second front door that the
 * ACL does not cover.
 *
 * Everything that decides is a pure function of text the node returned, so it can be tested without
 * a node. Nothing here runs against a machine unless the CLI passes `execute: true`.
 */

import { isTooBusyForMaintenance } from './fleet-hardware.js';
import { sshCapture, type SshTarget } from './fleet-ssh.js';

export const RDP_PORT = 3389;
export const GUARD_UNIT_NAME = 'rdp-tailnet-guard.service';
export const GUARD_UNIT_PATH = `/etc/systemd/system/${GUARD_UNIT_NAME}`;
export const GUARD_CHAIN = 'RDP_TAILNET_GUARD';
export const XRDP_INI_PATH = '/etc/xrdp/xrdp.ini';

/** The exact package set proven on eleven Ubuntu nodes. */
export const XRDP_PACKAGES = ['xrdp', 'xfce4', 'xfce4-terminal', 'dbus-x11'] as const;

// ─── Addresses ───────────────────────────────────────────────────────────────

/**
 * Tailscale's CGNAT range, 100.64.0.0/10: first octet 100, second octet 64–127. The IPv6 prefix is
 * the tailnet ULA every node also carries.
 */
export function isTailnetAddress(addr: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const [, a, b] = v4.map(Number);
    return a === 100 && b !== undefined && b >= 64 && b <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(addr);
}

export function isLoopbackAddress(addr: string): boolean {
  return /^127\./.test(addr) || addr === '::1';
}

/** Every spelling `ss` uses for "all interfaces". */
export function isWildcardAddress(addr: string): boolean {
  return addr === '*' || addr === '0.0.0.0' || addr === '::' || addr === '::ffff:0.0.0.0';
}

// ─── ss parsing ──────────────────────────────────────────────────────────────

export interface RdpListener {
  /** As `ss` printed it, brackets and `%iface` stripped: `*`, `0.0.0.0`, `::`, `100.101.102.103`. */
  address: string;
  port: number;
  /**
   * Process names from the `users:(...)` column. Empty when `ss` ran without the privilege to see
   * the owner — an unprivileged `ss -p` shows nothing for root's sockets, and xrdp runs as root.
   */
  processes: string[];
}

/**
 * Parse `ss -ltnp` output into listeners.
 *
 * Column layout is fixed for `-ltnp`: State, Recv-Q, Send-Q, Local Address:Port, Peer Address:Port,
 * Process. The local address needs care: IPv6 comes bracketed (`[::]:3389`), a scoped address
 * carries `%iface` (`127.0.0.53%lo:53`), and the port is after the LAST colon.
 */
export function parseSsListeners(text: string): RdpListener[] {
  const out: RdpListener[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || /^State\b/.test(line) || /^Netid\b/.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols[0] !== 'LISTEN' || cols.length < 4) continue;
    const local = cols[3] ?? '';
    const colon = local.lastIndexOf(':');
    if (colon < 0) continue;
    const port = Number(local.slice(colon + 1));
    if (!Number.isInteger(port)) continue;
    let address = local.slice(0, colon).replace(/^\[|\]$/g, '');
    const scope = address.indexOf('%');
    if (scope >= 0) address = address.slice(0, scope);
    const processes: string[] = [];
    // `users:(("xrdp",pid=1,fd=11),("xrdp",pid=2,fd=11))` — one socket may list several holders.
    for (const m of line.matchAll(/\("([^"]+)",pid=\d+/g)) processes.push(m[1] ?? '');
    out.push({ address, port, processes });
  }
  return out;
}

export type RdpOwner =
  | 'none'
  | 'xrdp'
  | 'gnome-remote-desktop'
  /** 3389 is held by something this tool will not touch. `processNames` says what. */
  | 'other'
  /** 3389 is held and the probe could not see by whom (it did not run as root). */
  | 'unknown';

/**
 * Who owns tcp/3389, from the process names `ss` attached to its listeners.
 *
 * The kernel truncates a comm name to 15 characters, so `gnome-remote-desktop-daemon` arrives as
 * `gnome-remote-de`. Matching the full name would classify every GRD node as `other`.
 */
export function classifyRdpOwner(listeners: readonly RdpListener[]): { owner: RdpOwner; processNames: string[] } {
  const on3389 = listeners.filter((l) => l.port === RDP_PORT);
  if (on3389.length === 0) return { owner: 'none', processNames: [] };
  const names = [...new Set(on3389.flatMap((l) => l.processes))];
  if (names.length === 0) return { owner: 'unknown', processNames: [] };
  const isXrdp = (n: string) => n === 'xrdp';
  const isGrd = (n: string) => n.startsWith('gnome-remote-de');
  if (names.every(isXrdp)) return { owner: 'xrdp', processNames: names };
  if (names.every(isGrd)) return { owner: 'gnome-remote-desktop', processNames: names };
  return { owner: 'other', processNames: names };
}

// ─── Guard chain parsing ─────────────────────────────────────────────────────

export interface GuardStatus {
  /** `systemctl is-active` says the oneshot ran. Informational: an active unit whose rules were flushed protects nothing. */
  unitActive: boolean;
  /** The IPv4 chain exists AND holds the tailscale0 accept, the tcp-reset reject, and is jumped to from INPUT. */
  effective4: boolean;
  /** Same test against ip6tables. `undefined` when the node has no ip6tables. */
  effective6?: boolean;
}

/**
 * Is a dumped chain (`iptables -S RDP_TAILNET_GUARD` + `iptables -C INPUT …` result) doing its job?
 *
 * Judged on the rules, not the unit: `ufw enable` and a firewall reload flush user chains and the
 * unit stays "active" throughout. This is the same check verification uses after `--execute`.
 */
export function isGuardChainEffective(rules: string, jumpPresent: boolean): boolean {
  if (!jumpPresent) return false;
  const lines = rules.split('\n').map((l) => l.trim());
  const accept = lines.some((l) => l.includes(`-A ${GUARD_CHAIN}`) && l.includes('-i tailscale0') && l.includes('-j ACCEPT'));
  const reject = lines.some((l) => l.includes(`-A ${GUARD_CHAIN}`) && l.includes('--reject-with tcp-reset'));
  return accept && reject;
}

// ─── Probe ───────────────────────────────────────────────────────────────────

export interface RdpState {
  os: 'linux' | 'other';
  osRaw: string;
  /** The probe ran as root, so process names on 3389 are trustworthy and an install could follow. */
  sudo: boolean;
  owner: RdpOwner;
  processNames: string[];
  /** Every listener on 3389, whatever it is bound to. */
  listeners: RdpListener[];
  /** Addresses on 3389 that are reachable off the tailnet: wildcard, LAN, anything not tailnet or loopback. */
  exposedAddresses: string[];
  /** No listener on 3389 answers off the tailnet. True when there is no listener at all. */
  tailnetOnly: boolean;
  guard: GuardStatus;
  /** Has an ip6tables binary, so the guard must cover v6 too. */
  ip6tables: boolean;
  /** The node's own tailnet IPv4, from `tailscale ip` or the `tailscale0` interface. */
  tailnetIp?: string;
  load1?: number;
  cpus?: number;
}

/**
 * One script, one round trip, and it wants root.
 *
 * `ss -p` only attributes sockets the caller may see. Run unprivileged it prints xrdp's listener
 * with an empty process column, which this tool must report as `unknown`, not `none`. So the probe
 * elevates when it can and says whether it did.
 */
export function rdpProbeScript(): string {
  return [
    'if sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; else SUDO=""; fi',
    'echo "sudo=$([ -n "$SUDO" ] && echo yes || echo no)"',
    'echo "os=$(uname -s 2>/dev/null || echo unknown)"',
    'echo "cpus=$(nproc 2>/dev/null || echo 0)"',
    'echo "load1=$(cut -d\\  -f1 /proc/loadavg 2>/dev/null || echo 0)"',
    'echo "tailnet_ip=$(tailscale ip -4 2>/dev/null | head -1 || true)"',
    'echo "tailscale0_ip=$(ip -4 -o addr show dev tailscale0 2>/dev/null | awk \'{print $4}\' | cut -d/ -f1 | head -1)"',
    'echo "ip6tables=$(command -v ip6tables >/dev/null 2>&1 && echo present || echo absent)"',
    `echo "guard_unit=$(systemctl is-active ${GUARD_UNIT_NAME} 2>/dev/null || echo inactive)"`,
    `echo "guard_jump4=$($SUDO iptables -C INPUT -p tcp --dport ${RDP_PORT} -j ${GUARD_CHAIN} >/dev/null 2>&1 && echo yes || echo no)"`,
    `echo "guard_jump6=$($SUDO ip6tables -C INPUT -p tcp --dport ${RDP_PORT} -j ${GUARD_CHAIN} >/dev/null 2>&1 && echo yes || echo no)"`,
    'echo "guard4-begin"',
    `$SUDO iptables -S ${GUARD_CHAIN} 2>/dev/null || true`,
    'echo "guard4-end"',
    'echo "guard6-begin"',
    `$SUDO ip6tables -S ${GUARD_CHAIN} 2>/dev/null || true`,
    'echo "guard6-end"',
    'echo "ss-begin"',
    '$SUDO ss -ltnp 2>/dev/null || ss -ltn 2>/dev/null || true',
    'echo "ss-end"',
    'true',
  ].join('; ');
}

function between(text: string, begin: string, end: string): string {
  const start = text.indexOf(begin);
  if (start < 0) return '';
  const stop = text.indexOf(end, start + begin.length);
  return text.slice(start + begin.length, stop < 0 ? undefined : stop).trim();
}

function kvFirst(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  return m ? (m[1] ?? '').trim() : undefined;
}

/** Turn the probe's output into a state. Pure, so every observed fleet shape is a unit test. */
export function parseRdpProbe(raw: string): RdpState {
  const osRaw = kvFirst(raw, 'os') ?? 'unknown';
  const listeners = parseSsListeners(between(raw, 'ss-begin', 'ss-end')).filter((l) => l.port === RDP_PORT);
  const { owner, processNames } = classifyRdpOwner(listeners);
  const exposedAddresses = [...new Set(listeners.map((l) => l.address).filter((a) => !isTailnetAddress(a) && !isLoopbackAddress(a)))];
  const ip6tables = kvFirst(raw, 'ip6tables') === 'present';
  const tailnetIp = kvFirst(raw, 'tailnet_ip') || kvFirst(raw, 'tailscale0_ip') || undefined;
  const cpus = Number(kvFirst(raw, 'cpus') ?? '') || undefined;
  const load1 = Number(kvFirst(raw, 'load1') ?? '');
  return {
    os: osRaw.toLowerCase().includes('linux') ? 'linux' : 'other',
    osRaw,
    sudo: kvFirst(raw, 'sudo') === 'yes',
    owner,
    processNames,
    listeners,
    exposedAddresses,
    tailnetOnly: exposedAddresses.length === 0,
    guard: {
      unitActive: kvFirst(raw, 'guard_unit') === 'active',
      effective4: isGuardChainEffective(between(raw, 'guard4-begin', 'guard4-end'), kvFirst(raw, 'guard_jump4') === 'yes'),
      effective6: ip6tables ? isGuardChainEffective(between(raw, 'guard6-begin', 'guard6-end'), kvFirst(raw, 'guard_jump6') === 'yes') : undefined,
    },
    ip6tables,
    tailnetIp: tailnetIp && isTailnetAddress(tailnetIp) ? tailnetIp : undefined,
    load1: Number.isFinite(load1) ? load1 : undefined,
    cpus,
  };
}

/** Whether the guard, as found, covers every address family the node can be reached on. */
export function isGuardEffective(state: Pick<RdpState, 'guard' | 'ip6tables'>): boolean {
  if (!state.guard.effective4) return false;
  return state.ip6tables ? state.guard.effective6 === true : true;
}

/**
 * The one question `--execute` ends on: can anything off the tailnet reach 3389?
 *
 * xrdp answers it by binding: the socket itself is on the tailnet address and `ss` shows nothing
 * else. gnome-remote-desktop cannot bind, so its `*:3389` stays in `ss` forever and the guard is
 * what makes it unreachable — the rules are read back rather than trusted.
 */
export function assessExposure(state: RdpState): { exposed: boolean; why: string } {
  if (state.owner === 'none') return { exposed: false, why: 'nothing listens on 3389' };
  if (state.exposedAddresses.length === 0) {
    return { exposed: false, why: `3389 answers only on ${state.listeners.map((l) => l.address).join(', ')}` };
  }
  if (isGuardEffective(state)) {
    return {
      exposed: false,
      why: `${state.exposedAddresses.join(', ')}:3389 is behind ${GUARD_CHAIN} (accept tailscale0 and lo, reject with tcp-reset${state.ip6tables ? ', v4 and v6' : ''})`,
    };
  }
  const guardNote = state.guard.unitActive ? ` — ${GUARD_UNIT_NAME} is active but its rules are missing, so it protects nothing` : '';
  return { exposed: true, why: `${state.exposedAddresses.join(', ')}:3389 is reachable off the tailnet${guardNote}` };
}

// ─── xrdp.ini ────────────────────────────────────────────────────────────────

/**
 * Bind xrdp to one address, in the only place xrdp reads it from.
 *
 * Given the text of `/etc/xrdp/xrdp.ini` and a tailnet IPv4, returns the text with `[Globals]`
 * `port=tcp://<ip>:3389` and no `address=` line. Pure, and idempotent: applying it to its own output
 * returns the same text, and a file already in that state comes back byte-identical.
 *
 * Section-aware on purpose. `port=` also appears in the session sections — `[Xorg]` and `[Xvnc]`
 * carry `port=-1` — and rewriting those would point xrdp's backend connection at 3389 on the tailnet
 * address. Only `[Globals]` is touched. Commented examples (`;   port=tcp://:3389`) are left alone.
 *
 * `address=` is removed, not just ignored, because xrdp 0.10 ignores it silently: with it set and
 * `port=3389` the daemon still listened on every interface, and the key sat there looking like the
 * reason it should not have.
 */
export function rewriteXrdpIniBind(ini: string, tailnetIp: string): string {
  if (!isTailnetAddress(tailnetIp))
    throw new Error(`${tailnetIp} is not a tailnet (100.64.0.0/10) address; refusing to write a bind that is not tailnet-only`);
  const desired = `port=tcp://${tailnetIp}:${RDP_PORT}`;
  const header = /^\s*\[([^\]]+)\]\s*$/;
  const isPort = (line: string) => /^\s*port\s*=/i.test(line);
  const isAddress = (line: string) => /^\s*address\s*=/i.test(line);

  const lines = ini.split('\n');
  // Pass 1: where is [Globals], and does it already carry a port line?
  let globalsAt = -1;
  let portAt = -1;
  let section = '';
  for (const [i, line] of lines.entries()) {
    const h = header.exec(line);
    if (h) {
      section = (h[1] ?? '').trim().toLowerCase();
      if (section === 'globals' && globalsAt < 0) globalsAt = i;
      continue;
    }
    if (section === 'globals' && portAt < 0 && isPort(line)) portAt = i;
  }

  if (globalsAt < 0) {
    // No [Globals] at all — not a file xrdp shipped, but the bind must still land somewhere it reads.
    const body = ini.endsWith('\n') || ini === '' ? ini : `${ini}\n`;
    return `[Globals]\n${desired}\n${body}`;
  }

  // Pass 2: rewrite the first port line (or insert one under the header), drop the rest and any address=.
  const out: string[] = [];
  section = '';
  let portWritten = false;
  for (const [i, line] of lines.entries()) {
    const h = header.exec(line);
    if (h) {
      section = (h[1] ?? '').trim().toLowerCase();
      out.push(line);
      if (i === globalsAt && portAt < 0) {
        out.push(desired);
        portWritten = true;
      }
      continue;
    }
    if (section === 'globals') {
      if (isPort(line)) {
        if (!portWritten) {
          out.push(desired);
          portWritten = true;
        }
        continue;
      }
      if (isAddress(line)) continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// ─── Plans ───────────────────────────────────────────────────────────────────

export type RdpDecision =
  /** Install xrdp (or rebind an existing one) to the tailnet address. */
  | { kind: 'xrdp'; why: string; tailnetIp: string }
  /** gnome-remote-desktop holds the port; install the firewall guard around it. */
  | { kind: 'guard'; why: string }
  /** Already tailnet-only. Nothing to apply; verification still runs. */
  | { kind: 'ok'; why: string }
  /** This tool will not act here, and says why. */
  | { kind: 'refuse'; why: string; fix?: string };

/**
 * What to do on one node, from what it reported.
 *
 * xrdp if nothing owns 3389 (and xrdp again when xrdp owns it but binds too widely — the state all
 * three pre-existing installs were in); the guard if gnome-remote-desktop owns it; refuse for
 * anything else. The refusals name the reason because on a fleet they are the lines that get read.
 */
export function decideRdpPlan(state: RdpState): RdpDecision {
  if (state.os !== 'linux') {
    return { kind: 'refuse', why: `RDP provisioning is Linux-only; this node reports ${state.osRaw}` };
  }
  if (!state.sudo) {
    return {
      kind: 'refuse',
      why: 'the probe could not run as root, so the owner of 3389 cannot be attributed and nothing can be installed',
      fix: 'pass --user with an account that has passwordless sudo',
    };
  }
  switch (state.owner) {
    case 'none': {
      if (!state.tailnetIp)
        return { kind: 'refuse', why: 'no tailnet address on this node — there is nothing tailnet-only to bind to', fix: 'bring Tailscale up first' };
      return {
        kind: 'xrdp',
        why: `nothing listens on ${RDP_PORT}; would install ${XRDP_PACKAGES.join(' ')} bound to ${state.tailnetIp}`,
        tailnetIp: state.tailnetIp,
      };
    }
    case 'xrdp': {
      if (state.tailnetOnly) return { kind: 'ok', why: `xrdp already answers only on ${state.listeners.map((l) => l.address).join(', ')}` };
      if (!state.tailnetIp)
        return {
          kind: 'refuse',
          why: `xrdp listens on ${state.exposedAddresses.join(', ')} and this node has no tailnet address to move it to`,
          fix: 'bring Tailscale up first',
        };
      return {
        kind: 'xrdp',
        why: `xrdp listens on ${state.exposedAddresses.join(', ')}; would rebind it to ${state.tailnetIp}`,
        tailnetIp: state.tailnetIp,
      };
    }
    case 'gnome-remote-desktop': {
      if (isGuardEffective(state))
        return { kind: 'ok', why: `gnome-remote-desktop on ${state.exposedAddresses.join(', ') || 'tailnet'} is already behind ${GUARD_CHAIN}` };
      return {
        kind: 'guard',
        why: `gnome-remote-desktop holds ${RDP_PORT} on ${state.exposedAddresses.join(', ') || '*'} and cannot bind an address; would install ${GUARD_UNIT_NAME}`,
      };
    }
    case 'other':
      return { kind: 'refuse', why: `${RDP_PORT} is held by ${state.processNames.join(', ')}, which this tool does not manage` };
    case 'unknown':
      return { kind: 'refuse', why: `${RDP_PORT} is in use and the owner could not be read` };
  }
}

// ─── Guard unit ──────────────────────────────────────────────────────────────

/**
 * The rules one `iptables`/`ip6tables` binary needs, rebuilt from scratch on every start.
 *
 * Order matters twice. The accepts precede the reject, or nothing gets in. And `-p tcp` precedes
 * `--reject-with tcp-reset`, or iptables refuses the rule — that is the failure the first hand
 * attempt hit. Idempotent by construction: create-or-reuse the chain, flush it, re-add, then delete
 * every existing INPUT jump before inserting exactly one at position 1 (ahead of ufw's chains).
 */
function guardRules(tool: 'iptables' | 'ip6tables'): string[] {
  const t = tool;
  return [
    `${t} -N ${GUARD_CHAIN} 2>/dev/null || true`,
    `${t} -F ${GUARD_CHAIN}`,
    `${t} -A ${GUARD_CHAIN} -i lo -p tcp --dport ${RDP_PORT} -j ACCEPT`,
    `${t} -A ${GUARD_CHAIN} -i tailscale0 -p tcp --dport ${RDP_PORT} -j ACCEPT`,
    `${t} -A ${GUARD_CHAIN} -p tcp --dport ${RDP_PORT} -j REJECT --reject-with tcp-reset`,
    `while ${t} -D INPUT -p tcp --dport ${RDP_PORT} -j ${GUARD_CHAIN} 2>/dev/null; do :; done`,
    `${t} -I INPUT 1 -p tcp --dport ${RDP_PORT} -j ${GUARD_CHAIN}`,
  ];
}

function guardTeardown(tool: 'iptables' | 'ip6tables'): string[] {
  const t = tool;
  return [
    `while ${t} -D INPUT -p tcp --dport ${RDP_PORT} -j ${GUARD_CHAIN} 2>/dev/null; do :; done`,
    `${t} -F ${GUARD_CHAIN} 2>/dev/null || true`,
    `${t} -X ${GUARD_CHAIN} 2>/dev/null || true`,
  ];
}

/**
 * The systemd oneshot that keeps gnome-remote-desktop off the LAN.
 *
 * Written with no `$` anywhere: systemd expands `$VAR` in `ExecStart=` before the shell sees it, so
 * a `for t in iptables ip6tables; do $t …` loop would run with `t` empty. Each tool gets its own
 * literal line instead, and the v6 line exits 0 on a node without ip6tables rather than failing the
 * unit. `RemainAfterExit` makes `is-active` meaningful and gives `ExecStop` something to run.
 */
export function guardUnitText(): string {
  const sh = (cmds: string[]) => `/bin/sh -c '${cmds.join('; ')}'`;
  return [
    '[Unit]',
    `Description=Restrict RDP (tcp/${RDP_PORT}) to the tailnet — gnome-remote-desktop cannot bind an address`,
    'Documentation=https://github.com/companionintelligence/CI-Hub/blob/dev/docs/fleet-setup.md',
    'After=network-pre.target',
    'Wants=network-pre.target',
    'Before=network.target gnome-remote-desktop.service',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `ExecStart=${sh(guardRules('iptables'))}`,
    `ExecStart=${sh(['command -v ip6tables >/dev/null 2>&1 || exit 0', ...guardRules('ip6tables')])}`,
    `ExecStop=${sh(guardTeardown('iptables'))}`,
    `ExecStop=${sh(['command -v ip6tables >/dev/null 2>&1 || exit 0', ...guardTeardown('ip6tables')])}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/**
 * Install the guard. Runs as root.
 *
 * `restart`, not `enable --now`: on a unit that is already active, `--now` is a no-op and the (new
 * or repaired) rules would never be applied. `ExecStart` is idempotent, so a restart is always safe.
 */
export function guardInstallScript(): string {
  return [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'if ! command -v iptables >/dev/null 2>&1; then apt-get install -y --no-install-recommends iptables || { apt-get update && apt-get install -y --no-install-recommends iptables; }; fi',
    `cat > ${GUARD_UNIT_PATH} <<'CIHUB_RDP_GUARD_EOF'`,
    guardUnitText().trimEnd(),
    'CIHUB_RDP_GUARD_EOF',
    'systemctl daemon-reload',
    `systemctl enable ${GUARD_UNIT_NAME} >/dev/null 2>&1`,
    `systemctl restart ${GUARD_UNIT_NAME}`,
    `iptables -S ${GUARD_CHAIN}`,
    'echo rdp-guard-complete',
  ].join('\n');
}

// ─── xrdp scripts ────────────────────────────────────────────────────────────

/**
 * Stage 1 of the xrdp plan: packages, the login user's session, and the current ini. Runs as root.
 *
 * Recommends are deliberately NOT suppressed: `xorgxrdp` — the Xorg backend that makes an xrdp
 * session actually render — is a Recommends of `xrdp`, and the proven recipe was a plain install.
 * The `.xsession` goes to the account that opened the SSH session (`SUDO_USER`), which is the
 * account that will log in over RDP; there is no separate RDP user on this fleet.
 */
export function xrdpPrepareScript(): string {
  const pkgs = XRDP_PACKAGES.join(' ');
  return [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    `apt-get install -y ${pkgs} || { apt-get update && apt-get install -y ${pkgs}; }`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion for the generated script, not a forgotten template literal — JS must NOT interpolate it.
    'login="${SUDO_USER:-$(id -un)}"',
    'home="$(getent passwd "$login" | cut -d: -f6)"',
    'if [ -z "$home" ] || [ ! -d "$home" ]; then echo "rdp-refuse: no home directory for $login" >&2; exit 3; fi',
    'printf \'startxfce4\\n\' > "$home/.xsession"',
    'chown "$login": "$home/.xsession"',
    'chmod 0644 "$home/.xsession"',
    'echo "xsession_user=$login"',
    `[ -f ${XRDP_INI_PATH}.cihub-orig ] || cp ${XRDP_INI_PATH} ${XRDP_INI_PATH}.cihub-orig`,
    'echo "ini-begin"',
    `cat ${XRDP_INI_PATH}`,
    'echo "ini-end"',
    'echo xrdp-prepare-complete',
  ].join('\n');
}

/**
 * Stage 2: write the rewritten ini and bring xrdp up on it. Runs as root.
 *
 * `restart`, not just `enable --now`: a node that already ran xrdp on `*:3389` is still running it
 * on `*:3389` until the daemon re-reads its config. `adduser xrdp ssl-cert` is what lets xrdp read
 * the snakeoil key; guarded so a re-run does not depend on adduser's exit code for a member.
 */
export function xrdpApplyScript(newIni: string): string {
  return [
    'set -e',
    `cat > ${XRDP_INI_PATH} <<'CIHUB_XRDP_INI_EOF'`,
    newIni.trimEnd(),
    'CIHUB_XRDP_INI_EOF',
    'id -nG xrdp | grep -qw ssl-cert || adduser xrdp ssl-cert',
    'systemctl enable xrdp.service >/dev/null 2>&1',
    'systemctl restart xrdp.service',
    'sleep 2',
    'echo xrdp-apply-complete',
  ].join('\n');
}

// ─── Execution ───────────────────────────────────────────────────────────────

export interface RdpStep {
  name: string;
  ok: boolean;
  detail: string;
  ms?: number;
}

export interface RdpNodeReport {
  node: string;
  /** What the node looked like before anything ran. Absent when the probe itself failed. */
  before?: RdpState;
  decision?: RdpDecision;
  /** Steps taken under `--execute`. Empty for a dry run. */
  steps: RdpStep[];
  /** What the node looks like after `--execute`, re-read from `ss`. */
  after?: RdpState;
  /** The outcome as the exit code sees it. A dry run is never a failure; a refusal under --execute is. */
  ok: boolean;
  summary: string;
}

const PROBE_TIMEOUT_MS = 30_000;
/** apt pulling xfce4 on a cold node is a few hundred MB; budget for a slow link. */
const XRDP_INSTALL_TIMEOUT_MS = 15 * 60_000;
const APPLY_TIMEOUT_MS = 2 * 60_000;

const tail = (text: string, n = 4) => text.split('\n').filter(Boolean).slice(-n).join(' | ').slice(0, 400);

/** Heredoc under `sudo -n bash`, the same shape `executeBackendPlan` uses, and for the same reasons. */
async function runAsRoot(target: SshTarget, script: string, marker: string, timeoutMs: number) {
  return sshCapture(target, `sudo -n bash <<'${marker}'\n${script}\n${marker}`, timeoutMs);
}

export async function probeRdp(target: SshTarget, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ state: RdpState | null; error?: string }> {
  const result = await sshCapture(target, rdpProbeScript(), timeoutMs);
  // Output over exit status, as every fleet probe here: the script is best-effort reads and `true`.
  if (result.out.includes('os=')) return { state: parseRdpProbe(result.out) };
  return { state: null, error: result.err || `ssh exited ${result.code} with no readable output` };
}

/**
 * Bring one node to tailnet-only RDP, or report why not.
 *
 * Dry run (the default) probes, decides, and stops. `execute` applies the plan and then re-probes:
 * the run is a success only if the second read shows nothing on 3389 reachable off the tailnet —
 * by bind for xrdp, by an effective guard for gnome-remote-desktop. The verdict is on the machine's
 * second answer, never on the install script having exited 0.
 */
export async function runRdpOnNode(
  node: { name: string },
  target: SshTarget,
  opts: { execute: boolean },
  io: { probe?: typeof probeRdp; run?: typeof runAsRoot } = {},
): Promise<RdpNodeReport> {
  const probe = io.probe ?? probeRdp;
  const run = io.run ?? runAsRoot;
  const report: RdpNodeReport = { node: node.name, steps: [], ok: true, summary: '' };

  const { state, error } = await probe(target);
  if (!state) {
    report.ok = false;
    report.summary = `could not probe — ${String(error).slice(0, 160)}`;
    return report;
  }
  report.before = state;
  const decision = decideRdpPlan(state);
  report.decision = decision;

  if (!opts.execute) {
    report.summary = decision.why;
    return report;
  }

  if (decision.kind === 'refuse') {
    report.ok = false;
    report.summary = `refused: ${decision.why}${decision.fix ? ` — ${decision.fix}` : ''}`;
    return report;
  }

  if (decision.kind !== 'ok') {
    // The gate that exists because a fleet pass once caught a node at load 108 on 32 cores and its
    // apt transaction never got the CPU to finish. Same rule, same ratio, reused rather than re-derived.
    const busy = isTooBusyForMaintenance({
      os: 'linux',
      arch: 'unknown',
      appleSilicon: false,
      cpuCount: state.cpus,
      load1: state.load1,
      docker: { present: false, usable: false },
      gpus: [],
      enginesListening: [],
      notes: [],
    });
    if (busy.busy) {
      report.ok = false;
      report.summary = `refused: ${busy.why}`;
      return report;
    }
  }

  if (decision.kind === 'xrdp') {
    const started = Date.now();
    const prep = await run(target, xrdpPrepareScript(), 'CIHUB_XRDP_PREP_EOF', XRDP_INSTALL_TIMEOUT_MS);
    const prepOk = prep.ok && prep.out.includes('xrdp-prepare-complete');
    report.steps.push({
      name: 'install xrdp + xfce4, write ~/.xsession',
      ok: prepOk,
      detail: prepOk ? `session for ${kvFirst(prep.out, 'xsession_user') ?? '?'}` : describeRootFailure(prep.err || prep.out, prep.code),
      ms: Date.now() - started,
    });
    if (!prepOk) {
      report.ok = false;
      report.summary = 'xrdp install failed';
      return report;
    }
    const currentIni = between(prep.out, 'ini-begin', 'ini-end');
    const newIni = rewriteXrdpIniBind(currentIni, decision.tailnetIp);
    const applyStarted = Date.now();
    const apply = await run(target, xrdpApplyScript(newIni), 'CIHUB_XRDP_APPLY_EOF', APPLY_TIMEOUT_MS);
    const applyOk = apply.ok && apply.out.includes('xrdp-apply-complete');
    report.steps.push({
      name: `bind xrdp to tcp://${decision.tailnetIp}:${RDP_PORT}, enable, restart`,
      ok: applyOk,
      detail: applyOk
        ? newIni === currentIni
          ? 'ini already correct; restarted'
          : 'ini rewritten; restarted'
        : describeRootFailure(apply.err || apply.out, apply.code),
      ms: Date.now() - applyStarted,
    });
    if (!applyOk) {
      report.ok = false;
      report.summary = 'xrdp bind failed';
      return report;
    }
  } else if (decision.kind === 'guard') {
    const started = Date.now();
    const res = await run(target, guardInstallScript(), 'CIHUB_RDP_GUARD_UNIT_EOF', APPLY_TIMEOUT_MS);
    const ok = res.ok && res.out.includes('rdp-guard-complete');
    report.steps.push({
      name: `install ${GUARD_UNIT_NAME}`,
      ok,
      detail: ok ? 'chain rebuilt and jumped from INPUT' : describeRootFailure(res.err || res.out, res.code),
      ms: Date.now() - started,
    });
    if (!ok) {
      report.ok = false;
      report.summary = 'guard install failed';
      return report;
    }
  }

  // Verification: the machine's second answer decides, not the install's exit code.
  const second = await probe(target);
  if (!second.state) {
    report.ok = false;
    report.summary = `applied, but the verification probe failed — ${String(second.error).slice(0, 160)}`;
    return report;
  }
  report.after = second.state;
  const exposure = assessExposure(second.state);
  report.steps.push({ name: 'verify: re-read ss -ltn', ok: !exposure.exposed, detail: exposure.why });
  report.ok = !exposure.exposed;
  report.summary = exposure.exposed ? `NOT tailnet-only: ${exposure.why}` : `tailnet-only: ${exposure.why}`;
  return report;
}

/** `sudo -n` refusing is the likeliest failure on a fresh account, and its message is unmistakable. */
function describeRootFailure(text: string, code: number | null): string {
  if (/sudo:.*password is required|a terminal is required/i.test(text)) {
    return 'passwordless sudo is not available for this account, so nothing can be installed unattended';
  }
  if (/rdp-refuse:/.test(text)) return tail(text.split('rdp-refuse:').pop() ?? text, 1);
  return code === null ? `timed out — ${tail(text)}` : `exited ${code} — ${tail(text)}`;
}

/** One line per node for the dry-run table. */
export function describeBind(state: RdpState): string {
  if (state.listeners.length === 0) return '—';
  return state.listeners.map((l) => `${l.address}:${l.port}`).join(' ');
}
