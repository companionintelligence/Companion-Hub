/**
 * The tailscale TLS certificate step: parsing, the state machine, and the one rendering rule.
 *
 * Every case here is a way the first measurement of this fleet went wrong or nearly did. The store
 * is `drwx------ root`; an unprivileged probe reported zero certificates on eighteen nodes that had
 * fourteen. So the tests are less about the happy path than about which findings are allowed to be
 * called "absent", and what every other finding must say instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sshCapture: vi.fn(),
  readHostFacts: vi.fn(),
}));

vi.mock('../lib/fleet-ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-ssh.js')>()),
  sshCapture: mocks.sshCapture,
}));

vi.mock('../lib/fleet-hardware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-hardware.js')>()),
  readHostFacts: mocks.readHostFacts,
}));

import { installNode } from '../lib/fleet-install.js';
import {
  type CertFinding,
  type CertState,
  chooseCertFqdn,
  classifyCertIssueOutput,
  describeCertFinding,
  ensureTailscaleCert,
  parseOpensslEndDate,
  parseTailscaleCertProbe,
  parseTailscaleStatus,
  renderCertCell,
  TAILSCALE_CERT_DIR,
  tailscaleCertIssueScript,
  tailscaleCertProbeScript,
  tailscaleCertStep,
  unmeasuredCert,
} from '../lib/fleet-tailscale-cert.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FQDN = 'hub-a.example-tailnet.ts.net';

/** `tailscale status --json --peers=false`, reduced to the keys the parser reads. */
function statusJson(over: { CertDomains?: string[] | null; DNSName?: string | null; BackendState?: string } = {}): string {
  const doc: Record<string, unknown> = {
    Version: '1.90.0',
    BackendState: over.BackendState ?? 'Running',
    Self: { HostName: 'hub-a', DNSName: over.DNSName === null ? undefined : (over.DNSName ?? `${FQDN}.`), OS: 'linux' },
    MagicDNSSuffix: 'example-tailnet.ts.net',
    CertDomains: over.CertDomains === null ? undefined : (over.CertDomains ?? [FQDN]),
    Peer: null,
  };
  return JSON.stringify(doc);
}

interface ProbeParts {
  os?: string;
  tailscale?: string;
  status?: string;
  priv?: 'root' | 'sudo' | 'none';
  store?: 'unreadable' | 'listed' | 'missing';
  entries?: string[];
  enddates?: string[];
}

/** What the probe script prints, assembled the way the shell would. */
function probeOutput(p: ProbeParts): string {
  const lines = [`os=${p.os ?? 'Linux'}`];
  if (p.tailscale === 'missing') {
    lines.push('tailscale=missing');
    return lines.join('\n');
  }
  lines.push(`tailscale=${p.tailscale ?? '/usr/bin/tailscale'}`);
  lines.push('CIHUB_TS_STATUS_BEGIN', p.status ?? statusJson(), '', 'CIHUB_TS_STATUS_END');
  lines.push(`priv=${p.priv ?? 'sudo'}`);
  if (p.store) lines.push(`store=${p.store}`);
  for (const e of p.entries ?? []) lines.push(`entry=${e}`);
  for (const e of p.enddates ?? []) lines.push(`enddate=${e}`);
  return lines.join('\n');
}

const NOW = new Date('2026-09-10T12:00:00Z');
const presentOutput = probeOutput({
  priv: 'sudo',
  store: 'listed',
  entries: [`${FQDN}.crt`, `${FQDN}.key`],
  enddates: [`${FQDN}.crt notAfter=Dec  9 12:00:00 2026 GMT`],
});
const absentOutput = probeOutput({ priv: 'sudo', store: 'listed', entries: [] });
const unreadableOutput = probeOutput({ priv: 'none', store: 'unreadable' });

const ssh = (out: string, ok = true) => ({ ok, out, err: '', code: ok ? 0 : 1, ms: 5 });

// ─── tailscale status --json ─────────────────────────────────────────────────

describe('parseTailscaleStatus', () => {
  it('reads CertDomains and strips the trailing dot from Self.DNSName', () => {
    const { facts } = parseTailscaleStatus(statusJson());
    // MagicDNS names arrive as `hub-a.example-tailnet.ts.net.`; the store file and the pool peer
    // row both key on the name without the dot, so a probe that kept it would never match its own
    // certificate.
    expect(facts?.selfDnsName).toBe(FQDN);
    expect(facts?.certDomains).toEqual([FQDN]);
    expect(facts?.backendState).toBe('Running');
  });

  it('reports an empty list when CertDomains is absent or empty, rather than failing to parse', () => {
    expect(parseTailscaleStatus(statusJson({ CertDomains: [] })).facts?.certDomains).toEqual([]);
    expect(parseTailscaleStatus(statusJson({ CertDomains: null })).facts?.certDomains).toEqual([]);
  });

  it('normalises a trailing dot in CertDomains too', () => {
    expect(parseTailscaleStatus(statusJson({ CertDomains: [`${FQDN}.`] })).facts?.certDomains).toEqual([FQDN]);
  });

  it('carries the CLI error text when the daemon did not answer with JSON', () => {
    const { facts, error } = parseTailscaleStatus("failed to connect to local tailscaled; it doesn't appear to be running\n");
    expect(facts).toBeNull();
    expect(error).toMatch(/tailscaled/);
  });

  it('copes with a missing Self block', () => {
    const { facts } = parseTailscaleStatus(statusJson({ DNSName: null }));
    expect(facts?.selfDnsName).toBeUndefined();
    expect(facts?.certDomains).toEqual([FQDN]);
  });
});

describe('chooseCertFqdn', () => {
  it("prefers the node's own name when it is one of the cert domains", () => {
    const chosen = chooseCertFqdn({ selfDnsName: FQDN, certDomains: [FQDN] });
    expect(chosen?.value).toBe(FQDN);
    expect(chosen?.via).toMatch(/Self\.DNSName/);
  });

  it('falls back to the first cert domain and says so when the names disagree', () => {
    const chosen = chooseCertFqdn({ selfDnsName: 'other.example-tailnet.ts.net', certDomains: [FQDN] });
    expect(chosen?.value).toBe(FQDN);
    expect(chosen?.via).toMatch(/CertDomains\[0\]/);
  });

  it('has nothing to offer when HTTPS is off', () => {
    expect(chooseCertFqdn({ selfDnsName: FQDN, certDomains: [] })).toBeUndefined();
  });
});

describe('parseOpensslEndDate', () => {
  it("parses openssl's notAfter, double space and all", () => {
    expect(parseOpensslEndDate('notAfter=Dec  9 12:00:00 2026 GMT')).toBe('2026-12-09T12:00:00.000Z');
  });

  it('returns nothing for a line it cannot read rather than a bogus date', () => {
    expect(parseOpensslEndDate('openssl-unavailable')).toBeUndefined();
    expect(parseOpensslEndDate('notAfter=garbage')).toBeUndefined();
  });
});

// ─── The probe script ────────────────────────────────────────────────────────

describe('tailscaleCertProbeScript', () => {
  const script = tailscaleCertProbeScript();

  it('decides privilege before touching the store, and says "unreadable" instead of listing nothing', () => {
    // The exact mistake of the first measurement: `ls` on a drwx------ root directory prints nothing,
    // and nothing was read as zero certificates.
    expect(script.indexOf('priv=')).toBeLessThan(script.indexOf(`ls -1 ${TAILSCALE_CERT_DIR}`));
    expect(script).toContain('store=unreadable');
    expect(script).toContain('sudo -n true');
  });

  it('asks tailscale for the small document, with a fallback for CLIs that predate --peers', () => {
    expect(script).toContain('status --json --peers=false');
    expect(script).toMatch(/\|\| "\$ts" status --json/);
  });

  it('reads expiry as the privileged user and tolerates a missing openssl', () => {
    expect(script).toContain('openssl x509 -enddate');
    expect(script).toContain('openssl-unavailable');
  });

  it('never lets its own exit status hide the output', () => {
    expect(script.trim().endsWith('true')).toBe(true);
  });
});

// ─── The state machine ───────────────────────────────────────────────────────

describe('parseTailscaleCertProbe', () => {
  it('tailscale-missing when no CLI was found', () => {
    const f = parseTailscaleCertProbe(probeOutput({ tailscale: 'missing' }));
    expect(f.cert.value).toBe('tailscale-missing');
    expect(f.cert.via).toMatch(/command -v tailscale/);
  });

  it('not-linux for a Darwin node, naming why', () => {
    const f = parseTailscaleCertProbe(probeOutput({ os: 'Darwin' }));
    expect(f.cert.value).toBe('not-linux');
    expect(f.cert.via).toMatch(/Darwin/);
  });

  it('tailscale-not-running when the daemon reports a state other than Running', () => {
    const f = parseTailscaleCertProbe(probeOutput({ status: statusJson({ BackendState: 'NeedsLogin' }) }));
    expect(f.cert.value).toBe('tailscale-not-running');
    expect(f.cert.via).toContain('BackendState=NeedsLogin');
  });

  it('tailscale-not-running when status printed an error instead of JSON, carrying the message', () => {
    const f = parseTailscaleCertProbe(probeOutput({ status: 'failed to connect to local tailscaled' }));
    expect(f.cert.value).toBe('tailscale-not-running');
    expect(f.cert.via).toMatch(/failed to connect/);
  });

  it('https-not-enabled when CertDomains is empty, before looking at the store at all', () => {
    // An empty CertDomains is the tailnet-level switch; no per-node command can help, and reporting
    // "absent" here would send an operator to run a command that must fail.
    const f = parseTailscaleCertProbe(probeOutput({ status: statusJson({ CertDomains: [] }), priv: 'root', store: 'listed', entries: [] }));
    expect(f.cert.value).toBe('https-not-enabled');
    expect(f.cert.via).toMatch(/CertDomains empty/);
    expect(f.fqdn?.value).toBe(FQDN);
  });

  it('unreadable-without-sudo when the session has no privilege — and NEVER absent', () => {
    const f = parseTailscaleCertProbe(unreadableOutput);
    expect(f.cert.value).toBe('unreadable-without-sudo');
    expect(f.cert.value).not.toBe('absent');
    expect(f.cert.via).toMatch(/drwx------ root/);
    expect(f.cert.via).toMatch(/--user root/);
    expect(f.privilege?.value).toBe('none');
    // The name is still known: the operator can act on it by hand.
    expect(f.fqdn?.value).toBe(FQDN);
  });

  it('treats a missing store line the same as unreadable, not as empty', () => {
    // A truncated reply must fail towards "not measured", never towards "no certificate".
    const f = parseTailscaleCertProbe(probeOutput({ priv: 'sudo' }));
    expect(f.cert.value).toBe('unreadable-without-sudo');
  });

  it('present, with expiry, when the privileged listing has <fqdn>.crt', () => {
    const f = parseTailscaleCertProbe(presentOutput, NOW);
    expect(f.cert.value).toBe('present');
    expect(f.cert.via).toBe(`sudo -n ls ${TAILSCALE_CERT_DIR}/${FQDN}.crt`);
    expect(f.expiresAt?.value).toBe('2026-12-09T12:00:00.000Z');
    expect(f.expiresAt?.via).toMatch(/openssl x509 -enddate/);
    expect(f.daysLeft).toBe(90);
    expect(f.storeEntries).toEqual([`${FQDN}.crt`, `${FQDN}.key`]);
  });

  it('matches the store file against the name WITHOUT its trailing dot', () => {
    // Self.DNSName is `hub-a.example-tailnet.ts.net.`; the file is `hub-a.example-tailnet.ts.net.crt`.
    // Keep the dot and every node with a certificate reads as absent.
    const f = parseTailscaleCertProbe(presentOutput, NOW);
    expect(f.fqdn?.value).toBe(FQDN);
    expect(f.fqdn?.value.endsWith('.')).toBe(false);
    expect(f.cert.value).toBe('present');
  });

  it('present with unreadable expiry when openssl is not on the node, as root without sudo', () => {
    const f = parseTailscaleCertProbe(
      probeOutput({ priv: 'root', store: 'listed', entries: [`${FQDN}.crt`, `${FQDN}.key`], enddates: [`${FQDN}.crt openssl-unavailable`] }),
      NOW,
    );
    expect(f.cert.value).toBe('present');
    expect(f.cert.via).toBe(`ls ${TAILSCALE_CERT_DIR}/${FQDN}.crt`);
    expect(f.expiresAt).toBeUndefined();
    expect(f.daysLeft).toBeUndefined();
    expect(f.privilege?.value).toBe('root');
  });

  it('absent only when the store was listed with privilege and lacks the file', () => {
    const f = parseTailscaleCertProbe(absentOutput);
    expect(f.cert.value).toBe('absent');
    expect(f.cert.via).toMatch(/sudo -n ls/);
    expect(f.cert.via).toMatch(new RegExp(`no ${FQDN.replace(/\./g, '\\.')}\\.crt`));
  });

  it('absent when the directory itself does not exist yet', () => {
    // tailscaled creates the directory on the first issue; no directory is a node that has never
    // been asked, which is a real absence.
    const f = parseTailscaleCertProbe(probeOutput({ priv: 'sudo', store: 'missing' }));
    expect(f.cert.value).toBe('absent');
    expect(f.cert.via).toMatch(/does not exist/);
  });

  it("absent when the store holds only some other node's certificate", () => {
    const f = parseTailscaleCertProbe(probeOutput({ priv: 'sudo', store: 'listed', entries: ['old-name.example-tailnet.ts.net.crt'] }));
    expect(f.cert.value).toBe('absent');
    expect(f.cert.via).toMatch(/listed 1 entry/);
    expect(f.storeEntries).toEqual(['old-name.example-tailnet.ts.net.crt']);
  });
});

// ─── Rendering: unreadable is never absent ───────────────────────────────────

const EVERY_STATE: CertState[] = [
  'present',
  'absent',
  'unreadable-without-sudo',
  'https-not-enabled',
  'tailscale-missing',
  'tailscale-not-running',
  'not-linux',
  'unknown',
];

function findingFor(state: CertState): CertFinding {
  return { cert: { value: state, via: `test via for ${state}` }, fqdn: { value: FQDN, via: 'test' } };
}

describe('renderCertCell', () => {
  it('never renders a blank cell', () => {
    for (const state of EVERY_STATE) expect(renderCertCell(findingFor(state)).text.trim().length).toBeGreaterThan(0);
  });

  it('renders every unmeasured state as "—" followed by why, and never as "absent"', () => {
    // A blank reads as "fine" from across a table, and "absent" is what fourteen certificates were
    // once reported as. Both are forbidden for anything that was not actually measured.
    for (const state of EVERY_STATE.filter((s) => s !== 'present' && s !== 'absent')) {
      const cell = renderCertCell(findingFor(state));
      expect(cell.text.startsWith('—')).toBe(true);
      expect(cell.text.toLowerCase()).not.toContain('absent');
    }
  });

  it('says "unreadable without sudo" in those words, so the fix is on the line', () => {
    expect(renderCertCell(findingFor('unreadable-without-sudo')).text).toBe('— unreadable without sudo');
  });

  it('carries the via for a finding that was never measured at all', () => {
    expect(renderCertCell(unmeasuredCert('ssh failed (acl-denied)')).text).toBe('— ssh failed (acl-denied)');
  });

  it('reserves the word "absent" for the one state that earned it', () => {
    expect(renderCertCell(findingFor('absent'))).toEqual({ text: 'absent', tone: 'red' });
  });

  it('shows days left, and turns yellow inside a fortnight', () => {
    expect(renderCertCell({ ...findingFor('present'), daysLeft: 62 })).toEqual({ text: 'ok, 62d left', tone: 'green' });
    expect(renderCertCell({ ...findingFor('present'), daysLeft: 9 })).toEqual({ text: 'ok, 9d left', tone: 'yellow' });
    expect(renderCertCell(findingFor('present')).text).toBe('ok, expiry unreadable');
  });
});

describe('describeCertFinding', () => {
  it('names the via on every line, so a report can always answer "says who?"', () => {
    for (const state of EVERY_STATE) expect(describeCertFinding(findingFor(state))).toContain(`test via for ${state}`);
  });

  it('does not describe an unreadable store as having no certificate', () => {
    const line = describeCertFinding(findingFor('unreadable-without-sudo')).toLowerCase();
    expect(line).not.toContain('no cert');
    expect(line).not.toContain('absent');
    expect(line).toContain('unknown');
  });
});

// ─── Issuing ─────────────────────────────────────────────────────────────────

describe('tailscaleCertIssueScript', () => {
  const script = tailscaleCertIssueScript(FQDN);

  it('sends both output files to /dev/null: never the CWD, never stdout', () => {
    // Without the flags the CLI writes <fqdn>.crt AND <fqdn>.key into the current directory — a
    // private key in $HOME on every node. With `-` it prints the key into our captured output.
    expect(script).toContain('--cert-file /dev/null --key-file /dev/null');
    expect(script).not.toMatch(/--key-file -\b/);
  });

  it('escalates with sudo -n and reports rather than prompting when it cannot', () => {
    expect(script).toContain('SUDO="sudo -n"');
    expect(script).toContain('cert-issue-no-sudo');
    expect(script).not.toMatch(/\bsudo\s+(?!-n)/);
  });

  it('quotes the name and escapes a quote inside it', () => {
    expect(script).toContain(`'${FQDN}'`);
    expect(tailscaleCertIssueScript("we'ird.ts.net")).toContain("'we'\\''ird.ts.net'");
  });

  it('ends in one of the markers whatever tailscale exits with', () => {
    expect(script).toContain('cert-issue-complete');
    expect(script).toContain('cert-issue-failed');
  });
});

describe('classifyCertIssueOutput', () => {
  it('reads each marker, and treats anything else as failed', () => {
    expect(classifyCertIssueOutput('...\ncert-issue-complete')).toBe('issued');
    expect(classifyCertIssueOutput('cert-issue-no-sudo')).toBe('no-sudo');
    expect(classifyCertIssueOutput('cert-issue-no-tailscale')).toBe('no-tailscale');
    expect(classifyCertIssueOutput('cert-issue-failed')).toBe('failed');
    expect(classifyCertIssueOutput('')).toBe('failed');
  });
});

// ─── ensureTailscaleCert: probe → issue → re-probe ───────────────────────────

const isProbe = (cmd: string) => cmd.includes('CIHUB_TS_STATUS_BEGIN');
const isIssue = (cmd: string) => cmd.includes('cert --cert-file /dev/null');

/** Answer probes from a queue and the issue from a fixed result, recording which ran. */
function scriptSsh(probes: string[], issue = ssh('cert-issue-complete')) {
  const calls: string[] = [];
  mocks.sshCapture.mockImplementation(async (_target: unknown, cmd: string) => {
    if (isIssue(cmd)) {
      calls.push('issue');
      return issue;
    }
    if (isProbe(cmd)) {
      calls.push('probe');
      return ssh(probes.shift() ?? '');
    }
    calls.push('other');
    return ssh('');
  });
  return calls;
}

const target = { host: '100.64.0.1', user: 'root' };

beforeEach(() => {
  mocks.sshCapture.mockReset();
  mocks.readHostFacts.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensureTailscaleCert', () => {
  it('dry run: one probe, never the issue script, and the plan names the command', async () => {
    const calls = scriptSsh([absentOutput]);
    const r = await ensureTailscaleCert(target, { execute: false });
    expect(calls).toEqual(['probe']);
    expect(r.issue).toBeUndefined();
    expect(r.final.cert.value).toBe('absent');
    expect(r.plan).toBe(`would run: sudo tailscale cert ${FQDN}`);
  });

  it('execute on an absent cert: probe, issue, re-probe — and the re-probe is the verdict', async () => {
    const calls = scriptSsh([absentOutput, presentOutput]);
    const r = await ensureTailscaleCert(target, { execute: true });
    expect(calls).toEqual(['probe', 'issue', 'probe']);
    expect(r.issue?.value).toBe('issued');
    expect(r.issue?.via).toBe(`sudo -n tailscale cert ${FQDN}`);
    expect(r.after?.cert.value).toBe('present');
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/^issued; cert present/);
  });

  it('does not trust the exit code: issued but still absent in the store is a failure that says so', async () => {
    const calls = scriptSsh([absentOutput, absentOutput]);
    const r = await ensureTailscaleCert(target, { execute: true });
    expect(calls).toEqual(['probe', 'issue', 'probe']);
    expect(r.issue?.value).toBe('issued');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/store disagrees/);
  });

  it("reports a failed issue with tailscale's last line, then what the store says", async () => {
    const calls = scriptSsh([absentOutput, absentOutput], { ok: true, out: 'cert-issue-failed', err: 'ACME: rate limited', code: 0, ms: 5 });
    const r = await ensureTailscaleCert(target, { execute: true });
    expect(calls).toEqual(['probe', 'issue', 'probe']);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('tailscale cert failed (ACME: rate limited)');
    expect(r.detail).toContain('no cert for');
  });

  it('execute on a present cert still asks tailscaled, which is how a renewal happens', async () => {
    const calls = scriptSsh([presentOutput, presentOutput]);
    const r = await ensureTailscaleCert(target, { execute: true });
    expect(calls).toEqual(['probe', 'issue', 'probe']);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/^renewed if due/);
  });

  it('never runs the issue when HTTPS is off for the tailnet', async () => {
    const calls = scriptSsh([probeOutput({ status: statusJson({ CertDomains: [] }), priv: 'root', store: 'listed' })]);
    const r = await ensureTailscaleCert(target, { execute: true });
    expect(calls).toEqual(['probe']);
    expect(r.final.cert.value).toBe('https-not-enabled');
    expect(r.ok).toBe(true);
    expect(r.plan).toMatch(/would skip: HTTPS is not enabled/);
  });

  it('never runs the issue when the store could not be read — it could not verify the result either', async () => {
    const calls = scriptSsh([unreadableOutput]);
    const r = await ensureTailscaleCert(target, { execute: true });
    expect(calls).toEqual(['probe']);
    expect(r.final.cert.value).toBe('unreadable-without-sudo');
    expect(r.plan).toMatch(/would skip: cannot verify or issue/);
  });

  it('never runs the issue on a node with no tailscale, or a non-Linux one', async () => {
    let calls = scriptSsh([probeOutput({ tailscale: 'missing' })]);
    expect((await ensureTailscaleCert(target, { execute: true })).final.cert.value).toBe('tailscale-missing');
    expect(calls).toEqual(['probe']);
    calls = scriptSsh([probeOutput({ os: 'Darwin' })]);
    expect((await ensureTailscaleCert(target, { execute: true })).final.cert.value).toBe('not-linux');
    expect(calls).toEqual(['probe']);
  });

  it('reports an SSH failure as not measured, with the SSH verdict as the via', async () => {
    mocks.sshCapture.mockResolvedValue({ ok: false, out: '', err: 'tailnet policy does not permit you to SSH to this node', code: 255, ms: 5 });
    const r = await ensureTailscaleCert(target, { execute: true });
    expect(r.final.cert.value).toBe('unknown');
    expect(r.final.cert.via).toBe('ssh failed (acl-denied)');
    expect(r.ok).toBe(false);
    expect(renderCertCell(r.final).text).toBe('— ssh failed (acl-denied)');
  });
});

// ─── The install step ────────────────────────────────────────────────────────

describe('tailscaleCertStep', () => {
  it('is a passing, skipped step when the tailnet has HTTPS off — the Hub is still installed', async () => {
    scriptSsh([probeOutput({ status: statusJson({ CertDomains: [] }), priv: 'root', store: 'listed' })]);
    const step = await tailscaleCertStep(target);
    expect(step.name).toBe('tailscale cert');
    expect(step.ok).toBe(true);
    expect(step.skipped).toBe(true);
    expect(step.detail).toMatch(/HTTPS is not enabled/);
    expect(step.detail).toMatch(/pooling needs https/);
  });

  it('is a failed, NOT skipped step when the node could not be measured', async () => {
    // `installNode` counts skipped as fine; a measurement that failed must not hide behind it.
    mocks.sshCapture.mockResolvedValue({ ok: false, out: '', err: '', code: null, ms: 5 });
    const step = await tailscaleCertStep(target);
    expect(step.ok).toBe(false);
    expect(step.skipped).toBe(false);
  });

  it('passes and is not skipped when it issued and the store agrees', async () => {
    scriptSsh([absentOutput, presentOutput]);
    const step = await tailscaleCertStep(target);
    expect(step.ok).toBe(true);
    expect(step.skipped).toBe(false);
    expect(step.detail).toMatch(/^issued/);
  });

  it('fails when it issued and the store still lacks the file', async () => {
    scriptSsh([absentOutput, absentOutput]);
    const step = await tailscaleCertStep(target);
    expect(step.ok).toBe(false);
    expect(step.skipped).toBe(false);
  });
});

// ─── In the install sequence ─────────────────────────────────────────────────

describe('installNode runs the cert step', () => {
  const facts = {
    os: 'linux',
    arch: 'x86_64',
    appleSilicon: false,
    cpuCount: 16,
    load1: 0.2,
    docker: { present: true, usable: true },
    gpus: [],
    enginesListening: [],
    notes: [],
  };

  /** Every other install step answers with its marker; the cert step is driven by the fixtures. */
  function installSsh(probes: string[]) {
    const calls: string[] = [];
    mocks.readHostFacts.mockResolvedValue({ facts });
    mocks.sshCapture.mockImplementation(async (_target: unknown, cmd: string) => {
      if (isIssue(cmd)) {
        calls.push('issue');
        return ssh('cert-issue-complete');
      }
      if (isProbe(cmd)) {
        calls.push('probe');
        return ssh(probes.shift() ?? '');
      }
      if (cmd.includes('command -v cihub')) return ssh('/usr/local/bin/cihub\ncihub 0.2.70');
      if (cmd.includes('cihub up --detached')) return ssh('hub-up-complete');
      if (cmd.includes('systemd/user')) return ssh('status-timer-installed');
      if (cmd.includes('cihub pool pair')) return ssh('pool-join-attempted');
      calls.push(`other:${cmd.slice(0, 30)}`);
      return ssh('');
    });
    return calls;
  }

  const opts = { postgresPassword: 'a-long-enough-password', pairingCode: 'ABC123' };

  it("after the status timer and before the pool join, with the node's own name", async () => {
    const calls = installSsh([absentOutput, presentOutput]);
    const report = await installNode({ name: 'hub-a', ip: '100.64.0.1' }, { ...opts, joinPool: 'hub-b.example-tailnet.ts.net' }, 'root');
    const names = report.steps.map((s) => s.name);
    expect(names.indexOf('tailscale cert')).toBeGreaterThan(names.indexOf('status timer'));
    expect(names.indexOf('tailscale cert')).toBeLessThan(names.indexOf('join pool'));
    expect(calls).toEqual(['probe', 'issue', 'probe']);
    const issued = mocks.sshCapture.mock.calls.find(([, cmd]) => isIssue(cmd as string))?.[1] as string;
    expect(issued).toContain(`'${FQDN}'`);
    expect(report.ok).toBe(true);
  });

  it('leaves the install passing, with the step skipped and explained, when HTTPS is off', async () => {
    installSsh([probeOutput({ status: statusJson({ CertDomains: [] }), priv: 'root', store: 'listed' })]);
    const report = await installNode({ name: 'hub-a', ip: '100.64.0.1' }, opts, 'root');
    const step = report.steps.find((s) => s.name === 'tailscale cert');
    expect(step?.skipped).toBe(true);
    expect(step?.ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('marks the install failed when the certificate was issued but the store still lacks it', async () => {
    installSsh([absentOutput, absentOutput]);
    const report = await installNode({ name: 'hub-a', ip: '100.64.0.1' }, opts, 'root');
    const step = report.steps.find((s) => s.name === 'tailscale cert');
    expect(step?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
});
