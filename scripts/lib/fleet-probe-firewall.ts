/**
 * Let the Hub container's engine probes fail fast, or succeed, instead of hanging.
 *
 * Every pooled request runs a live health probe against each local engine port before ranking, six
 * of them, each with a 5000 ms axios timeout. On a node whose ufw silently DROPS the Docker-bridge
 * SYN to an engine port — the default for anything ufw was not told about — the probe cannot get a
 * reset and waits the whole timeout. Measured 2026-09-20: pool TTFT was a flat 5.0 s on beta-nas,
 * beta-1, core-6 and core-5 versus 22-100 ms once the port answered. The bridge->11434 rule those
 * nodes already carried is why Ollama alone was fine.
 *
 * So this emits, for every ufw-active node, `ufw allow from 172.16.0.0/12 to any port <p> proto tcp`
 * for each port the Hub probes, next to that existing rule. `allow` rather than `reject`: with it a
 * port that has a listener answers the probe (the HUB column stops reading `-`) and a port that has
 * none gets a reset from the kernel and fails in a millisecond. `172.16.0.0/12` is Docker's whole
 * default address pool, so compose networks (`br-*`, one per project) are covered without
 * enumerating them — the same source the hand-written rule on beta-nas used.
 *
 * Idempotent on `ufw status`: a port whose rule is already there is reported as present and not
 * re-added. ufw itself would also skip a duplicate, but a plan that says "would add 4 rules" on a
 * node that has them is a plan nobody trusts.
 *
 * NOTHING HERE RUNS ANYTHING. The apply shell is executed by `cihub fleet backends --execute`.
 */

/**
 * The host ports the Hub container probes for engines other than Ollama: the shared 8000 space
 * (vllm, mtplx, lucebox), dspark's 8080, lemonade's 13305 and the lucebox-hub stack's 8216. Ollama's
 * 11434 is not here: `ollama-tailnet-guard.service` already admits the bridges to it ahead of ufw.
 */
export const HUB_PROBE_PORTS: readonly number[] = [8000, 8080, 13305, 8216];

/** Docker's default address pool. Every bridge it creates, default or compose, lands inside it. */
export const DOCKER_BRIDGE_CIDR = '172.16.0.0/12';

export interface UfwRule {
  /** The `To` column as printed: `8000/tcp`, `22`, `Anywhere`. */
  to: string;
  port?: number;
  /** Absent when the rule covers both protocols. */
  proto?: 'tcp' | 'udp';
  action: 'ALLOW' | 'DENY' | 'REJECT' | 'LIMIT';
  direction?: 'IN' | 'OUT';
  /** The `From` column: a CIDR, an address, or `Anywhere`. */
  from: string;
  v6: boolean;
}

/**
 * The rule table of `ufw status` (or `status verbose`, whose action column reads `ALLOW IN`).
 *
 *     To                         Action      From
 *     --                         ------      ----
 *     11434/tcp                  ALLOW       172.16.0.0/12              # ci-hub container -> host ollama
 *     22/tcp                     ALLOW       Anywhere
 *     22/tcp (v6)                ALLOW       Anywhere (v6)
 */
export function parseUfwStatus(text: string): UfwRule[] {
  const rules: UfwRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const m = /^(\S+(?: \(v6\))?)\s+(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT))?\s+(.+?)$/.exec(line);
    if (!m) continue;
    const to = m[1] as string;
    const v6 = to.includes('(v6)') || /\(v6\)/.test(m[4] as string);
    const port = /^(\d+)(?:\/(tcp|udp))?(?: \(v6\))?$/.exec(to);
    rules.push({
      to,
      port: port ? Number(port[1]) : undefined,
      proto: port?.[2] as 'tcp' | 'udp' | undefined,
      action: m[2] as UfwRule['action'],
      direction: m[3] as UfwRule['direction'],
      from: (m[4] as string).replace(/ \(v6\)$/, '').trim(),
      v6,
    });
  }
  return rules;
}

/**
 * Does a table already admit the Docker bridges to a TCP port?
 *
 * Counted: an IPv4 ALLOW (inbound, or unqualified) on `<port>/tcp` or bare `<port>`, from the
 * whole `172.16.0.0/12` or from `Anywhere`. A narrower source such as `172.17.0.0/16` covers only
 * the default bridge, not the compose networks the Hub actually lives on, and is not counted.
 */
export function ufwAdmitsBridgeTo(rules: readonly UfwRule[], port: number): boolean {
  return rules.some(
    (r) =>
      !r.v6 &&
      r.action === 'ALLOW' &&
      r.direction !== 'OUT' &&
      r.port === port &&
      (r.proto === undefined || r.proto === 'tcp') &&
      (r.from === DOCKER_BRIDGE_CIDR || r.from === 'Anywhere'),
  );
}

// ─── Probe ───────────────────────────────────────────────────────────────────

export const FIREWALL_PROBE_MARKER = 'firewall_probe=1';

/**
 * Read-only. `ufw status` needs root, so the probe elevates when `sudo -n` allows it and says
 * whether it did; without root, ufw's own config still says whether it is enforcing (the only
 * unprivileged signal that tracks `ufw enable`/`disable` — the unit is a RemainAfterExit oneshot and
 * reads active forever), and the rules are reported as unreadable rather than as absent.
 */
export function firewallProbeScript(): string {
  return [
    `echo "${FIREWALL_PROBE_MARKER}"`,
    'if [ "$(id -u 2>/dev/null)" = 0 ]; then SUDO=""; ROOT=yes; elif sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; ROOT=yes; else SUDO=""; ROOT=no; fi',
    'echo "root=$ROOT"',
    'echo "ufw_bin=$(command -v ufw >/dev/null 2>&1 && echo yes || echo no)"',
    'echo "ufw_conf=$(grep -m1 -oE \'^ENABLED=(yes|no)\' /etc/ufw/ufw.conf 2>/dev/null | cut -d= -f2)"',
    'echo "ufw-status-begin"',
    '[ "$ROOT" = yes ] && $SUDO ufw status 2>/dev/null || true',
    'echo "ufw-status-end"',
    'true',
  ].join('\n');
}

export interface FirewallProbe {
  present: boolean;
  root: boolean;
  installed: boolean;
  /** `ENABLED=` from /etc/ufw/ufw.conf; undefined when the file is absent. */
  enabledInConfig?: boolean;
  /** From `ufw status` itself when it could be read. */
  status?: 'active' | 'inactive';
  rules: UfwRule[];
}

export function parseFirewallProbe(out: string): FirewallProbe {
  const kv = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(out)?.[1]?.trim();
  const begin = out.indexOf('ufw-status-begin');
  const end = out.indexOf('ufw-status-end');
  const status = begin >= 0 && end > begin ? out.slice(begin + 'ufw-status-begin'.length, end) : '';
  const conf = kv('ufw_conf');
  const statusLine = /^Status:\s*(active|inactive)/m.exec(status)?.[1];
  return {
    present: out.includes(FIREWALL_PROBE_MARKER),
    root: kv('root') === 'yes',
    installed: kv('ufw_bin') === 'yes',
    enabledInConfig: conf === 'yes' ? true : conf === 'no' ? false : undefined,
    status: statusLine as FirewallProbe['status'],
    rules: parseUfwStatus(status),
  };
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export interface ProbeFirewallPlan {
  /** `add`: rules to write. `present`: all there. `inactive`: ufw is not enforcing, so nothing drops. `unreadable`: active but the table needs root. `unknown`: the probe did not run. */
  state: 'add' | 'present' | 'inactive' | 'unreadable' | 'unknown';
  why: string;
  present: number[];
  missing: number[];
  /** The exact commands, one per missing port, for the dry run to print. */
  commands: string[];
}

export function ufwAllowCommand(port: number): string {
  return `ufw allow from ${DOCKER_BRIDGE_CIDR} to any port ${port} proto tcp comment 'ci-hub container -> host engine :${port}'`;
}

/** Decide what the firewall step does on one node. Pure. */
export function planProbeFirewall(probe: FirewallProbe, ports: readonly number[] = HUB_PROBE_PORTS): ProbeFirewallPlan {
  if (!probe.present) return { state: 'unknown', why: 'could not read the node (probe produced no output)', present: [], missing: [], commands: [] };
  if (!probe.installed) return { state: 'inactive', why: 'ufw is not installed; nothing drops the probes', present: [], missing: [], commands: [] };
  const active = probe.status ? probe.status === 'active' : probe.enabledInConfig === true;
  if (!active) return { state: 'inactive', why: 'ufw is not active; nothing drops the probes', present: [], missing: [], commands: [] };
  if (!probe.status) {
    return {
      state: 'unreadable',
      why: 'ufw is active but its rules need root to read — pass --user with an account that has passwordless sudo',
      present: [],
      missing: [...ports],
      commands: ports.map(ufwAllowCommand),
    };
  }
  const present = ports.filter((p) => ufwAdmitsBridgeTo(probe.rules, p));
  const missing = ports.filter((p) => !present.includes(p));
  if (missing.length === 0) {
    return { state: 'present', why: `ufw active; bridge → :${present.join(', :')} already allowed`, present, missing, commands: [] };
  }
  return {
    state: 'add',
    why: `ufw active and dropping the bridge on :${missing.join(', :')}${present.length ? ` (:${present.join(', :')} already allowed)` : ''} — every Hub probe there waits the full 5 s`,
    present,
    missing,
    commands: missing.map(ufwAllowCommand),
  };
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export const FIREWALL_MARKERS = {
  skipped: 'ufw-probe-skipped:',
  present: 'ufw-probe-present:',
  added: 'ufw-probe-added:',
  failed: 'ufw-probe-failed:',
  complete: 'ufw-probe-complete',
} as const;

/**
 * Root shell that adds the missing rules and re-reads the table.
 *
 * Re-checks each port against `ufw status` itself before adding, so a plan that went stale between
 * the probe and the apply adds nothing twice; and prints the rows for every probe port afterwards so
 * the caller can confirm each planned port now admits the bridge rather than trusting "Rule added".
 */
export function probeFirewallApplyShell(ports: readonly number[]): string {
  const bridge = DOCKER_BRIDGE_CIDR.replace(/\./g, '\\.').replace('/', '\\/');
  const present = (port: number) =>
    `ufw status 2>/dev/null | grep -qE '^${port}(/tcp)?[[:space:]]+ALLOW( IN)?[[:space:]]+(${bridge}|Anywhere)([[:space:]]|$)'`;
  const lines = [
    `command -v ufw >/dev/null 2>&1 || { echo "${FIREWALL_MARKERS.skipped} ufw is not installed"; exit 0; }`,
    `ufw status 2>/dev/null | grep -q '^Status: active' || { echo "${FIREWALL_MARKERS.skipped} ufw is not active"; exit 0; }`,
  ];
  for (const port of ports) {
    lines.push(
      `if ${present(port)}; then echo "${FIREWALL_MARKERS.present} ${port}"; else`,
      `  if out="$(${ufwAllowCommand(port)} 2>&1)"; then echo "${FIREWALL_MARKERS.added} ${port} ($(echo "$out" | tr '\\n' ' ' | sed 's/ *$//'))"; else echo "${FIREWALL_MARKERS.failed} :${port} — $(echo "$out" | tr '\\n' ' ')" >&2; exit 1; fi`,
      'fi',
    );
  }
  lines.push(
    'echo "ufw-status-begin"',
    `ufw status 2>/dev/null | grep -E '^(${HUB_PROBE_PORTS.join('|')})(/tcp)?[[:space:]]' || true`,
    'echo "ufw-status-end"',
    `echo "${FIREWALL_MARKERS.complete}"`,
  );
  return lines.join('\n');
}

export interface ProbeFirewallApplyOutcome {
  outcome: 'applied' | 'present' | 'skipped' | 'failed' | 'incomplete';
  why: string;
  added: number[];
  present: number[];
  /** Ports that were planned and still do not admit the bridge after the run. */
  unverified: number[];
}

/** Classify {@link probeFirewallApplyShell} output. Markers, then the re-read table; never the exit code alone. */
export function classifyProbeFirewallOutput(out: string, err: string, ports: readonly number[]): ProbeFirewallApplyOutcome {
  const text = `${out}\n${err}`;
  const lines = text.split('\n').map((l) => l.trim());
  const pick = (marker: string) =>
    lines
      .find((l) => l.startsWith(marker))
      ?.slice(marker.length)
      .trim();
  const listed = (marker: string) =>
    lines
      .filter((l) => l.startsWith(marker))
      .map((l) => Number(/^\s*(\d+)/.exec(l.slice(marker.length))?.[1]))
      .filter(Number.isFinite);
  const added = listed(FIREWALL_MARKERS.added);
  const present = listed(FIREWALL_MARKERS.present);
  const skipped = pick(FIREWALL_MARKERS.skipped);
  if (skipped) return { outcome: 'skipped', why: skipped, added, present, unverified: [] };
  const failed = pick(FIREWALL_MARKERS.failed);
  if (failed) return { outcome: 'failed', why: failed, added, present, unverified: [] };
  if (!lines.includes(FIREWALL_MARKERS.complete)) {
    return { outcome: 'incomplete', why: 'the firewall step produced no completion marker', added, present, unverified: [...ports] };
  }
  const begin = out.indexOf('ufw-status-begin');
  const end = out.indexOf('ufw-status-end');
  const rules = parseUfwStatus(begin >= 0 && end > begin ? out.slice(begin + 'ufw-status-begin'.length, end) : '');
  const unverified = ports.filter((p) => !ufwAdmitsBridgeTo(rules, p));
  if (unverified.length) {
    return {
      outcome: 'failed',
      why: `ufw reported the rule for :${unverified.join(', :')} but its table still does not admit ${DOCKER_BRIDGE_CIDR}`,
      added,
      present,
      unverified,
    };
  }
  if (added.length === 0) return { outcome: 'present', why: `bridge → :${present.join(', :')} already allowed`, added, present, unverified };
  return {
    outcome: 'applied',
    why: `allowed ${DOCKER_BRIDGE_CIDR} → :${added.join(', :')}${present.length ? ` (:${present.join(', :')} already allowed)` : ''}`,
    added,
    present,
    unverified,
  };
}
