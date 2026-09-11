/**
 * The TLS certificate every Hub Pool node needs, and never had tooling for.
 *
 * A Hub Pool peer is stored under its tailnet FQDN and reached at `https://<fqdn>` — pairing
 * callbacks, health polls, every proxied request. `docs/hub-pool-fleet-testing.md` §1.2 makes it a
 * hard gate: a TLS error there means nothing downstream can pass. The certificate behind that URL is
 * a `tailscale cert <fqdn>` on the node, and until this file nothing in the install path ran it.
 * Measured on 2026-09-10: 14 of 18 nodes had one, because someone had run it by hand; 4 did not.
 *
 * THE TRAP THIS FILE IS SHAPED AROUND: tailscaled keeps its certificates in
 * `/var/lib/tailscale/certs`, which is `drwx------ root`. An unprivileged `ls` there prints nothing
 * and exits 2, and a probe that read that as "no certificate" reported ZERO certificates on a fleet
 * that had fourteen. "Unreadable without sudo" and "absent" are different findings, and only one of
 * them is a reason to act. So every value here carries HOW it was learned — a {@link Measured} —
 * and a renderer is not allowed to print "absent" for anything but a privileged listing that came
 * back without the file.
 *
 * An older note claimed "no HTTPS on this tailnet". It was wrong — the certificates exist — but the
 * check it implies is still the right first step: `tailscale status --json` reports `CertDomains`,
 * and an empty list means HTTPS is off for the whole tailnet and no per-node command can help.
 *
 * Nothing here is run locally. Every probe is one SSH round trip to the node, and the issue path is
 * only reached with `--execute`.
 */

import type { InstallStep } from './fleet-install.js';
import { classifySshFailure, sshCapture, type SshTarget } from './fleet-ssh.js';

/**
 * A finding together with the observation that produced it.
 *
 * `via` is the command or condition, in the operator's words, so a table cell or a JSON report can
 * always answer "says who?". A finding without its provenance is what let "unreadable" become
 * "absent" the first time this was measured.
 */
export interface Measured<T> {
  value: T;
  via: string;
}

export type CertState =
  /** `<fqdn>.crt` is in the store, seen with privilege. */
  | 'present'
  /** The store was listed WITH privilege and the file is not there. The only state that earns the word. */
  | 'absent'
  /** The store is root-only and this session has neither root nor passwordless sudo. Not "absent". */
  | 'unreadable-without-sudo'
  /** `tailscale status` reports no `CertDomains`: HTTPS is off for the tailnet, not for this node. */
  | 'https-not-enabled'
  | 'tailscale-missing'
  /** The CLI exists but the daemon is not `Running` (NeedsLogin, Stopped, or not answering). */
  | 'tailscale-not-running'
  /** The store path and the `sudo` shape here are Linux's. macOS keeps certificates elsewhere. */
  | 'not-linux'
  /** Not measured at all — SSH failed, the local node, or output nothing here could read. */
  | 'unknown';

export interface CertFinding {
  cert: Measured<CertState>;
  /** This node's MagicDNS name, trailing dot removed — the name `tailscale cert` must be given. */
  fqdn?: Measured<string>;
  certDomains?: Measured<string[]>;
  privilege?: Measured<'root' | 'sudo' | 'none'>;
  /** `notAfter` as ISO-8601, when `openssl x509 -enddate` could read the file. */
  expiresAt?: Measured<string>;
  daysLeft?: number;
  /** Every entry the privileged listing returned, for a report that shows its working. */
  storeEntries?: string[];
}

export const TAILSCALE_CERT_DIR = '/var/lib/tailscale/certs';

/** A finding that was not measured, and why. Never renders as absent. */
export function unmeasuredCert(why: string): CertFinding {
  return { cert: { value: 'unknown', via: why } };
}

// ─── tailscale status --json ─────────────────────────────────────────────────

export interface TailscaleStatusFacts {
  backendState?: string;
  /** Trailing dot removed. */
  selfDnsName?: string;
  certDomains: string[];
  magicDnsSuffix?: string;
}

/**
 * The three things `tailscale status --json` has to say about certificates.
 *
 * `CertDomains` is the tailnet-level switch: empty means HTTPS is not enabled in the admin console
 * and `tailscale cert` will refuse on every node. `Self.DNSName` arrives with a trailing dot, as
 * MagicDNS names do; pool pairing and the cert store both key on the name without it.
 */
export function parseTailscaleStatus(json: string): { facts: TailscaleStatusFacts | null; error?: string } {
  let doc: { BackendState?: unknown; Self?: { DNSName?: unknown }; CertDomains?: unknown; MagicDNSSuffix?: unknown };
  try {
    doc = JSON.parse(json) as typeof doc;
  } catch {
    const firstLine = json.split('\n').find((l) => l.trim()) ?? '';
    return { facts: null, error: firstLine.trim().slice(0, 160) || 'empty output' };
  }
  if (!doc || typeof doc !== 'object') return { facts: null, error: 'not a JSON object' };
  const certDomains = Array.isArray(doc.CertDomains)
    ? doc.CertDomains.filter((d): d is string => typeof d === 'string' && d.length > 0).map(stripTrailingDot)
    : [];
  const rawName = doc.Self?.DNSName;
  return {
    facts: {
      backendState: typeof doc.BackendState === 'string' ? doc.BackendState : undefined,
      selfDnsName: typeof rawName === 'string' && rawName.length > 0 ? stripTrailingDot(rawName) : undefined,
      certDomains,
      magicDnsSuffix: typeof doc.MagicDNSSuffix === 'string' ? doc.MagicDNSSuffix : undefined,
    },
  };
}

function stripTrailingDot(name: string): string {
  return name.replace(/\.$/, '');
}

/**
 * The name to issue for.
 *
 * `Self.DNSName` when it is one of the `CertDomains`, which it always is on a plainly configured
 * tailnet. Otherwise the first cert domain — tailscaled decides what it will sign, and asking for a
 * name it will not sign fails after a round trip to the CA.
 */
export function chooseCertFqdn(facts: TailscaleStatusFacts): Measured<string> | undefined {
  if (facts.certDomains.length === 0) return undefined;
  if (facts.selfDnsName && facts.certDomains.includes(facts.selfDnsName)) {
    return { value: facts.selfDnsName, via: 'tailscale status --json (Self.DNSName, in CertDomains)' };
  }
  return { value: facts.certDomains[0] as string, via: 'tailscale status --json (CertDomains[0]; Self.DNSName differs or is missing)' };
}

// ─── The read-only probe ─────────────────────────────────────────────────────

const STATUS_BEGIN = 'CIHUB_TS_STATUS_BEGIN';
const STATUS_END = 'CIHUB_TS_STATUS_END';

/**
 * One round trip that reads everything the state machine needs, and changes nothing.
 *
 * `key=value` lines like the hardware probe, with the `tailscale status` document between two
 * markers because it is JSON and belongs to a parser on this side. `--peers=false` because the peer
 * map is the bulk of that document and none of it is wanted here.
 *
 * The privilege check comes BEFORE the store is touched, and its result is emitted next to the
 * listing, so the parser can tell an empty directory from one it was not allowed to open.
 */
export function tailscaleCertProbeScript(): string {
  return [
    'echo "os=$(uname -s 2>/dev/null || echo unknown)"',
    'ts="$(command -v tailscale 2>/dev/null || true)"',
    'if [ -z "$ts" ]; then for c in /usr/bin/tailscale /usr/local/bin/tailscale /usr/sbin/tailscale; do if [ -x "$c" ]; then ts="$c"; break; fi; done; fi',
    'if [ -z "$ts" ]; then echo "tailscale=missing"; else',
    'echo "tailscale=$ts"',
    `echo "${STATUS_BEGIN}"`,
    // Older CLIs predate --peers; fall back to the full document rather than reporting nothing.
    '"$ts" status --json --peers=false 2>/dev/null || "$ts" status --json 2>&1 || true',
    'echo',
    `echo "${STATUS_END}"`,
    'if [ "$(id -u)" = 0 ]; then priv=root; SUDO=""; elif sudo -n true >/dev/null 2>&1; then priv=sudo; SUDO="sudo -n"; else priv=none; SUDO=""; fi',
    'echo "priv=$priv"',
    'if [ "$priv" = none ]; then',
    // The store is drwx------ root. Without privilege `ls` prints nothing and exits 2, and the first
    // probe of this fleet read that as zero certificates on eighteen nodes. Say it was not readable.
    '  echo "store=unreadable"',
    `elif $SUDO test -d ${TAILSCALE_CERT_DIR}; then`,
    '  echo "store=listed"',
    `  $SUDO ls -1 ${TAILSCALE_CERT_DIR} 2>/dev/null | sed 's/^/entry=/'`,
    // Expiry per certificate, read as the privileged user. openssl may be absent on a minimal image;
    // that is reported as unreadable expiry, not as a missing certificate.
    `  $SUDO sh -c 'for f in ${TAILSCALE_CERT_DIR}/*.crt; do [ -f "$f" ] || continue; echo "enddate=$(basename "$f") $(openssl x509 -enddate -noout -in "$f" 2>/dev/null || echo openssl-unavailable)"; done'`,
    'else',
    '  echo "store=missing"',
    'fi',
    'fi',
    // The probe's exit status is meaningless — it is a sequence of best-effort reads.
    'true',
  ].join('\n');
}

function kv(text: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const existing = map.get(key);
    if (existing) existing.push(value);
    else map.set(key, [value]);
  }
  return map;
}

/** `notAfter=Dec  9 12:00:00 2026 GMT` → ISO string, or undefined when it does not parse. */
export function parseOpensslEndDate(text: string): string | undefined {
  const m = /notAfter=(.+)$/m.exec(text);
  if (!m?.[1]) return undefined;
  const parsed = new Date(m[1].trim().replace(/\s+/g, ' '));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * The state machine, from one probe's output.
 *
 * Order matters and each step earns the next: no CLI → nothing else is knowable; daemon not running
 * → no `CertDomains` to read; no `CertDomains` → HTTPS is off and the store is irrelevant; no
 * privilege → the store cannot be read and NOTHING about the certificate is known; only a privileged
 * listing decides present or absent.
 */
export function parseTailscaleCertProbe(stdout: string, now: Date = new Date()): CertFinding {
  const beginAt = stdout.indexOf(STATUS_BEGIN);
  const endAt = stdout.indexOf(STATUS_END);
  const statusJson = beginAt >= 0 && endAt > beginAt ? stdout.slice(beginAt + STATUS_BEGIN.length, endAt).trim() : '';
  const rest = beginAt >= 0 && endAt > beginAt ? `${stdout.slice(0, beginAt)}\n${stdout.slice(endAt + STATUS_END.length)}` : stdout;
  const map = kv(rest);
  const first = (key: string) => map.get(key)?.[0];

  const os = (first('os') ?? '').toLowerCase();
  if (os && !os.includes('linux')) {
    return {
      cert: { value: 'not-linux', via: `uname -s reports ${first('os')}; the ${TAILSCALE_CERT_DIR} store and sudo shape here are Linux's` },
    };
  }
  const cli = first('tailscale');
  if (!cli || cli === 'missing') {
    return { cert: { value: 'tailscale-missing', via: 'command -v tailscale found nothing, nor /usr/bin, /usr/local/bin, /usr/sbin' } };
  }

  const { facts, error } = parseTailscaleStatus(statusJson);
  if (!facts) {
    return { cert: { value: 'tailscale-not-running', via: `tailscale status --json: ${error ?? 'no output'}` } };
  }
  if (facts.backendState && facts.backendState !== 'Running') {
    return { cert: { value: 'tailscale-not-running', via: `tailscale status --json (BackendState=${facts.backendState})` } };
  }
  const certDomains: Measured<string[]> = { value: facts.certDomains, via: 'tailscale status --json (CertDomains)' };
  if (facts.certDomains.length === 0) {
    return {
      cert: { value: 'https-not-enabled', via: 'tailscale status --json (CertDomains empty — enable HTTPS in the tailnet admin console)' },
      certDomains,
      fqdn: facts.selfDnsName ? { value: facts.selfDnsName, via: 'tailscale status --json (Self.DNSName)' } : undefined,
    };
  }
  const fqdn = chooseCertFqdn(facts);

  const privRaw = first('priv');
  const privilege: Measured<'root' | 'sudo' | 'none'> = {
    value: privRaw === 'root' ? 'root' : privRaw === 'sudo' ? 'sudo' : 'none',
    via:
      privRaw === 'root' ? 'id -u = 0' : privRaw === 'sudo' ? 'sudo -n true succeeded' : 'not root, and sudo -n true was refused or sudo is absent',
  };
  const base = { fqdn, certDomains, privilege };

  const store = first('store');
  if (privilege.value === 'none' || store === 'unreadable' || store === undefined) {
    return {
      ...base,
      cert: {
        value: 'unreadable-without-sudo',
        via: `${TAILSCALE_CERT_DIR} is drwx------ root and this session has neither root nor passwordless sudo — pass --user root`,
      },
    };
  }
  const privCmd = privilege.value === 'root' ? 'ls' : 'sudo -n ls';
  if (store === 'missing') {
    return {
      ...base,
      cert: { value: 'absent', via: `${privCmd} ${TAILSCALE_CERT_DIR}: directory does not exist (tailscaled has never issued a certificate here)` },
    };
  }

  const entries = map.get('entry') ?? [];
  const wanted = `${fqdn?.value}.crt`;
  if (!fqdn || !entries.includes(wanted)) {
    return {
      ...base,
      storeEntries: entries,
      cert: {
        value: 'absent',
        via: `${privCmd} ${TAILSCALE_CERT_DIR}: listed ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, no ${wanted}`,
      },
    };
  }

  const finding: CertFinding = { ...base, storeEntries: entries, cert: { value: 'present', via: `${privCmd} ${TAILSCALE_CERT_DIR}/${wanted}` } };
  const endLine = (map.get('enddate') ?? []).find((l) => l.startsWith(`${wanted} `));
  const endText = endLine ? endLine.slice(wanted.length + 1) : '';
  const iso = parseOpensslEndDate(endText);
  if (iso) {
    finding.expiresAt = { value: iso, via: `openssl x509 -enddate -noout -in ${TAILSCALE_CERT_DIR}/${wanted}` };
    finding.daysLeft = Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000);
  }
  return finding;
}

/** Read one node's certificate state. Changes nothing on the node. */
export async function probeTailscaleCert(target: SshTarget, timeoutMs = 30_000): Promise<CertFinding> {
  const res = await sshCapture(target, `bash <<'CIHUB_STEP_EOF'\n${tailscaleCertProbeScript()}\nCIHUB_STEP_EOF`, timeoutMs);
  // Output over exit status, as with the hardware probe: a node that answered has told us what we
  // asked. Only a reply with none of our markers is a failed measurement.
  if (res.out.includes('os=')) return parseTailscaleCertProbe(res.out);
  return unmeasuredCert(`ssh failed (${classifySshFailure(res)})`);
}

// ─── Issuing ─────────────────────────────────────────────────────────────────

/**
 * Ask tailscaled for the certificate, as root.
 *
 * `--cert-file /dev/null --key-file /dev/null` is load-bearing. What this step wants is tailscaled
 * populating its own store at `/var/lib/tailscale/certs`, which it does on any successful fetch.
 * Without those flags the CLI ALSO writes `<fqdn>.crt` and `<fqdn>.key` into the current directory —
 * a private key dropped into `$HOME` on every node — and with `-` it would print the key into this
 * SSH session's captured output, which becomes a log line.
 *
 * Idempotent: tailscaled returns the cached certificate while it is valid and only goes to the CA
 * when it needs to, so running this on the fourteen nodes that already have one costs a local call.
 */
export function tailscaleCertIssueScript(fqdn: string): string {
  const safe = fqdn.replace(/'/g, "'\\''");
  return [
    'set -u',
    'ts="$(command -v tailscale 2>/dev/null || true)"',
    'if [ -z "$ts" ]; then for c in /usr/bin/tailscale /usr/local/bin/tailscale /usr/sbin/tailscale; do if [ -x "$c" ]; then ts="$c"; break; fi; done; fi',
    '[ -n "$ts" ] || { echo "cert-issue-no-tailscale"; exit 0; }',
    'if [ "$(id -u)" = 0 ]; then SUDO=""; elif sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; else echo "cert-issue-no-sudo"; exit 0; fi',
    `if $SUDO "$ts" cert --cert-file /dev/null --key-file /dev/null '${safe}'; then echo "cert-issue-complete"; else echo "cert-issue-failed"; fi`,
  ].join('\n');
}

export type CertIssueOutcome = 'issued' | 'no-sudo' | 'no-tailscale' | 'failed';

export function classifyCertIssueOutput(stdout: string): CertIssueOutcome {
  if (stdout.includes('cert-issue-complete')) return 'issued';
  if (stdout.includes('cert-issue-no-sudo')) return 'no-sudo';
  if (stdout.includes('cert-issue-no-tailscale')) return 'no-tailscale';
  return 'failed';
}

export interface EnsureCertResult {
  /** What was found before anything ran. */
  before: CertFinding;
  /** The `tailscale cert` run, if this pass ran one. */
  issue?: Measured<CertIssueOutcome> & { detail?: string; ms: number };
  /** Re-read after issuing, because the exit code says what the command believed, not what the store holds. */
  after?: CertFinding;
  /** The finding an operator should act on: `after` when there is one, else `before`. */
  final: CertFinding;
  /** Skipped or already fine → true. Ran and the store still lacks the file → false. */
  ok: boolean;
  /** One line for a report row. */
  detail: string;
  /** The command a dry run would have executed on this node, or the reason it would not. */
  plan: string;
}

/** Whether a state is one `tailscale cert` on this node can change. */
export function certNeedsAction(state: CertState): boolean {
  return state === 'absent' || state === 'present';
}

/**
 * Probe → (issue → re-probe). The re-probe is the verdict.
 *
 * `execute: false` never runs the issue script; it returns the finding and the plan. With `execute`,
 * the issue runs whenever the state is one it can change — including `present`, because that is
 * how a certificate near expiry gets renewed, and tailscaled makes the already-valid case free.
 */
export async function ensureTailscaleCert(
  target: SshTarget,
  opts: { execute: boolean; issueTimeoutMs?: number } = { execute: false },
): Promise<EnsureCertResult> {
  const before = await probeTailscaleCert(target);
  const plan = planForFinding(before);

  if (!opts.execute || !certNeedsAction(before.cert.value) || !before.fqdn) {
    const skippedWhy = describeCertFinding(before);
    return { before, final: before, ok: before.cert.value !== 'unknown', detail: skippedWhy, plan };
  }

  const started = Date.now();
  const run = await sshCapture(
    target,
    `bash <<'CIHUB_STEP_EOF'\n${tailscaleCertIssueScript(before.fqdn.value)}\nCIHUB_STEP_EOF`,
    opts.issueTimeoutMs ?? 3 * 60_000,
  );
  const outcome = classifyCertIssueOutput(run.out);
  const issue = {
    value: outcome,
    via: `sudo -n tailscale cert ${before.fqdn.value}`,
    detail: (run.err || run.out).split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 200),
    ms: Date.now() - started,
  };

  const after = await probeTailscaleCert(target);
  const ok = after.cert.value === 'present';
  const verdict = describeCertFinding(after);
  const detail =
    outcome === 'issued'
      ? ok
        ? `${before.cert.value === 'present' ? 'renewed if due' : 'issued'}; ${verdict}`
        : `tailscale cert exited 0 but the store disagrees: ${verdict}`
      : `tailscale cert ${outcome}${issue.detail ? ` (${issue.detail})` : ''}; ${verdict}`;
  return { before, issue, after, final: after, ok, detail, plan };
}

function planForFinding(finding: CertFinding): string {
  switch (finding.cert.value) {
    case 'absent':
      return `would run: sudo tailscale cert ${finding.fqdn?.value ?? '<fqdn>'}`;
    case 'present':
      return `would run: sudo tailscale cert ${finding.fqdn?.value ?? '<fqdn>'} (already present; tailscaled renews only if due)`;
    case 'unreadable-without-sudo':
      return `would skip: cannot verify or issue — ${finding.cert.via}`;
    case 'https-not-enabled':
      return 'would skip: HTTPS is not enabled for this tailnet — no per-node command can fix that';
    case 'tailscale-missing':
      return 'would skip: no tailscale CLI on this node';
    case 'tailscale-not-running':
      return `would skip: ${finding.cert.via}`;
    case 'not-linux':
      return `would skip: ${finding.cert.via}`;
    case 'unknown':
      return `would skip: not measured — ${finding.cert.via}`;
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * One line for a step report or a `--json` reader.
 *
 * "absent" appears only for the state that earned it. Everything not measured says what stopped
 * the measurement, because that is the actionable part.
 */
export function describeCertFinding(finding: CertFinding): string {
  const name = finding.fqdn?.value;
  switch (finding.cert.value) {
    case 'present': {
      const exp =
        finding.daysLeft === undefined
          ? finding.expiresAt
            ? `expires ${finding.expiresAt.value}`
            : 'expiry unreadable (openssl missing or unparsable)'
          : `expires in ${finding.daysLeft}d`;
      return `cert present for ${name} (${exp}) — via ${finding.cert.via}`;
    }
    case 'absent':
      return `no cert for ${name} — via ${finding.cert.via}`;
    case 'unreadable-without-sudo':
      return `cert state unknown for ${name}: ${finding.cert.via}`;
    case 'https-not-enabled':
      return `HTTPS is not enabled for this tailnet (${finding.cert.via})`;
    case 'tailscale-missing':
      return `no tailscale on this node (${finding.cert.via})`;
    case 'tailscale-not-running':
      return `tailscale is not running (${finding.cert.via})`;
    case 'not-linux':
      return `skipped: ${finding.cert.via}`;
    case 'unknown':
      return `not measured: ${finding.cert.via}`;
  }
}

/**
 * The `fleet status` cell.
 *
 * The rule: anything not measured renders as `—` followed by why. Never blank — a blank cell reads
 * as "fine" from across a table — and never the word "absent" for a store this session could not
 * open. Fourteen certificates were reported as zero that way once.
 */
export function renderCertCell(finding: CertFinding): { text: string; tone: 'green' | 'yellow' | 'red' | 'dim' } {
  switch (finding.cert.value) {
    case 'present':
      if (finding.daysLeft !== undefined && finding.daysLeft <= 14) return { text: `ok, ${finding.daysLeft}d left`, tone: 'yellow' };
      return { text: finding.daysLeft === undefined ? 'ok, expiry unreadable' : `ok, ${finding.daysLeft}d left`, tone: 'green' };
    case 'absent':
      return { text: 'absent', tone: 'red' };
    case 'unreadable-without-sudo':
      return { text: '— unreadable without sudo', tone: 'yellow' };
    case 'https-not-enabled':
      return { text: '— HTTPS not enabled on tailnet', tone: 'yellow' };
    case 'tailscale-missing':
      return { text: '— no tailscale', tone: 'dim' };
    case 'tailscale-not-running':
      return { text: '— tailscale not running', tone: 'yellow' };
    case 'not-linux':
      return { text: '— not linux', tone: 'dim' };
    case 'unknown':
      return { text: `— ${finding.cert.via}`, tone: 'dim' };
  }
}

// ─── The install step ────────────────────────────────────────────────────────

/**
 * The step `installNode` calls. Self-contained so the install sequence changes by one line.
 *
 * Best-effort in the same sense as the status timer: a node whose tailnet has HTTPS off, or that has
 * no tailscale, is still an installed Hub — it just cannot pool yet, and the line says so. A node
 * where `tailscale cert` RAN and the store still lacks the file is a failure, because that is the
 * one case where the operator was promised a certificate and does not have one.
 */
export async function tailscaleCertStep(target: SshTarget): Promise<InstallStep> {
  const started = Date.now();
  const result = await ensureTailscaleCert(target, { execute: true });
  const state = result.final.cert.value;
  const ran = result.issue !== undefined;
  // `unknown` is a measurement that failed, not a decision not to act — it must not hide behind
  // `skipped`, which `installNode` counts as fine.
  return {
    name: 'tailscale cert',
    ok: ran ? result.ok : state !== 'unknown',
    skipped: !ran && state !== 'unknown',
    detail: ran ? result.detail : `${result.detail} — pooling needs https://<fqdn>; see docs/fleet-setup.md`,
    ms: Date.now() - started,
  };
}
