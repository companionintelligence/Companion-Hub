/**
 * ufw rules for the Hub's engine probes: planned from `ufw status`, added once, proven afterwards.
 *
 * Measured 2026-09-20: on beta-nas, beta-1, core-6 and core-5 ufw dropped the Docker-bridge SYN to
 * every engine port except :11434, so each of the six live probes a pooled request runs waited its
 * full 5000 ms axios timeout — a flat 5.0 s TTFT against 22-100 ms once the port answered. The
 * status table below is beta-nas's after the hand-written fix, byte for byte.
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
} from '../lib/fleet-probe-firewall.js';

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
});

/** The real apply shell against a stub `ufw` that keeps a rule table in a file and logs every call. */
const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p));
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

  it('touches nothing when ufw is inactive, and says so', () => {
    const box = sandbox('Status: inactive\n');
    const res = run(probeFirewallApplyShell([8080]), box);
    expect(res.status).toBe(0);
    expect(classifyProbeFirewallOutput(res.stdout, res.stderr, [8080]).outcome).toBe('skipped');
    expect(box.calls()).not.toContain('ufw allow');
  });
});
