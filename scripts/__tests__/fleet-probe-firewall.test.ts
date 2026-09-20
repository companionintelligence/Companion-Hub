/**
 * ufw rules for the Hub's engine probes: planned from `ufw status`, added once, proven afterwards.
 *
 * Measured 2026-09-20: on beta-nas, beta-1, core-6 and core-5 ufw dropped the Docker-bridge SYN to
 * every engine port except :11434, so each of the six live probes a pooled request runs waited its
 * full 5000 ms axios timeout — a flat 5.0 s TTFT against 22-100 ms once the port answered. The
 * status table below is beta-nas's after the hand-written fix, byte for byte.
 *
 * ufw reads its table top down and the first match decides; `ufw allow` appends. The audit put
 * `ufw reject from 172.16.0.0/12 to any port 8000,8080,13305 proto tcp` on beta-1, beta-nas, core-6
 * and core-5 by hand before this step existed, and asked for reject rather than allow on beta-1's
 * :8000 — so a reject the table already carries must be recognised as "fails fast, leave it", never
 * as "missing", or the step appends an allow that never fires and reports it applied.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyProbeFirewallOutput,
  DOCKER_BRIDGE_CIDR,
  firewallProbeScript,
  HUB_PROBE_PORTS,
  parseFirewallProbe,
  parseUfwStatus,
  planProbeFirewall,
  probeFirewallApplyShell,
  ufwAdmitsBridgeTo,
  ufwBlocksBridgeTo,
  ufwBridgeVerdict,
  ufwSourceCoversBridge,
  ufwVerdictShellFunction,
} from '../lib/fleet-probe-firewall.js';

/** core-6 after the audit's O1: one reject row for three ports, ahead of anything this step adds. */
const O1_REJECT_STATUS = [
  'Status: active',
  '',
  'To                         Action      From',
  '--                         ------      ----',
  '22/tcp                     ALLOW       Anywhere',
  '11434/tcp                  ALLOW       172.16.0.0/12              # ci-hub container -> host ollama',
  '8000,8080,13305/tcp        REJECT      172.16.0.0/12              # ci-hub probe: fail fast',
  '22/tcp (v6)                ALLOW       Anywhere (v6)',
  '',
].join('\n');

const BETA_NAS_STATUS = [
  'Status: active',
  '',
  'To                         Action      From',
  '--                         ------      ----',
  '22/tcp                     ALLOW       Anywhere',
  '11434/tcp                  ALLOW       172.16.0.0/12              # ci-hub container -> host ollama',
  '8000/tcp                   ALLOW       172.16.0.0/12              # ci-hub container -> host vllm',
  '13305/tcp                  ALLOW       172.16.0.0/12              # ci-hub container -> host lemonade',
  '5002/tcp                   ALLOW       100.64.0.0/10',
  '22/tcp (v6)                ALLOW       Anywhere (v6)',
  '',
].join('\n');

const probeOut = (parts: { root?: boolean; bin?: boolean; conf?: 'yes' | 'no' | ''; status?: string }) =>
  [
    'firewall_probe=1',
    `root=${parts.root === false ? 'no' : 'yes'}`,
    `ufw_bin=${parts.bin === false ? 'no' : 'yes'}`,
    `ufw_conf=${parts.conf ?? 'yes'}`,
    'ufw-status-begin',
    parts.status ?? '',
    'ufw-status-end',
  ].join('\n');

describe('parseUfwStatus', () => {
  it('reads the rule table, comments stripped, v6 rows marked', () => {
    const rules = parseUfwStatus(BETA_NAS_STATUS);
    expect(rules.map((r) => `${r.to} ${r.action} ${r.from}${r.v6 ? ' v6' : ''}`)).toEqual([
      '22/tcp ALLOW Anywhere',
      '11434/tcp ALLOW 172.16.0.0/12',
      '8000/tcp ALLOW 172.16.0.0/12',
      '13305/tcp ALLOW 172.16.0.0/12',
      '5002/tcp ALLOW 100.64.0.0/10',
      '22/tcp (v6) ALLOW Anywhere v6',
    ]);
    expect(rules[1]).toMatchObject({ port: 11434, proto: 'tcp' });
  });

  it('reads `status verbose`, whose action column carries a direction', () => {
    const rules = parseUfwStatus('8080/tcp                   ALLOW IN    172.16.0.0/12\n22/tcp                     ALLOW OUT   Anywhere');
    expect(rules[0]).toMatchObject({ port: 8080, action: 'ALLOW', direction: 'IN', from: '172.16.0.0/12' });
    expect(rules[1]).toMatchObject({ direction: 'OUT' });
  });

  it('reads a port list and a port range as one rule naming every port, in table order', () => {
    const rules = parseUfwStatus(O1_REJECT_STATUS);
    expect(rules.map((r) => `${r.to} ${r.action}`)).toEqual(['22/tcp ALLOW', '11434/tcp ALLOW', '8000,8080,13305/tcp REJECT', '22/tcp (v6) ALLOW']);
    expect(rules[2]).toMatchObject({
      port: undefined,
      ports: [
        [8000, 8000],
        [8080, 8080],
        [13305, 13305],
      ],
      proto: 'tcp',
      action: 'REJECT',
    });
    const [range] = parseUfwStatus('8000:8010/tcp              ALLOW       172.16.0.0/12');
    expect(range).toMatchObject({ port: undefined, ports: [[8000, 8010]], proto: 'tcp' });
    // A source with no port at all names none, and can never decide a probe port.
    expect(parseUfwStatus('Anywhere                   ALLOW       10.0.0.0/8')[0]?.ports).toEqual([]);
  });
});

describe('ufwSourceCoversBridge', () => {
  it('counts Anywhere and any prefix at least as wide as the bridge pool, and not a narrower one', () => {
    for (const from of ['Anywhere', '172.16.0.0/12', '172.0.0.0/8', '0.0.0.0/0', '172.31.255.255/12'])
      expect(ufwSourceCoversBridge(from), from).toBe(true);
    for (const from of ['172.17.0.0/16', '172.18.0.1', '10.0.0.0/8', '100.64.0.0/10', '172.32.0.0/12', 'fd00::/8']) {
      expect(ufwSourceCoversBridge(from), from).toBe(false);
    }
  });
});

describe('ufwBridgeVerdict', () => {
  it('is the first rule that names the port for the bridge — a reject above an allow wins, and the other way round', () => {
    const rejectFirst = parseUfwStatus(
      ['8000/tcp                   REJECT      172.16.0.0/12', '8000/tcp                   ALLOW       172.16.0.0/12'].join('\n'),
    );
    expect(ufwBridgeVerdict(rejectFirst, 8000)).toBe('REJECT');
    expect(ufwAdmitsBridgeTo(rejectFirst, 8000)).toBe(false);
    expect(ufwBlocksBridgeTo(rejectFirst, 8000)).toBe(true);
    const allowFirst = parseUfwStatus(
      ['8000/tcp                   ALLOW       172.16.0.0/12', '8000/tcp                   REJECT      172.16.0.0/12'].join('\n'),
    );
    expect(ufwBridgeVerdict(allowFirst, 8000)).toBe('ALLOW');
    expect(ufwAdmitsBridgeTo(allowFirst, 8000)).toBe(true);
  });

  it('sees a port inside a list, a range, a wider source, a bare port, and nothing else', () => {
    const rules = parseUfwStatus(
      [
        '8000,8080,13305/tcp        REJECT      172.16.0.0/12',
        '8200:8300/tcp              DENY        172.0.0.0/8', // wider than the pool: still every bridge
        '9000                       ALLOW       Anywhere', // both protocols
        '9100/tcp                   LIMIT       172.16.0.0/12',
        '9200/udp                   ALLOW       172.16.0.0/12',
        '9300/tcp                   DENY        172.17.0.0/16', // the default bridge only: decides nothing for compose networks
        '9400/tcp                   ALLOW OUT   172.16.0.0/12',
        '9500/tcp (v6)              ALLOW       Anywhere (v6)',
      ].join('\n'),
    );
    expect(ufwBridgeVerdict(rules, 8080)).toBe('REJECT');
    expect(ufwBridgeVerdict(rules, 8216)).toBe('DENY');
    expect(ufwBridgeVerdict(rules, 9000)).toBe('ALLOW');
    // LIMIT: an allow appended behind it is dead, and six probes a request would trip its cap anyway.
    expect(ufwBridgeVerdict(rules, 9100)).toBe('LIMIT');
    expect(ufwBlocksBridgeTo(rules, 9100)).toBe(true);
    for (const port of [9200, 9300, 9400, 9500, 8100]) expect(ufwBridgeVerdict(rules, port), String(port)).toBeUndefined();
  });
});

describe('ufwAdmitsBridgeTo', () => {
  it('counts the /12 and Anywhere, and not a narrower source, a deny, or an outbound rule', () => {
    const rules = parseUfwStatus(
      [
        '8000/tcp                   ALLOW       172.16.0.0/12',
        '8080/tcp                   ALLOW       Anywhere',
        '13305/tcp                  ALLOW       172.17.0.0/16', // the default bridge only; compose networks sit outside it
        '8216/tcp                   DENY        172.16.0.0/12',
        '8020/tcp                   ALLOW OUT   172.16.0.0/12',
        '9000                       ALLOW       172.16.0.0/12', // both protocols: covers tcp
      ].join('\n'),
    );
    expect(ufwAdmitsBridgeTo(rules, 8000)).toBe(true);
    expect(ufwAdmitsBridgeTo(rules, 8080)).toBe(true);
    expect(ufwAdmitsBridgeTo(rules, 13305)).toBe(false);
    expect(ufwAdmitsBridgeTo(rules, 8216)).toBe(false);
    expect(ufwAdmitsBridgeTo(rules, 8020)).toBe(false);
    expect(ufwAdmitsBridgeTo(rules, 9000)).toBe(true);
  });
});

describe('planProbeFirewall', () => {
  it('beta-nas after the hand fix: adds only the two ports still missing, and says which are there', () => {
    const plan = planProbeFirewall(parseFirewallProbe(probeOut({ status: BETA_NAS_STATUS })));
    expect(plan.state).toBe('add');
    expect(plan.present).toEqual([8000, 13305]);
    expect(plan.missing).toEqual([8080, 8216]);
    expect(plan.commands).toEqual([
      `ufw allow from ${DOCKER_BRIDGE_CIDR} to any port 8080 proto tcp comment 'ci-hub container -> host engine :8080'`,
      `ufw allow from ${DOCKER_BRIDGE_CIDR} to any port 8216 proto tcp comment 'ci-hub container -> host engine :8216'`,
    ]);
    expect(plan.why).toContain('waits the full 5 s');
  });

  it('leaves a port the table already rejects alone: it fails fast, and an allow appended behind it would never fire', () => {
    // The reviewer's shape: the operator put a reject on :8000 (beta-1, on purpose) next to the ollama allow.
    const plan = planProbeFirewall(
      parseFirewallProbe(
        probeOut({
          status: [
            'Status: active',
            '8000/tcp                   REJECT      172.16.0.0/12',
            '11434/tcp                  ALLOW       172.16.0.0/12',
          ].join('\n'),
        }),
      ),
    );
    expect(plan.state).toBe('add');
    expect(plan.blocked).toEqual([8000]);
    expect(plan.missing).toEqual([8080, 13305, 8216]);
    expect(plan.commands.join('\n')).not.toContain('port 8000 ');
    expect(plan.why).toBe(
      'ufw active and dropping the bridge on :8080, :13305, :8216 (:8000 refused by a rule of its own, which fails fast and is left alone) — every Hub probe there waits the full 5 s',
    );

    // core-6 after O1: one reject row covers three of the four ports; only :8216 is still dropped.
    const o1 = planProbeFirewall(parseFirewallProbe(probeOut({ status: O1_REJECT_STATUS })));
    expect(o1.blocked).toEqual([8000, 8080, 13305]);
    expect(o1.missing).toEqual([8216]);
    expect(o1.commands).toHaveLength(1);

    // Every port decided, none by an allow: nothing to add, and the plan says why each is fine.
    const all = planProbeFirewall(parseFirewallProbe(probeOut({ status: `${O1_REJECT_STATUS}\n8216/tcp                   DENY        Anywhere` })));
    expect(all.state).toBe('present');
    expect(all.present).toEqual([]);
    expect(all.blocked).toEqual([8000, 8080, 13305, 8216]);
    expect(all.why).toBe('ufw active; bridge → :8000, :8080, :13305, :8216 refused by a rule of its own, which fails fast and is left alone');
  });

  it('is idempotent: a table that already admits every port plans nothing', () => {
    const full = [
      BETA_NAS_STATUS,
      '8080/tcp                   ALLOW       172.16.0.0/12',
      '8216/tcp                   ALLOW       172.16.0.0/12',
    ].join('\n');
    const plan = planProbeFirewall(parseFirewallProbe(probeOut({ status: full })));
    expect(plan.state).toBe('present');
    expect(plan.missing).toEqual([]);
    expect(plan.commands).toEqual([]);
  });

  it('plans nothing where ufw is inactive or absent — nothing drops the probes there', () => {
    expect(planProbeFirewall(parseFirewallProbe(probeOut({ status: 'Status: inactive', conf: 'no' }))).state).toBe('inactive');
    expect(planProbeFirewall(parseFirewallProbe(probeOut({ bin: false, conf: '' }))).state).toBe('inactive');
    // ufw's own config says enabled, and it is the unit's word against the config's: the config wins
    // (the unit is a RemainAfterExit oneshot that reads active after `ufw disable`).
    expect(planProbeFirewall(parseFirewallProbe(probeOut({ status: 'Status: inactive', conf: 'yes' }))).state).toBe('inactive');
  });

  it('says the rules need root when ufw is enabled but the table could not be read, and still lists what it would add', () => {
    const plan = planProbeFirewall(parseFirewallProbe(probeOut({ root: false, conf: 'yes', status: '' })));
    expect(plan.state).toBe('unreadable');
    expect(plan.why).toContain('passwordless sudo');
    expect(plan.missing).toEqual([...HUB_PROBE_PORTS]);
  });

  it('reports a probe that never ran as unknown, not as a node with no firewall', () => {
    expect(planProbeFirewall(parseFirewallProbe('')).state).toBe('unknown');
  });

  it('the probe script only reads', () => {
    expect(firewallProbeScript()).not.toMatch(/ufw (allow|deny|reject|delete|enable|disable)/);
    expect(firewallProbeScript()).toContain('ufw status');
  });
});

describe('classifyProbeFirewallOutput', () => {
  const table = (ports: number[]) =>
    ['ufw-status-begin', ...ports.map((p) => `${p}/tcp                   ALLOW       172.16.0.0/12`), 'ufw-status-end'].join('\n');
  it('keys on markers and then proves each planned port in the re-read table', () => {
    const ok = classifyProbeFirewallOutput(
      ['ufw-probe-added: 8080 (Rule added)', 'ufw-probe-present: 8216', table([8080, 8216]), 'ufw-probe-complete'].join('\n'),
      '',
      [8080, 8216],
    );
    expect(ok.outcome).toBe('applied');
    expect(ok.added).toEqual([8080]);
    expect(ok.present).toEqual([8216]);
    expect(ok.why).toContain('→ :8080');

    // "Rule added" was printed and the table still does not admit the bridge: not done.
    const lie = classifyProbeFirewallOutput(['ufw-probe-added: 8080 (Rule added)', table([]), 'ufw-probe-complete'].join('\n'), '', [8080]);
    expect(lie.outcome).toBe('failed');
    expect(lie.unverified).toEqual([8080]);

    expect(classifyProbeFirewallOutput('ufw-probe-skipped: ufw is not active', '', [8080]).outcome).toBe('skipped');
    expect(classifyProbeFirewallOutput('', 'ufw-probe-failed: :8080 — ERROR: Bad port', [8080]).outcome).toBe('failed');
    expect(classifyProbeFirewallOutput('Rule added', '', [8080]).outcome).toBe('incomplete');
  });

  it('reads the re-read table in order: an ALLOW row below a REJECT proves nothing, and a reported reject is verified as such', () => {
    // "Rule added" was printed, the row is in the table — under the reject that still takes every bridge packet first.
    const dead = classifyProbeFirewallOutput(
      [
        'ufw-probe-added: 8000 (Rule added)',
        'ufw-status-begin',
        '8000/tcp                   REJECT      172.16.0.0/12',
        '8000/tcp                   ALLOW       172.16.0.0/12',
        'ufw-status-end',
        'ufw-probe-complete',
      ].join('\n'),
      '',
      [8000],
    );
    expect(dead.outcome).toBe('failed');
    expect(dead.unverified).toEqual([8000]);

    // The shell found the reject first and appended nothing; the table agrees. Not a failure, and not "allowed".
    const left = classifyProbeFirewallOutput(
      [
        'ufw-probe-blocked: 8000 (REJECT)',
        'ufw-probe-added: 8216 (Rule added)',
        'ufw-status-begin',
        '8000,8080,13305/tcp        REJECT      172.16.0.0/12',
        '8216/tcp                   ALLOW       172.16.0.0/12',
        'ufw-status-end',
        'ufw-probe-complete',
      ].join('\n'),
      '',
      [8000, 8216],
    );
    expect(left.outcome).toBe('applied');
    expect(left.blocked).toEqual([8000]);
    expect(left.added).toEqual([8216]);
    expect(left.why).toBe('allowed 172.16.0.0/12 → :8216 (:8000 refused by a rule of its own, which fails fast and is left alone)');
  });
});

/** The real apply shell against a stub `ufw` that keeps a rule table in a file and logs every call. */
const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p));
describe.skipIf(!bash)('cihub_ufw_verdict (the shell copy of ufwBridgeVerdict)', () => {
  const table = [
    'Status: active',
    '',
    'To                         Action      From',
    '--                         ------      ----',
    '22/tcp                     ALLOW IN    Anywhere',
    '8000,8080,13305/tcp        REJECT IN   172.16.0.0/12              # ci-hub probe: fail fast',
    '8000/tcp                   ALLOW IN    172.16.0.0/12              # dead: below the reject',
    '8200:8300/tcp              DENY IN     172.0.0.0/8',
    '9000                       ALLOW IN    Anywhere',
    '9100/tcp                   LIMIT IN    172.16.0.0/12',
    '9200/udp                   ALLOW IN    172.16.0.0/12',
    '9300/tcp                   DENY IN     172.17.0.0/16',
    '9400/tcp                   ALLOW OUT   172.16.0.0/12',
    '9500/tcp (v6)              ALLOW IN    Anywhere (v6)',
    '9600/tcp                   ALLOW       10.0.0.1',
    '',
  ].join('\n');
  const verdicts = (awk?: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cihub-ufw-verdict-'));
    try {
      writeFileSync(path.join(dir, 'ufw'), `#!/bin/sh\ncat <<'EOF'\n${table}\nEOF\n`);
      chmodSync(path.join(dir, 'ufw'), 0o755);
      if (awk) {
        writeFileSync(path.join(dir, 'awk'), `#!/bin/sh\nexec ${awk} "$@"\n`);
        chmodSync(path.join(dir, 'awk'), 0o755);
      }
      const ports = [8000, 8080, 13305, 8216, 8400, 9000, 9100, 9200, 9300, 9400, 9500, 9600];
      const script = `${ufwVerdictShellFunction()}\nfor p in ${ports.join(' ')}; do echo "$p=$(cihub_ufw_verdict $p)"; done`;
      const res = spawnSync(bash as string, ['-e', '-c', script], { env: { PATH: `${dir}:/usr/bin:/bin`, HOME: '/tmp' }, encoding: 'utf-8' });
      expect(res.status, res.stderr).toBe(0);
      return res.stdout.trim().split('\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const expected = [
    '8000=REJECT', // first match, not the allow below it
    '8080=REJECT',
    '13305=REJECT',
    '8216=DENY', // inside the range, from a wider source
    '8400=', // nothing names it: a silent drop
    '9000=ALLOW', // bare port covers tcp
    '9100=LIMIT',
    '9200=', // udp only
    '9300=', // default bridge only
    '9400=', // outbound
    '9500=', // v6
    '9600=', // one host
  ];

  it('agrees with the TypeScript verdict on every row shape', () => {
    expect(verdicts()).toEqual(expected);
    const rules = parseUfwStatus(table);
    expect(expected.map((line) => Number(line.split('=')[0])).map((p) => `${p}=${ufwBridgeVerdict(rules, p) ?? ''}`)).toEqual(expected);
  });

  // The fleet runs Ubuntu, whose `awk` is mawk; a POSIX-only awk must read the same table the same way.
  for (const awk of ['mawk', 'gawk', 'nawk', 'busybox awk']) {
    const bin = awk.split(' ')[0] as string;
    it.skipIf(!['/usr/bin', '/bin'].some((d) => existsSync(path.join(d, bin))))(`under ${awk}`, () => {
      expect(verdicts(awk)).toEqual(expected);
    });
  }
});

describe.skipIf(!bash)('probeFirewallApplyShell (sandboxed bash)', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function sandbox(initialStatus: string) {
    const root = mkdtempSync(path.join(tmpdir(), 'cihub-ufw-'));
    sandboxes.push(root);
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const table = path.join(root, 'ufw-status');
    const log = path.join(root, 'calls.log');
    writeFileSync(table, initialStatus);
    // `ufw status` prints the table; `ufw allow … port N …` appends the row a real ufw would print.
    writeFileSync(
      path.join(bin, 'ufw'),
      [
        '#!/bin/sh',
        `echo "ufw $*" >> "${log}"`,
        'case "$1" in',
        `  status) cat "${table}" ;;`,
        '  allow) p=""; while [ $# -gt 0 ]; do [ "$1" = port ] && p="$2"; shift; done',
        `    if grep -qE "^$p/tcp[[:space:]]+ALLOW[[:space:]]+172\\.16\\.0\\.0/12" "${table}"; then echo "Skipping adding existing rule"; else printf '%-26s %-11s %s\\n' "$p/tcp" ALLOW 172.16.0.0/12 >> "${table}"; echo "Rule added"; fi ;;`,
        'esac',
      ].join('\n'),
    );
    chmodSync(path.join(bin, 'ufw'), 0o755);
    return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf-8') : ''), table: () => readFileSync(table, 'utf-8') };
  }

  const run = (script: string, box: { bin: string }) =>
    spawnSync(bash as string, ['-e', '-c', script], { env: { PATH: `${box.bin}:/usr/bin:/bin`, HOME: '/tmp' }, encoding: 'utf-8' });

  it('adds exactly the missing rules, proves them, and adds nothing the second time', () => {
    const box = sandbox(BETA_NAS_STATUS);
    const res = run(probeFirewallApplyShell([8080, 8216]), box);
    expect(res.status, res.stderr).toBe(0);
    const outcome = classifyProbeFirewallOutput(res.stdout, res.stderr, [8080, 8216]);
    expect(outcome.outcome).toBe('applied');
    expect(outcome.added).toEqual([8080, 8216]);
    // The stub logs argv, so the comment arrives as one word without its quotes.
    expect(box.calls()).toContain('ufw allow from 172.16.0.0/12 to any port 8080 proto tcp comment ci-hub container -> host engine :8080');
    expect(box.calls()).not.toContain('port 8000 ');
    expect(box.table()).toMatch(/^8216\/tcp\s+ALLOW\s+172\.16\.0\.0\/12/m);

    const again = run(probeFirewallApplyShell([8080, 8216]), box);
    expect(again.status, again.stderr).toBe(0);
    expect(classifyProbeFirewallOutput(again.stdout, again.stderr, [8080, 8216]).outcome).toBe('present');
    expect((box.calls().match(/ufw allow/g) ?? []).length).toBe(2);
  });

  it('appends nothing behind a reject the table already carries, and does not call that port allowed', () => {
    // core-6 after O1, with the plan computed before the reject landed: the shell re-reads in order.
    const box = sandbox(O1_REJECT_STATUS);
    const res = run(probeFirewallApplyShell([8000, 8080, 8216]), box);
    expect(res.status, res.stderr).toBe(0);
    const outcome = classifyProbeFirewallOutput(res.stdout, res.stderr, [8000, 8080, 8216]);
    expect(outcome.outcome).toBe('applied');
    expect(outcome.blocked).toEqual([8000, 8080]);
    expect(outcome.added).toEqual([8216]);
    expect(box.calls()).not.toContain('port 8000 ');
    expect(box.calls()).not.toContain('port 8080 ');
    expect((box.calls().match(/ufw allow/g) ?? []).length).toBe(1);
    // The table still leads with the reject; only :8216 gained a row.
    expect(box.table()).toMatch(/8000,8080,13305\/tcp\s+REJECT[\s\S]*8216\/tcp\s+ALLOW/);
  });

  it('touches nothing when ufw is inactive, and says so', () => {
    const box = sandbox('Status: inactive\n');
    const res = run(probeFirewallApplyShell([8080]), box);
    expect(res.status).toBe(0);
    expect(classifyProbeFirewallOutput(res.stdout, res.stderr, [8080]).outcome).toBe('skipped');
    expect(box.calls()).not.toContain('ufw allow');
  });
});
