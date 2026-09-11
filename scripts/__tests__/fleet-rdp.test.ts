/**
 * Tailnet-only remote desktop.
 *
 * Every case below is a state the fleet was actually found in on 2026-09-10, or a mistake the hand
 * pass actually made getting it out of that state:
 *
 *   · Three nodes ran RDP on `*:3389` — every interface, including the LAN.
 *   · xrdp 0.10 silently ignored `address=<tailnet ip>`; only `port=tcp://<ip>:3389` binds.
 *   · gnome-remote-desktop (`--system`) cannot bind an address at all; a firewall guard is the fix.
 *   · The first guard rule was refused because `--reject-with tcp-reset` needs `-p tcp` before it.
 */

import { describe, expect, it } from 'vitest';
import {
  GUARD_CHAIN,
  assessExposure,
  classifyRdpOwner,
  decideRdpPlan,
  guardInstallScript,
  guardUnitText,
  isGuardChainEffective,
  isTailnetAddress,
  parseRdpProbe,
  parseSsListeners,
  rewriteXrdpIniBind,
  xrdpApplyScript,
  xrdpPrepareScript,
  type RdpState,
} from '../lib/fleet-rdp.js';

const IP = '100.101.102.103';

/** A trimmed copy of the xrdp.ini Ubuntu ships, with the parts that matter to the rewrite. */
const SHIPPED_INI = `[Globals]
; xrdp.ini file version number
ini_version=1

; fork a new process for each incoming connection
fork=true

; ports to listen on, number alone means listen on all interfaces
; 0.0.0.0 or :: if ipv6 is configured
; space between multiple occurrences
;
; Examples:
;   port=3389
;   port=unix://./tmp/xrdp.socket
;   port=tcp://.:3389                           127.0.0.1:3389
;   port=tcp://:3389                            *:3389
;   port=tcp://<any ipv4 format addr>:3389      192.168.1.1:3389
port=3389

; 'port' above should be connected to with vsock instead of tcp
use_vsock=false

[Xorg]
name=Xorg
lib=libxup.so
username=ask
password=ask
ip=127.0.0.1
port=-1
code=20

[Xvnc]
name=Xvnc
lib=libvnc.so
ip=127.0.0.1
port=-1
`;

/** SHIPPED_INI with its real `[Globals]` port line replaced. `replace('port=3389')` would hit the commented example first. */
const withGlobalsPort = (value: string) => SHIPPED_INI.replace('\nport=3389\n', `\n${value}\n`);

describe('rewriteXrdpIniBind', () => {
  it('turns a bare port into a tailnet URL in [Globals] and nowhere else', () => {
    const out = rewriteXrdpIniBind(SHIPPED_INI, IP);
    expect(out).toContain(`\nport=tcp://${IP}:3389\n`);
    // The session sections keep their backend port. Rewriting those would point xrdp's own
    // connection to its X server at 3389 on the tailnet address.
    expect(out.match(/^port=-1$/gm)).toHaveLength(2);
    expect(out.match(/^port=/gm)).toHaveLength(3);
  });

  it('leaves the commented examples alone', () => {
    const out = rewriteXrdpIniBind(SHIPPED_INI, IP);
    expect(out).toContain(';   port=tcp://:3389                            *:3389');
    expect(out).toContain(';   port=3389\n');
  });

  it('removes the address= line xrdp 0.10 silently ignores', () => {
    // The trap: with address= set and port=3389 the daemon still listened on *:3389, and the key sat
    // there looking like the reason it should not have.
    const misled = withGlobalsPort(`address=${IP}\nport=3389`);
    const out = rewriteXrdpIniBind(misled, IP);
    expect(out).not.toMatch(/^address=/m);
    expect(out).toContain(`port=tcp://${IP}:3389`);
  });

  it('is a no-op on a file that is already correct', () => {
    const correct = withGlobalsPort(`port=tcp://${IP}:3389`);
    expect(rewriteXrdpIniBind(correct, IP)).toBe(correct);
  });

  it('is idempotent', () => {
    const once = rewriteXrdpIniBind(SHIPPED_INI, IP);
    expect(rewriteXrdpIniBind(once, IP)).toBe(once);
  });

  it('replaces a port that is already a URL, including one that binds everywhere', () => {
    // xrdp accepts several space-separated listeners in one `port=`; a tailnet URL followed by
    // `tcp://:3389` still binds everywhere, so the whole value is replaced, not appended to.
    for (const existing of ['port=tcp://:3389', 'port=tcp://192.168.1.20:3389', 'port=tcp6://:3389', `port=tcp://${IP}:3389 tcp://:3389`]) {
      const out = rewriteXrdpIniBind(withGlobalsPort(existing), IP);
      expect(out.match(/^port=tcp.*$/gm)).toEqual([`port=tcp://${IP}:3389`]);
    }
  });

  it('collapses duplicate port lines in [Globals] to one', () => {
    const dup = withGlobalsPort('port=3389\nport=tcp://:3389');
    const out = rewriteXrdpIniBind(dup, IP);
    const globals = out.slice(0, out.indexOf('[Xorg]'));
    expect(globals.match(/^port=/gm)).toHaveLength(1);
  });

  it('inserts a port line under [Globals] when there is none', () => {
    const noPort = SHIPPED_INI.replace('\nport=3389\n', '\n');
    const out = rewriteXrdpIniBind(noPort, IP);
    expect(out.startsWith(`[Globals]\nport=tcp://${IP}:3389\n`)).toBe(true);
    expect(out.match(/^port=-1$/gm)).toHaveLength(2);
  });

  it('matches the section name case-insensitively and tolerates spaces around =', () => {
    const odd = '[globals]\nport = 3389\n[Xorg]\nport=-1\n';
    expect(rewriteXrdpIniBind(odd, IP)).toBe(`[globals]\nport=tcp://${IP}:3389\n[Xorg]\nport=-1\n`);
  });

  it('creates [Globals] when the file has none', () => {
    expect(rewriteXrdpIniBind('[Xorg]\nport=-1\n', IP)).toBe(`[Globals]\nport=tcp://${IP}:3389\n[Xorg]\nport=-1\n`);
  });

  it('refuses to write a bind that is not a tailnet address', () => {
    // There is no path to *:3389 or a LAN address through this function, by construction.
    expect(() => rewriteXrdpIniBind(SHIPPED_INI, '192.168.1.20')).toThrow(/not a tailnet/);
    expect(() => rewriteXrdpIniBind(SHIPPED_INI, '0.0.0.0')).toThrow(/not a tailnet/);
  });
});

describe('isTailnetAddress', () => {
  it('accepts the CGNAT /10 and the tailnet ULA, nothing else', () => {
    expect(isTailnetAddress('100.64.0.1')).toBe(true);
    expect(isTailnetAddress('100.127.255.254')).toBe(true);
    expect(isTailnetAddress('100.63.255.255')).toBe(false);
    expect(isTailnetAddress('100.128.0.1')).toBe(false);
    expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailnetAddress('192.168.0.115')).toBe(false);
    expect(isTailnetAddress('*')).toBe(false);
  });
});

/** Real `ss -ltnp` shape from an Ubuntu 24.04 node, run as root. */
const SS_HEADER = 'State  Recv-Q Send-Q  Local Address:Port   Peer Address:Port Process';
const SS_COMMON = [
  'LISTEN 0      4096    127.0.0.53%lo:53          0.0.0.0:*     users:(("systemd-resolve",pid=812,fd=14))',
  'LISTEN 0      128           0.0.0.0:22          0.0.0.0:*     users:(("sshd",pid=1120,fd=3))',
  'LISTEN 0      128              [::]:22             [::]:*     users:(("sshd",pid=1120,fd=4))',
  'LISTEN 0      4096        127.0.0.1:3350        0.0.0.0:*     users:(("xrdp-sesman",pid=2229,fd=7))',
];
const ss = (...extra: string[]) => [SS_HEADER, ...SS_COMMON, ...extra].join('\n');

describe('parseSsListeners', () => {
  it('reads addresses in every spelling ss uses, and the port after the last colon', () => {
    const listeners = parseSsListeners(ss('LISTEN 0      2                   *:3389              *:*     users:(("xrdp",pid=2231,fd=11))'));
    const find = (address: string, port: number) => listeners.find((l) => l.address === address && l.port === port);
    expect(find('127.0.0.53', 53)?.processes).toEqual(['systemd-resolve']); // %lo scope stripped
    expect(find('::', 22)?.processes).toEqual(['sshd']); // brackets stripped
    expect(find('*', 3389)?.processes).toEqual(['xrdp']);
    expect(find('127.0.0.1', 3350)?.processes).toEqual(['xrdp-sesman']);
  });

  it('reports an empty process list when ss could not see the owner', () => {
    // Unprivileged `ss -p` prints root's sockets with no users:(...) column at all.
    const listeners = parseSsListeners([SS_HEADER, 'LISTEN 0      2                   *:3389              *:*'].join('\n'));
    expect(listeners).toEqual([{ address: '*', port: 3389, processes: [] }]);
  });
});

describe('classifyRdpOwner', () => {
  it('finds nothing when 3389 is quiet', () => {
    expect(classifyRdpOwner(parseSsListeners(ss())).owner).toBe('none');
  });

  it('names xrdp wherever it is bound', () => {
    expect(classifyRdpOwner(parseSsListeners(ss('LISTEN 0 2 *:3389 *:* users:(("xrdp",pid=2231,fd=11))'))).owner).toBe('xrdp');
    expect(classifyRdpOwner(parseSsListeners(ss(`LISTEN 0 2 ${IP}:3389 0.0.0.0:* users:(("xrdp",pid=2231,fd=11))`))).owner).toBe('xrdp');
  });

  it('recognises gnome-remote-desktop by its kernel-truncated comm name', () => {
    // TASK_COMM_LEN is 16, so `gnome-remote-desktop-daemon` reaches ss as `gnome-remote-de`.
    const { owner, processNames } = classifyRdpOwner(parseSsListeners(ss('LISTEN 0 5 *:3389 *:* users:(("gnome-remote-de",pid=1502,fd=9))')));
    expect(owner).toBe('gnome-remote-desktop');
    expect(processNames).toEqual(['gnome-remote-de']);
  });

  it('reports anything else as other, by name', () => {
    const { owner, processNames } = classifyRdpOwner(parseSsListeners(ss('LISTEN 0 5 0.0.0.0:3389 0.0.0.0:* users:(("docker-proxy",pid=77,fd=4))')));
    expect(owner).toBe('other');
    expect(processNames).toEqual(['docker-proxy']);
  });

  it('reports two servers on the port as other rather than picking one', () => {
    const both = ss(
      `LISTEN 0 2 ${IP}:3389 0.0.0.0:* users:(("xrdp",pid=1,fd=11))`,
      'LISTEN 0 5 [::]:3389 [::]:* users:(("gnome-remote-de",pid=2,fd=9))',
    );
    expect(classifyRdpOwner(parseSsListeners(both)).owner).toBe('other');
  });

  it('distinguishes an unreadable owner from an absent one', () => {
    const { owner } = classifyRdpOwner(parseSsListeners([SS_HEADER, 'LISTEN 0 2 *:3389 *:*'].join('\n')));
    expect(owner).toBe('unknown');
  });
});

/** Assemble probe output the way `rdpProbeScript` emits it. */
function probe(
  over: {
    ss?: string;
    sudo?: string;
    os?: string;
    tailnetIp?: string;
    guardUnit?: string;
    jump4?: string;
    chain4?: string;
    ip6?: string;
    jump6?: string;
    chain6?: string;
    load1?: string;
    cpus?: string;
  } = {},
) {
  return [
    `sudo=${over.sudo ?? 'yes'}`,
    `os=${over.os ?? 'Linux'}`,
    `cpus=${over.cpus ?? '16'}`,
    `load1=${over.load1 ?? '0.42'}`,
    `tailnet_ip=${over.tailnetIp ?? IP}`,
    `tailscale0_ip=${over.tailnetIp ?? IP}`,
    `ip6tables=${over.ip6 ?? 'absent'}`,
    `guard_unit=${over.guardUnit ?? 'inactive'}`,
    `guard_jump4=${over.jump4 ?? 'no'}`,
    `guard_jump6=${over.jump6 ?? 'no'}`,
    'guard4-begin',
    over.chain4 ?? '',
    'guard4-end',
    'guard6-begin',
    over.chain6 ?? '',
    'guard6-end',
    'ss-begin',
    over.ss ?? ss(),
    'ss-end',
  ].join('\n');
}

const EFFECTIVE_CHAIN = [
  `-N ${GUARD_CHAIN}`,
  `-A ${GUARD_CHAIN} -i lo -p tcp -m tcp --dport 3389 -j ACCEPT`,
  `-A ${GUARD_CHAIN} -i tailscale0 -p tcp -m tcp --dport 3389 -j ACCEPT`,
  `-A ${GUARD_CHAIN} -p tcp -m tcp --dport 3389 -j REJECT --reject-with tcp-reset`,
].join('\n');

describe('parseRdpProbe', () => {
  it('flags a wildcard bind as exposed and a tailnet bind as not', () => {
    const wide = parseRdpProbe(probe({ ss: ss('LISTEN 0 2 *:3389 *:* users:(("xrdp",pid=1,fd=11))') }));
    expect(wide.owner).toBe('xrdp');
    expect(wide.exposedAddresses).toEqual(['*']);
    expect(wide.tailnetOnly).toBe(false);

    const narrow = parseRdpProbe(probe({ ss: ss(`LISTEN 0 2 ${IP}:3389 0.0.0.0:* users:(("xrdp",pid=1,fd=11))`) }));
    expect(narrow.exposedAddresses).toEqual([]);
    expect(narrow.tailnetOnly).toBe(true);
  });

  it('treats a LAN address as exposed too — tailnet-only means tailnet-only', () => {
    const lan = parseRdpProbe(probe({ ss: ss('LISTEN 0 2 192.168.0.115:3389 0.0.0.0:* users:(("xrdp",pid=1,fd=11))') }));
    expect(lan.exposedAddresses).toEqual(['192.168.0.115']);
  });

  it('only believes a tailnet ip that is in the tailnet range', () => {
    expect(parseRdpProbe(probe({ tailnetIp: '' })).tailnetIp).toBeUndefined();
    expect(parseRdpProbe(probe({ tailnetIp: '192.168.1.5' })).tailnetIp).toBeUndefined();
    expect(parseRdpProbe(probe()).tailnetIp).toBe(IP);
  });

  it('judges the guard on its rules, not on the unit being active', () => {
    const flushed = parseRdpProbe(probe({ guardUnit: 'active', jump4: 'no', chain4: '' }));
    expect(flushed.guard.unitActive).toBe(true);
    expect(flushed.guard.effective4).toBe(false);

    const live = parseRdpProbe(probe({ guardUnit: 'active', jump4: 'yes', chain4: EFFECTIVE_CHAIN }));
    expect(live.guard.effective4).toBe(true);
    expect(live.guard.effective6).toBeUndefined();
  });

  it('asks the v6 chain to be effective too when the node has ip6tables', () => {
    const v4only = parseRdpProbe(probe({ ip6: 'present', guardUnit: 'active', jump4: 'yes', chain4: EFFECTIVE_CHAIN, jump6: 'no' }));
    expect(v4only.guard.effective6).toBe(false);
  });
});

describe('isGuardChainEffective', () => {
  it('needs the INPUT jump, the tailscale0 accept and the tcp-reset reject', () => {
    expect(isGuardChainEffective(EFFECTIVE_CHAIN, true)).toBe(true);
    expect(isGuardChainEffective(EFFECTIVE_CHAIN, false)).toBe(false);
    expect(isGuardChainEffective(EFFECTIVE_CHAIN.replace(/.*tcp-reset.*\n?/, ''), true)).toBe(false);
    expect(isGuardChainEffective(EFFECTIVE_CHAIN.replace(/.*tailscale0.*\n?/, ''), true)).toBe(false);
    expect(isGuardChainEffective('', true)).toBe(false);
  });
});

describe('decideRdpPlan', () => {
  const xrdpWide = () => parseRdpProbe(probe({ ss: ss('LISTEN 0 2 *:3389 *:* users:(("xrdp",pid=1,fd=11))') }));
  const grd = (over: Parameters<typeof probe>[0] = {}) =>
    parseRdpProbe(probe({ ss: ss('LISTEN 0 5 *:3389 *:* users:(("gnome-remote-de",pid=2,fd=9))'), ...over }));

  it('installs xrdp when nothing owns 3389', () => {
    const d = decideRdpPlan(parseRdpProbe(probe()));
    expect(d.kind).toBe('xrdp');
    if (d.kind === 'xrdp') expect(d.tailnetIp).toBe(IP);
  });

  it('rebinds xrdp that listens too widely — the state all three pre-existing installs were in', () => {
    const d = decideRdpPlan(xrdpWide());
    expect(d.kind).toBe('xrdp');
    expect(d.why).toMatch(/rebind/);
  });

  it('has nothing to do for xrdp already on the tailnet address', () => {
    const d = decideRdpPlan(parseRdpProbe(probe({ ss: ss(`LISTEN 0 2 ${IP}:3389 0.0.0.0:* users:(("xrdp",pid=1,fd=11))`) })));
    expect(d.kind).toBe('ok');
  });

  it('guards gnome-remote-desktop, which cannot bind an address', () => {
    const d = decideRdpPlan(grd());
    expect(d.kind).toBe('guard');
    expect(d.why).toMatch(/cannot bind an address/);
  });

  it('has nothing to do once the guard is effective', () => {
    expect(decideRdpPlan(grd({ guardUnit: 'active', jump4: 'yes', chain4: EFFECTIVE_CHAIN })).kind).toBe('ok');
  });

  it('re-installs the guard when the unit is active but the rules are gone', () => {
    expect(decideRdpPlan(grd({ guardUnit: 'active', jump4: 'no', chain4: '' })).kind).toBe('guard');
  });

  it('refuses when something else holds the port, and names it', () => {
    const d = decideRdpPlan(parseRdpProbe(probe({ ss: ss('LISTEN 0 5 0.0.0.0:3389 0.0.0.0:* users:(("docker-proxy",pid=77,fd=4))') })));
    expect(d.kind).toBe('refuse');
    expect(d.why).toMatch(/docker-proxy/);
  });

  it('refuses when the owner could not be read rather than guessing', () => {
    const d = decideRdpPlan(parseRdpProbe(probe({ ss: [SS_HEADER, 'LISTEN 0 2 *:3389 *:*'].join('\n') })));
    expect(d.kind).toBe('refuse');
    expect(d.why).toMatch(/owner could not be read/);
  });

  it('refuses without root, since neither attribution nor installation is possible', () => {
    const d = decideRdpPlan(parseRdpProbe(probe({ sudo: 'no' })));
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.fix).toMatch(/passwordless sudo/);
  });

  it('refuses without a tailnet address, because there is nothing tailnet-only to bind to', () => {
    expect(decideRdpPlan(parseRdpProbe(probe({ tailnetIp: '' }))).kind).toBe('refuse');
    expect(decideRdpPlan(parseRdpProbe(probe({ tailnetIp: '', ss: ss('LISTEN 0 2 *:3389 *:* users:(("xrdp",pid=1,fd=11))') }))).kind).toBe('refuse');
  });

  it('is Linux-only', () => {
    const d = decideRdpPlan(parseRdpProbe(probe({ os: 'Darwin' })));
    expect(d.kind).toBe('refuse');
    expect(d.why).toMatch(/Linux-only/);
  });
});

describe('assessExposure', () => {
  const state = (raw: string): RdpState => parseRdpProbe(raw);

  it('passes xrdp bound to the tailnet address', () => {
    expect(assessExposure(state(probe({ ss: ss(`LISTEN 0 2 ${IP}:3389 0.0.0.0:* users:(("xrdp",pid=1,fd=11))`) }))).exposed).toBe(false);
  });

  it('fails a wildcard bind with no guard', () => {
    const r = assessExposure(state(probe({ ss: ss('LISTEN 0 2 *:3389 *:* users:(("xrdp",pid=1,fd=11))') })));
    expect(r.exposed).toBe(true);
    expect(r.why).toMatch(/reachable off the tailnet/);
  });

  it('passes gnome-remote-desktop on *:3389 only when the guard rules are actually in place', () => {
    const grdSs = ss('LISTEN 0 5 *:3389 *:* users:(("gnome-remote-de",pid=2,fd=9))');
    expect(assessExposure(state(probe({ ss: grdSs, guardUnit: 'active', jump4: 'yes', chain4: EFFECTIVE_CHAIN }))).exposed).toBe(false);
    // Unit active, rules flushed: the verdict must be on the rules.
    const flushed = assessExposure(state(probe({ ss: grdSs, guardUnit: 'active', jump4: 'no', chain4: '' })));
    expect(flushed.exposed).toBe(true);
    expect(flushed.why).toMatch(/rules are missing/);
  });

  it('fails a guarded v4 when the node has ip6tables and v6 is unguarded', () => {
    const grdSs = ss('LISTEN 0 5 *:3389 *:* users:(("gnome-remote-de",pid=2,fd=9))');
    expect(
      assessExposure(state(probe({ ss: grdSs, ip6: 'present', guardUnit: 'active', jump4: 'yes', chain4: EFFECTIVE_CHAIN, jump6: 'no' }))).exposed,
    ).toBe(true);
    expect(
      assessExposure(
        state(
          probe({ ss: grdSs, ip6: 'present', guardUnit: 'active', jump4: 'yes', chain4: EFFECTIVE_CHAIN, jump6: 'yes', chain6: EFFECTIVE_CHAIN }),
        ),
      ).exposed,
    ).toBe(false);
  });
});

describe('guard unit', () => {
  const unit = guardUnitText();

  it('puts -p tcp before --reject-with tcp-reset — the rule iptables refused the first time', () => {
    const rejects = unit.match(/[^;']*--reject-with tcp-reset/g) ?? [];
    expect(rejects.length).toBeGreaterThanOrEqual(2); // iptables and ip6tables
    for (const rule of rejects) {
      expect(rule).toMatch(/-p tcp --dport 3389 -j REJECT --reject-with tcp-reset$/);
      expect(rule.indexOf('-p tcp')).toBeLessThan(rule.indexOf('--reject-with'));
    }
  });

  it('accepts tailscale0 and lo before it rejects', () => {
    const v4 = unit.split('\n').find((l) => l.startsWith('ExecStart=') && !l.includes('ip6tables')) ?? '';
    const lo = v4.indexOf('-i lo -p tcp --dport 3389 -j ACCEPT');
    const ts = v4.indexOf('-i tailscale0 -p tcp --dport 3389 -j ACCEPT');
    const reject = v4.indexOf('-j REJECT --reject-with tcp-reset');
    expect(lo).toBeGreaterThan(-1);
    expect(ts).toBeGreaterThan(lo);
    expect(reject).toBeGreaterThan(ts);
  });

  it('is idempotent: reuse-or-create, flush, and exactly one INPUT jump at position 1', () => {
    expect(unit).toContain(`iptables -N ${GUARD_CHAIN} 2>/dev/null || true`);
    expect(unit).toContain(`iptables -F ${GUARD_CHAIN}`);
    expect(unit).toContain(
      `while iptables -D INPUT -p tcp --dport 3389 -j ${GUARD_CHAIN} 2>/dev/null; do :; done; iptables -I INPUT 1 -p tcp --dport 3389 -j ${GUARD_CHAIN}`,
    );
  });

  it('is a oneshot that stays active and removes the chain on stop', () => {
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    const stops = unit.split('\n').filter((l) => l.startsWith('ExecStop='));
    expect(stops).toHaveLength(2);
    expect(stops[0]).toContain(`iptables -D INPUT -p tcp --dport 3389 -j ${GUARD_CHAIN}`);
    expect(stops[0]).toContain(`iptables -X ${GUARD_CHAIN}`);
  });

  it('contains no $ — systemd expands it before the shell would', () => {
    expect(unit).not.toContain('$');
  });

  it('covers ip6tables when present and does not fail the unit when absent', () => {
    const v6 = unit.split('\n').filter((l) => l.includes('ip6tables'));
    expect(v6).toHaveLength(2);
    for (const line of v6) expect(line).toContain('command -v ip6tables >/dev/null 2>&1 || exit 0');
  });

  it('is installed with a restart, so an already-active unit re-applies the rules', () => {
    const script = guardInstallScript();
    expect(script).toContain("cat > /etc/systemd/system/rdp-tailnet-guard.service <<'CIHUB_RDP_GUARD_EOF'");
    expect(script).toContain('systemctl restart rdp-tailnet-guard.service');
    expect(script).not.toContain('enable --now');
    expect(script).toContain('echo rdp-guard-complete');
  });
});

describe('xrdp scripts', () => {
  it('installs the proven package set with Recommends, since xorgxrdp is one', () => {
    const script = xrdpPrepareScript();
    expect(script).toContain('apt-get install -y xrdp xfce4 xfce4-terminal dbus-x11');
    expect(script).not.toContain('--no-install-recommends');
  });

  it('writes startxfce4 to the login user’s ~/.xsession and returns the current ini', () => {
    const script = xrdpPrepareScript();
    expect(script).toContain('printf \'startxfce4\\n\' > "$home/.xsession"');
    expect(script).toContain('cat /etc/xrdp/xrdp.ini');
    expect(script).toContain('ini-begin');
  });

  it('applies the rewritten ini verbatim, adds xrdp to ssl-cert, and restarts rather than just enabling', () => {
    const ini = rewriteXrdpIniBind(SHIPPED_INI, IP);
    const script = xrdpApplyScript(ini);
    expect(script).toContain("<<'CIHUB_XRDP_INI_EOF'\n[Globals]");
    expect(script).toContain(`port=tcp://${IP}:3389`);
    expect(script).toContain('adduser xrdp ssl-cert');
    expect(script).toContain('systemctl restart xrdp.service');
    expect(script).toContain('echo xrdp-apply-complete');
  });
});
