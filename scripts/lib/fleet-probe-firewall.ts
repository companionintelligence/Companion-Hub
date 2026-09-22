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
 * Idempotent on `ufw status`, read IN ORDER: ufw evaluates its table top down and the first rule
 * that matches a packet decides it, while `ufw allow` appends to the bottom. So a port the table
 * already decides for the bridge — ALLOW, or a DENY/REJECT the operator placed on purpose (the
 * audit put `ufw reject from 172.16.0.0/12 to any port 8000,8080,13305 proto tcp` on beta-1,
 * beta-nas, core-6 and core-5 first, and asked for reject rather than allow on beta-1's :8000) —
 * gets nothing appended: an ALLOW is reported present, a DENY/REJECT is reported as failing fast
 * already and is left alone. Appending behind either would add a rule that never fires, and a plan
 * that says "would add 4 rules" on a node that has them is a plan nobody trusts. The same ordering
 * trap is documented for nftables in `ollama-host-bridge.ts`.
 *
 * NOTHING HERE RUNS ANYTHING. The apply shell is executed by `cihub fleet backends --execute`.
 */

/**
 * The host ports the Hub container probes for engines other than Ollama: the shared 8000 space
 * (vllm, mtplx, lucebox), dspark's 8080, the fleet's llama-server on 8081 (`LLAMACPP_URL`, see
 * `fleet-llamacpp.ts`), lemonade's 13305 and the lucebox-hub stack's 8216. Ollama's 11434 is not
 * here: `ollama-tailnet-guard.service` already admits the bridges to it ahead of ufw.
 */
export const HUB_PROBE_PORTS: readonly number[] = [8000, 8080, 8081, 13305, 8216];

/** Docker's default address pool. Every bridge it creates, default or compose, lands inside it. */
export const DOCKER_BRIDGE_CIDR = '172.16.0.0/12';

export interface UfwRule {
  /** The `To` column as printed: `8000/tcp`, `8000,8080,13305/tcp`, `22`, `Anywhere`. */
  to: string;
  /** The port when the rule names exactly one. */
  port?: number;
  /** Every port the rule names, as inclusive `[low, high]` spans: a list (`8000,8080/tcp`) or a range (`8000:8010/tcp`). Empty for `Anywhere` or an app profile. */
  ports: Array<[number, number]>;
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
 *     8000,8080,13305/tcp        REJECT      172.16.0.0/12              # ci-hub probe: fail fast
 *     22/tcp                     ALLOW       Anywhere
 *     22/tcp (v6)                ALLOW       Anywhere (v6)
 *
 * Rows come back in table order, which is evaluation order.
 */
export function parseUfwStatus(text: string): UfwRule[] {
  const rules: UfwRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const m = /^(\S+(?: \(v6\))?)\s+(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT))?\s+(.+?)$/.exec(line);
    if (!m) continue;
    const to = m[1] as string;
    const v6 = to.includes('(v6)') || /\(v6\)/.test(m[4] as string);
    const spec = /^(\d+(?:[,:]\d+)*)(?:\/(tcp|udp))?(?: \(v6\))?$/.exec(to);
    const ports: Array<[number, number]> = (spec?.[1] ?? '')
      .split(',')
      .filter(Boolean)
      .map((part) => {
        const [low, high] = part.split(':').map(Number) as [number, number?];
        return [low, high ?? low];
      });
    const single = ports.length === 1 ? ports[0] : undefined;
    rules.push({
      to,
      port: single && single[0] === single[1] ? single[0] : undefined,
      ports,
      proto: spec?.[2] as 'tcp' | 'udp' | undefined,
      action: m[2] as UfwRule['action'],
      direction: m[3] as UfwRule['direction'],
      from: (m[4] as string).replace(/ \(v6\)$/, '').trim(),
      v6,
    });
  }
  return rules;
}

const ipToInt = (ip: string): number => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);

/**
 * Does a `From` column cover every address Docker can hand a bridge? `Anywhere`, or an IPv4 CIDR
 * whose prefix is `172.16.0.0/12` or wider. A narrower source such as `172.17.0.0/16` covers only
 * the default bridge, not the compose networks the Hub actually lives on, and does not count —
 * whichever way the rule points.
 */
export function ufwSourceCoversBridge(from: string): boolean {
  if (from === 'Anywhere') return true;
  const m = /^(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?$/.exec(from);
  if (!m) return false;
  const bits = m[2] === undefined ? 32 : Number(m[2]);
  const [bridgeIp, bridgeBits] = DOCKER_BRIDGE_CIDR.split('/') as [string, string];
  if (bits > Number(bridgeBits)) return false;
  const span = 2 ** (32 - bits);
  return Math.floor(ipToInt(m[1] as string) / span) === Math.floor(ipToInt(bridgeIp) / span);
}

/**
 * What ufw does with a bridge SYN to a TCP port, from the table alone: the action of the FIRST
 * IPv4 rule (inbound, or unqualified) that names the port — alone, in a list or in a range — for
 * tcp or both protocols, from a source that covers the whole bridge pool. `undefined` when no rule
 * decides it, which on a node with the default deny policy means a silent drop and the 5 s wait.
 *
 * First match, because that is how ufw evaluates the table; a rule further down never fires for
 * the packets an earlier one already took.
 */
export function ufwBridgeVerdict(rules: readonly UfwRule[], port: number): UfwRule['action'] | undefined {
  return rules.find(
    (r) =>
      !r.v6 &&
      r.direction !== 'OUT' &&
      // A `To` of `Anywhere` names no port because it names every port — the shape of the
      // "docker bridge -> host" rule two fleet nodes already carry (`Anywhere ALLOW IN 172.16.0.0/12`).
      // Reading its empty port list as "not this port" planned a redundant allow behind it.
      (r.ports.length === 0 ? r.to === 'Anywhere' : r.ports.some(([low, high]) => port >= low && port <= high)) &&
      (r.proto === undefined || r.proto === 'tcp') &&
      ufwSourceCoversBridge(r.from),
  )?.action;
}

/** Does a table already admit the Docker bridges to a TCP port — with an ALLOW nothing above it overrides? */
export function ufwAdmitsBridgeTo(rules: readonly UfwRule[], port: number): boolean {
  return ufwBridgeVerdict(rules, port) === 'ALLOW';
}

/**
 * Does a rule of the table's own already refuse the bridge on the port? DENY drops and REJECT
 * resets, and in either case the decision is made before an appended ALLOW would be read. LIMIT
 * counts too: an allow behind it is just as dead, and six probes per pooled request would trip
 * its six-per-thirty-seconds cap anyway.
 */
export function ufwBlocksBridgeTo(rules: readonly UfwRule[], port: number): boolean {
  const verdict = ufwBridgeVerdict(rules, port);
  return verdict !== undefined && verdict !== 'ALLOW';
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
  /** `add`: rules to write. `present`: every port already decided, nothing to add. `inactive`: ufw is not enforcing, so nothing drops. `unreadable`: active but the table needs root. `unknown`: the probe did not run. */
  state: 'add' | 'present' | 'inactive' | 'unreadable' | 'unknown';
  why: string;
  present: number[];
  /** Ports an earlier DENY/REJECT (or LIMIT) of the table's own already decides: they fail fast, and an appended allow would never fire. Left alone. */
  blocked: number[];
  missing: number[];
  /** The exact commands, one per missing port, for the dry run to print. */
  commands: string[];
}

export function ufwAllowCommand(port: number): string {
  return `ufw allow from ${DOCKER_BRIDGE_CIDR} to any port ${port} proto tcp comment 'ci-hub container -> host engine :${port}'`;
}

const list = (ports: readonly number[]) => `:${ports.join(', :')}`;

/** `:8000, :13305 already allowed; :8080 refused by a rule of its own, which fails fast` — the ports nothing needs adding for. */
function describeDecided(present: readonly number[], blocked: readonly number[]): string {
  const parts: string[] = [];
  if (present.length) parts.push(`${list(present)} already allowed`);
  if (blocked.length) parts.push(`${list(blocked)} refused by a rule of its own, which fails fast and is left alone`);
  return parts.join('; ');
}

/** Decide what the firewall step does on one node. Pure. */
export function planProbeFirewall(probe: FirewallProbe, ports: readonly number[] = HUB_PROBE_PORTS): ProbeFirewallPlan {
  const none = { present: [], blocked: [], missing: [], commands: [] };
  if (!probe.present) return { state: 'unknown', why: 'could not read the node (probe produced no output)', ...none };
  if (!probe.installed) return { state: 'inactive', why: 'ufw is not installed; nothing drops the probes', ...none };
  const active = probe.status ? probe.status === 'active' : probe.enabledInConfig === true;
  if (!active) return { state: 'inactive', why: 'ufw is not active; nothing drops the probes', ...none };
  if (!probe.status) {
    return {
      state: 'unreadable',
      why: 'ufw is active but its rules need root to read — pass --user with an account that has passwordless sudo',
      present: [],
      blocked: [],
      missing: [...ports],
      commands: ports.map(ufwAllowCommand),
    };
  }
  const present = ports.filter((p) => ufwAdmitsBridgeTo(probe.rules, p));
  const blocked = ports.filter((p) => ufwBlocksBridgeTo(probe.rules, p));
  const missing = ports.filter((p) => !present.includes(p) && !blocked.includes(p));
  if (missing.length === 0) {
    return { state: 'present', why: `ufw active; bridge → ${describeDecided(present, blocked)}`, present, blocked, missing, commands: [] };
  }
  const decided = describeDecided(present, blocked);
  return {
    state: 'add',
    why: `ufw active and dropping the bridge on ${list(missing)}${decided ? ` (${decided})` : ''} — every Hub probe there waits the full 5 s`,
    present,
    blocked,
    missing,
    commands: missing.map(ufwAllowCommand),
  };
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export const FIREWALL_MARKERS = {
  skipped: 'ufw-probe-skipped:',
  present: 'ufw-probe-present:',
  blocked: 'ufw-probe-blocked:',
  added: 'ufw-probe-added:',
  failed: 'ufw-probe-failed:',
  complete: 'ufw-probe-complete',
} as const;

/**
 * `cihub_ufw_verdict <port>`: the shell's copy of {@link ufwBridgeVerdict}, so the apply step reads
 * the table the same way the plan did — first IPv4 rule naming the port for tcp, from `Anywhere`
 * or a CIDR at least as wide as the bridge pool, in table order. Prints the action, or nothing.
 * Plain awk arithmetic for the CIDR test: neither `and()` nor bit shifts are POSIX, mawk lacks
 * them, and a busybox awk may lack `^` as well.
 */
export function ufwVerdictShellFunction(): string {
  const [bridgeIp, bridgeBits] = DOCKER_BRIDGE_CIDR.split('/') as [string, string];
  return [
    'cihub_ufw_verdict() {',
    `  ufw status 2>/dev/null | awk -v port="$1" -v bridge="${bridgeIp}" -v bridge_bits=${bridgeBits} '`,
    '    function ip2n(s, q) { split(s, q, "."); return ((q[1] * 256 + q[2]) * 256 + q[3]) * 256 + q[4] }',
    '    function covers(src, cidr, bits, span, k) {',
    '      if (src == "Anywhere") return 1',
    '      if (src !~ /^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+(\\/[0-9]+)?$/) return 0',
    '      bits = (split(src, cidr, "/") == 2) ? cidr[2] + 0 : 32',
    '      if (bits > bridge_bits + 0) return 0',
    '      span = 1; for (k = bits; k < 32; k++) span *= 2',
    '      return int(ip2n(cidr[1]) / span) == int(ip2n(bridge) / span)',
    '    }',
    '    /\\(v6\\)/ { next }',
    // `Anywhere ALLOW IN 172.16.0.0/12` names every port: the same rule the planner reads above.
    '    $1 == "Anywhere" && $2 ~ /^(ALLOW|DENY|REJECT|LIMIT)$/ {',
    '      from = $3; if ($3 == "OUT") next; if ($3 == "IN") from = $4',
    '      if (covers(from)) { print $2; exit }',
    '      next',
    '    }',
    '    $1 ~ /^[0-9][0-9,:]*(\\/(tcp|udp))?$/ && $2 ~ /^(ALLOW|DENY|REJECT|LIMIT)$/ {',
    '      spec = $1; proto = ""',
    '      if (index(spec, "/")) { proto = substr(spec, index(spec, "/") + 1); spec = substr(spec, 1, index(spec, "/") - 1) }',
    '      if (proto == "udp") next',
    '      from = $3; if ($3 == "OUT") next; if ($3 == "IN") from = $4',
    '      if (!covers(from)) next',
    '      n = split(spec, parts, ",")',
    '      for (i = 1; i <= n; i++) {',
    '        if (split(parts[i], span, ":") == 2) { lo = span[1] + 0; hi = span[2] + 0 } else { lo = parts[i] + 0; hi = lo }',
    '        if (port + 0 >= lo && port + 0 <= hi) { print $2; exit }',
    '      }',
    "    }'",
    '}',
  ].join('\n');
}

/**
 * Root shell that adds the missing rules and re-reads the table.
 *
 * Re-checks each port against `ufw status` itself before adding — in table order, the way ufw
 * reads it — so a plan that went stale between the probe and the apply adds nothing twice and
 * appends nothing behind a reject that arrived in between; and prints the whole table afterwards so
 * the caller can confirm each planned port now admits the bridge, first match and all, rather than
 * trusting "Rule added".
 */
export function probeFirewallApplyShell(ports: readonly number[]): string {
  const lines = [
    `command -v ufw >/dev/null 2>&1 || { echo "${FIREWALL_MARKERS.skipped} ufw is not installed"; exit 0; }`,
    `ufw status 2>/dev/null | grep -q '^Status: active' || { echo "${FIREWALL_MARKERS.skipped} ufw is not active"; exit 0; }`,
    ufwVerdictShellFunction(),
  ];
  for (const port of ports) {
    lines.push(
      `cihub_ufw_action="$(cihub_ufw_verdict ${port})"`,
      'case "$cihub_ufw_action" in',
      `  ALLOW) echo "${FIREWALL_MARKERS.present} ${port}" ;;`,
      `  DENY|REJECT|LIMIT) echo "${FIREWALL_MARKERS.blocked} ${port} ($cihub_ufw_action)" ;;`,
      `  *) if out="$(${ufwAllowCommand(port)} 2>&1)"; then echo "${FIREWALL_MARKERS.added} ${port} ($(echo "$out" | tr '\\n' ' ' | sed 's/ *$//'))"; else echo "${FIREWALL_MARKERS.failed} :${port} — $(echo "$out" | tr '\\n' ' ')" >&2; exit 1; fi ;;`,
      'esac',
    );
  }
  lines.push('echo "ufw-status-begin"', 'ufw status 2>/dev/null || true', 'echo "ufw-status-end"', `echo "${FIREWALL_MARKERS.complete}"`);
  return lines.join('\n');
}

export interface ProbeFirewallApplyOutcome {
  outcome: 'applied' | 'present' | 'skipped' | 'failed' | 'incomplete';
  why: string;
  added: number[];
  present: number[];
  /** Ports the table refuses with a rule of its own; nothing was appended behind it. */
  blocked: number[];
  /** Ports that were planned and still do not admit the bridge after the run. */
  unverified: number[];
}

/**
 * Classify {@link probeFirewallApplyShell} output. Markers, then the re-read table; never the exit
 * code alone. A port is verified when the table's first matching rule admits the bridge, or refuses
 * it and the shell said so — an ALLOW row that merely exists somewhere below a REJECT proves nothing.
 */
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
  const blocked = listed(FIREWALL_MARKERS.blocked);
  const skipped = pick(FIREWALL_MARKERS.skipped);
  if (skipped) return { outcome: 'skipped', why: skipped, added, present, blocked, unverified: [] };
  const failed = pick(FIREWALL_MARKERS.failed);
  if (failed) return { outcome: 'failed', why: failed, added, present, blocked, unverified: [] };
  if (!lines.includes(FIREWALL_MARKERS.complete)) {
    return { outcome: 'incomplete', why: 'the firewall step produced no completion marker', added, present, blocked, unverified: [...ports] };
  }
  const begin = out.indexOf('ufw-status-begin');
  const end = out.indexOf('ufw-status-end');
  const rules = parseUfwStatus(begin >= 0 && end > begin ? out.slice(begin + 'ufw-status-begin'.length, end) : '');
  const unverified = ports.filter((p) => !ufwAdmitsBridgeTo(rules, p) && !(blocked.includes(p) && ufwBlocksBridgeTo(rules, p)));
  if (unverified.length) {
    return {
      outcome: 'failed',
      why: `ufw reported the rule for ${list(unverified)} but its table still does not admit ${DOCKER_BRIDGE_CIDR}`,
      added,
      present,
      blocked,
      unverified,
    };
  }
  if (added.length === 0) return { outcome: 'present', why: `bridge → ${describeDecided(present, blocked)}`, added, present, blocked, unverified };
  const decided = describeDecided(present, blocked);
  return {
    outcome: 'applied',
    why: `allowed ${DOCKER_BRIDGE_CIDR} → ${list(added)}${decided ? ` (${decided})` : ''}`,
    added,
    present,
    blocked,
    unverified,
  };
}
