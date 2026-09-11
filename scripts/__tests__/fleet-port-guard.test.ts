/**
 * The port guard: accept from named interfaces, reset everything else, as a systemd oneshot.
 *
 * Two of these assertions exist because the rule they check was learned by a failed command on a
 * real node: `--reject-with tcp-reset` must follow `-p tcp`, and the unit's commands may not contain
 * a `$` that systemd would expand before the shell sees it.
 */
import { describe, expect, it } from 'vitest';
import {
  guardInstallShell,
  guardRemoveShell,
  guardRules,
  guardTeardown,
  guardUnitText,
  isGuardChainEffective,
  OLLAMA_PORT_GUARD,
  type PortGuardSpec,
} from '../lib/fleet-port-guard.js';

const spec: PortGuardSpec = {
  port: 4242,
  chain: 'TEST_GUARD',
  unitName: 'test-guard.service',
  description: 'test',
  acceptInterfaces: ['lo', 'tailscale0'],
  before: ['thing.service'],
};

describe('guardRules', () => {
  it('puts -p tcp before --reject-with tcp-reset — the rule iptables refused the first time', () => {
    const reject = guardRules(spec, 'iptables').find((r) => r.includes('--reject-with tcp-reset'));
    expect(reject).toBeDefined();
    expect(reject?.indexOf('-p tcp')).toBeLessThan(reject?.indexOf('--reject-with tcp-reset') ?? -1);
  });

  it('accepts each named interface, in order, before the reject', () => {
    const rules = guardRules(spec, 'ip6tables');
    const accepts = rules.filter((r) => r.includes('-j ACCEPT'));
    expect(accepts).toEqual([
      'ip6tables -A TEST_GUARD -i lo -p tcp --dport 4242 -j ACCEPT',
      'ip6tables -A TEST_GUARD -i tailscale0 -p tcp --dport 4242 -j ACCEPT',
    ]);
    expect(rules.indexOf(accepts[1] as string)).toBeLessThan(rules.findIndex((r) => r.includes('REJECT')));
  });

  it('is idempotent by construction: create-or-flush the chain, then exactly one jump from INPUT', () => {
    const rules = guardRules(spec, 'iptables');
    expect(rules[0]).toBe('iptables -N TEST_GUARD 2>/dev/null || true');
    expect(rules[1]).toBe('iptables -F TEST_GUARD');
    // Every existing jump is removed before the one jump is inserted, so a re-run does not stack them.
    const drain = rules.findIndex((r) => r.startsWith('while iptables -D INPUT'));
    const insert = rules.findIndex((r) => r.startsWith('iptables -I INPUT 1'));
    expect(drain).toBeGreaterThan(-1);
    expect(insert).toBe(drain + 1);
  });

  it('tears down in the reverse order: unjump, flush, delete — each tolerant of already-gone', () => {
    expect(guardTeardown(spec, 'iptables')).toEqual([
      'while iptables -D INPUT -p tcp --dport 4242 -j TEST_GUARD 2>/dev/null; do :; done',
      'iptables -F TEST_GUARD 2>/dev/null || true',
      'iptables -X TEST_GUARD 2>/dev/null || true',
    ]);
  });
});

describe('guardUnitText', () => {
  const unit = guardUnitText(spec);

  it('is a RemainAfterExit oneshot ordered before the daemon it protects', () => {
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('Before=network.target thing.service');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('applies v4 always and v6 only where ip6tables exists, and ExecStop undoes both', () => {
    const starts = unit.split('\n').filter((l) => l.startsWith('ExecStart='));
    const stops = unit.split('\n').filter((l) => l.startsWith('ExecStop='));
    expect(starts).toHaveLength(2);
    expect(stops).toHaveLength(2);
    expect(starts[1]).toContain('command -v ip6tables >/dev/null 2>&1 || exit 0');
    expect(stops[0]).toContain('iptables -X TEST_GUARD');
  });

  it('contains no $ — systemd would expand it before the shell ran', () => {
    expect(unit).not.toContain('$');
  });
});

describe('guardInstallShell / guardRemoveShell', () => {
  it('writes the unit where CIHUB_GUARD_UNIT_DIR says (default /etc/systemd/system), enables it, and proves the jump before saying ok', () => {
    const shell = guardInstallShell(spec, { heredocTag: 'T_EOF', okMarker: 'ok:', failMarker: 'fail:' });
    expect(shell[0]).toBe('cat > "${CIHUB_GUARD_UNIT_DIR:-/etc/systemd/system}/test-guard.service" <<\'T_EOF\'');
    expect(shell).toContain('systemctl enable test-guard.service >/dev/null 2>&1');
    expect(shell).toContain('systemctl restart test-guard.service');
    const verify = shell[shell.length - 1] as string;
    expect(verify).toContain('iptables -C INPUT -p tcp --dport 4242 -j TEST_GUARD');
    expect(verify).toContain('echo "ok: test-guard.service active');
    expect(verify).toContain('echo "fail: test-guard.service did not install its INPUT jump');
    expect(verify).toContain('exit 1');
  });

  it('removes only if present, and says so only when it did', () => {
    const shell = guardRemoveShell(spec, { marker: 'gone:' });
    expect(shell[0]).toBe('if [ -f "${CIHUB_GUARD_UNIT_DIR:-/etc/systemd/system}/test-guard.service" ]; then');
    expect(shell).toContain('  systemctl disable --now test-guard.service >/dev/null 2>&1 || true');
    expect(shell.some((l) => l.includes('gone: test-guard.service removed'))).toBe(true);
    expect(shell[shell.length - 1]).toBe('fi');
  });
});

describe('isGuardChainEffective', () => {
  const dump = [
    '-N TEST_GUARD',
    '-A TEST_GUARD -i lo -p tcp -m tcp --dport 4242 -j ACCEPT',
    '-A TEST_GUARD -i tailscale0 -p tcp -m tcp --dport 4242 -j ACCEPT',
    '-A TEST_GUARD -p tcp -m tcp --dport 4242 -j REJECT --reject-with tcp-reset',
  ].join('\n');

  it('needs the jump, every accept, and the reject', () => {
    expect(isGuardChainEffective(spec, dump, true)).toBe(true);
    expect(isGuardChainEffective(spec, dump, false)).toBe(false);
    expect(isGuardChainEffective(spec, dump.replace(/-i tailscale0[^\n]*\n/, ''), true)).toBe(false);
    expect(isGuardChainEffective(spec, dump.replace(/-j REJECT[^\n]*/, ''), true)).toBe(false);
  });
});

describe('OLLAMA_PORT_GUARD', () => {
  it("admits loopback, the tailnet, and both kinds of Docker bridge — br-+ is iptables' wildcard for compose networks", () => {
    expect(OLLAMA_PORT_GUARD.port).toBe(11434);
    expect(OLLAMA_PORT_GUARD.acceptInterfaces).toEqual(['lo', 'tailscale0', 'docker0', 'br-+']);
    expect(guardRules(OLLAMA_PORT_GUARD, 'iptables')).toContain('iptables -A OLLAMA_TAILNET_GUARD -i br-+ -p tcp --dport 11434 -j ACCEPT');
  });

  it('is ordered before ollama.service, so the daemon never listens on 0.0.0.0 unguarded', () => {
    expect(guardUnitText(OLLAMA_PORT_GUARD)).toContain('Before=network.target ollama.service');
  });
});
