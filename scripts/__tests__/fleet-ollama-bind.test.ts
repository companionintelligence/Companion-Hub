/**
 * Where Ollama listens: the merge order, the one file, and who owns the port.
 *
 * Every filename in these fixtures was seen on the fleet on 2026-09-10. The cases encode three
 * measured failures: `zzzz-bind-all.conf` outranking `zzz-tailnet-bind.conf` on beta-red, so the
 * node bound everywhere while the tailnet drop-in "was there"; `10-tailnet-bind.conf` losing to
 * `override.conf` because `o` sorts after `1`; and beta-1 serving from a user-scope
 * `ollama-local.service` with the system unit disabled, where `systemctl enable --now ollama` starts
 * a second daemon that collides on the port.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessOllamaBind,
  BIND_MARKERS,
  bindAddressFor,
  CANONICAL_BIND_DROPIN,
  canonicalBindDropinContent,
  classifyBindAddress,
  classifyBindApplyOutput,
  decideSystemUnitOwnership,
  type DropinFile,
  KNOWN_LEGACY_BIND_DROPINS,
  normalizeOllamaHost,
  ollamaBindApplyShell,
  ollamaBindProbeScript,
  ollamaOwnershipGuardShell,
  parseOllamaBindProbe,
  parseSsListeners,
  parseServiceEnvironment,
  parseShowEnvironment,
  planBindConsolidation,
  resolveEnvironmentKey,
  resolveOllamaBind,
  systemdDropinOrder,
  systemdNameCompare,
  verifyEffectiveBind,
} from '../lib/fleet-ollama-bind.js';
import { OLLAMA_PORT_GUARD } from '../lib/fleet-port-guard.js';

const file = (name: string, ...envLines: string[]): DropinFile => ({
  name,
  content: ['[Service]', ...envLines].join('\n'),
});
const host = (value: string) => `Environment="OLLAMA_HOST=${value}"`;

// ─── Merge order ─────────────────────────────────────────────────────────────

describe('systemd drop-in order', () => {
  it('is byte order, so digits sort before letters and zzzz beats zzz', () => {
    const { applied } = systemdDropinOrder([
      'zzzz-bind-all.conf',
      'override.conf',
      '10-tailnet-bind.conf',
      'zzz-tailnet-bind.conf',
      'zz-ci-ollama-context.conf',
      'companionhub.conf',
    ]);
    expect(applied).toEqual([
      '10-tailnet-bind.conf',
      'companionhub.conf',
      'override.conf',
      'zz-ci-ollama-context.conf',
      'zzz-tailnet-bind.conf',
      'zzzz-bind-all.conf',
    ]);
  });

  it('reads only *.conf — the .bak-preclaude copy is furniture', () => {
    const { applied, ignored } = systemdDropinOrder([
      'zzz-tailnet-bind.conf.bak-preclaude',
      'zzz-tailnet-bind.conf',
      'override.conf.disabled-by-cihub-2026-09-10',
    ]);
    expect(applied).toEqual(['zzz-tailnet-bind.conf']);
    expect(ignored).toEqual(['override.conf.disabled-by-cihub-2026-09-10', 'zzz-tailnet-bind.conf.bak-preclaude']);
  });

  it('places the canonical file after every name seen on the fleet', () => {
    for (const legacy of KNOWN_LEGACY_BIND_DROPINS) {
      expect(systemdNameCompare(CANONICAL_BIND_DROPIN, legacy), `${CANONICAL_BIND_DROPIN} must sort after ${legacy}`).toBe(1);
    }
    // And after any future zzzz-<anything>.conf, because `z` sorts after `-`.
    expect(systemdNameCompare(CANONICAL_BIND_DROPIN, 'zzzz-tailnet-bind.conf')).toBe(1);
  });

  it('would NOT be won by the numeric-prefix convention', () => {
    // 90-cihub-bind.conf reads as "high priority" and loses to override.conf — the exact hazard the
    // fleet notes record for 10-tailnet-bind.conf. This test is the reason the name has five z's.
    expect(systemdNameCompare('90-cihub-bind.conf', 'override.conf')).toBe(-1);
    expect(systemdNameCompare('90-cihub-bind.conf', 'zzzz-bind-all.conf')).toBe(-1);
  });
});

// ─── Parsing ─────────────────────────────────────────────────────────────────

describe('parseServiceEnvironment', () => {
  it('reads Environment= only under [Service], with quotes and several assignments per line', () => {
    const content = [
      '[Unit]',
      'Environment="OLLAMA_HOST=should-be-ignored"',
      '[Service]',
      '# comment',
      'Environment="OLLAMA_HOST=0.0.0.0:11434" OLLAMA_MODELS=/nvme/models',
      "Environment='OLLAMA_CONTEXT_LENGTH=16384'",
    ].join('\n');
    expect(parseServiceEnvironment(content)).toEqual([
      { kind: 'set', key: 'OLLAMA_HOST', value: '0.0.0.0:11434' },
      { kind: 'set', key: 'OLLAMA_MODELS', value: '/nvme/models' },
      { kind: 'set', key: 'OLLAMA_CONTEXT_LENGTH', value: '16384' },
    ]);
  });

  it('treats an empty Environment= as a clear and joins continued lines', () => {
    const content = ['[Service]', 'Environment=', 'Environment="A=1" \\', '  "B=2"'].join('\n');
    expect(parseServiceEnvironment(content)).toEqual([
      { kind: 'clear' },
      { kind: 'set', key: 'A', value: '1' },
      { kind: 'set', key: 'B', value: '2' },
    ]);
  });
});

// ─── Resolution ──────────────────────────────────────────────────────────────

describe('resolveOllamaBind', () => {
  it('beta-red: zzzz-bind-all.conf outranks zzz-tailnet-bind.conf by one z', () => {
    const files = [
      file('zzz-tailnet-bind.conf', host('100.99.1.2:11434')),
      file('zzzz-bind-all.conf', host('0.0.0.0')),
      { name: 'zzz-tailnet-bind.conf.bak-preclaude', content: host('100.99.1.2:11434') },
    ];
    const r = resolveOllamaBind(files);
    expect(r.effective.address).toBe('0.0.0.0:11434');
    expect(r.setBy).toBe('zzzz-bind-all.conf');
    expect(r.setters).toEqual(['zzz-tailnet-bind.conf', 'zzzz-bind-all.conf']);
    expect(r.conflict).toBe(true);
    expect(r.ignored).toEqual(['zzz-tailnet-bind.conf.bak-preclaude']);
    expect(r.bindClass).toBe('all');
  });

  it('override.conf beats 10-tailnet-bind.conf, whatever the number suggests', () => {
    const r = resolveOllamaBind([file('10-tailnet-bind.conf', host('100.99.1.2')), file('override.conf', host('0.0.0.0'))]);
    expect(r.setBy).toBe('override.conf');
    expect(r.effective.address).toBe('0.0.0.0:11434');
  });

  it('an empty Environment= in a later file wipes an earlier assignment', () => {
    const r = resolveOllamaBind([file('override.conf', host('0.0.0.0')), file('zz-reset.conf', 'Environment=')]);
    expect(r.defaulted).toBe(true);
    expect(r.effective.address).toBe('127.0.0.1:11434');
    expect(r.clearedBy).toEqual(['zz-reset.conf']);
    expect(r.setBy).toBeNull();
  });

  it('applies the unit file first, before every drop-in', () => {
    const unit = ['[Service]', 'Environment="PATH=/usr/bin"', host('127.0.0.1')].join('\n');
    const r = resolveOllamaBind([file('override.conf', host('0.0.0.0'))], unit);
    expect(r.order).toEqual(['(unit)', 'override.conf']);
    expect(r.setBy).toBe('override.conf');
  });

  it('is Ollama’s own default when nothing sets it', () => {
    const r = resolveOllamaBind([file('zz-ci-ollama-context.conf', 'Environment="OLLAMA_CONTEXT_LENGTH=16384"')]);
    expect(r.defaulted).toBe(true);
    expect(r.bindClass).toBe('local');
    expect(r.conflict).toBe(false);
  });

  it('a canonical file that wins over legacy setters is managed, not a conflict', () => {
    // The steady state on a CI-OS node: setup-fresh-ubuntu.sh re-creates override.conf every run.
    const r = resolveOllamaBind([file('override.conf', host('0.0.0.0')), file(CANONICAL_BIND_DROPIN, host('100.99.1.2:11434'))]);
    expect(r.canonicalWins).toBe(true);
    expect(r.conflict).toBe(false);
    expect(r.shadowed).toEqual(['override.conf']);
    expect(r.bindClass).toBe('tailnet');
  });

  it('flags a canonical file that is present but outranked', () => {
    const r = resolveOllamaBind([file(CANONICAL_BIND_DROPIN, host('100.99.1.2')), file('zzzzzz-later.conf', host('0.0.0.0'))]);
    expect(r.canonicalPresent).toBe(true);
    expect(r.canonicalWins).toBe(false);
    expect(r.conflict).toBe(true);
  });

  it('resolves any key, not just OLLAMA_HOST', () => {
    const r = resolveEnvironmentKey([file('a.conf', 'Environment="X=1"'), file('b.conf', 'UnsetEnvironment=X')], 'X');
    expect(r.value).toBeUndefined();
    expect(r.clearedBy).toEqual(['b.conf']);
  });
});

describe('addresses', () => {
  it('normalises every spelling OLLAMA_HOST accepts to host:port', () => {
    expect(normalizeOllamaHost('0.0.0.0').address).toBe('0.0.0.0:11434');
    expect(normalizeOllamaHost('http://0.0.0.0:11434/').address).toBe('0.0.0.0:11434');
    expect(normalizeOllamaHost('[::]:11434').address).toBe('[::]:11434');
    expect(normalizeOllamaHost(':11434').address).toBe('0.0.0.0:11434');
    expect(normalizeOllamaHost(undefined).address).toBe('127.0.0.1:11434');
    expect(normalizeOllamaHost('100.124.211.75:8080').port).toBe(8080);
  });

  it('classifies the three binds the fleet actually has', () => {
    expect(classifyBindAddress('0.0.0.0:11434')).toBe('all');
    expect(classifyBindAddress('[::]')).toBe('all');
    expect(classifyBindAddress('127.0.0.1')).toBe('local');
    expect(classifyBindAddress('100.124.211.75')).toBe('tailnet');
    expect(classifyBindAddress('100.200.1.1')).toBe('other'); // outside 100.64.0.0/10
    expect(classifyBindAddress('192.168.0.5')).toBe('other');
  });

  it('needs a tailnet address for the tailnet mode and refuses to invent one', () => {
    expect(bindAddressFor('tailnet', undefined)).toBeUndefined();
    expect(bindAddressFor('tailnet', '100.124.211.75')?.address).toBe('100.124.211.75:11434');
    expect(bindAddressFor('all')?.address).toBe('0.0.0.0:11434');
    expect(bindAddressFor('local')?.address).toBe('127.0.0.1:11434');
  });
});

// ─── Consolidation ───────────────────────────────────────────────────────────

describe('planBindConsolidation', () => {
  const target = normalizeOllamaHost('100.124.211.75');
  const opts = { date: '2026-09-10' };

  it('moves every single-purpose setter aside, keeps a mixed one, writes the canonical file', () => {
    const files = [
      file('override.conf', host('0.0.0.0')),
      file('zzz-tailnet-bind.conf', host('100.124.211.75:11434')),
      file('zzzz-bind-all.conf', host('0.0.0.0')),
      file('10-ci-models.conf', host('0.0.0.0'), 'Environment="OLLAMA_MODELS=/nvme/ollama"'),
      file('zz-ci-ollama-context.conf', 'Environment="OLLAMA_CONTEXT_LENGTH=16384"'),
      { name: 'zzz-tailnet-bind.conf.bak-preclaude', content: host('100.124.211.75') },
    ];
    const plan = planBindConsolidation(files, target, opts);
    expect(plan.disable.map((d) => d.name)).toEqual(['override.conf', 'zzz-tailnet-bind.conf', 'zzzz-bind-all.conf']);
    expect(plan.disable[0]?.to).toBe('override.conf.disabled-by-cihub-2026-09-10');
    // The NFS-hang repoint lives here; moving this file aside would put 77,622 restarts back.
    expect(plan.shadowed).toEqual([expect.objectContaining({ name: '10-ci-models.conf', extraKeys: ['OLLAMA_MODELS'] })]);
    expect(plan.unfixable).toEqual([]);
    expect(plan.ignored).toEqual(['zzz-tailnet-bind.conf.bak-preclaude']);
    expect(plan.canonical.action).toBe('write');
    expect(plan.canonical.path).toBe(`/etc/systemd/system/ollama.service.d/${CANONICAL_BIND_DROPIN}`);
    expect(plan.canonical.content).toContain('Environment="OLLAMA_HOST=100.124.211.75:11434"');
    expect(plan.noop).toBe(false);
    // The plan never contains a delete.
    expect(plan.summary.join('\n')).not.toMatch(/\brm\b|delete/);
  });

  it('is idempotent: applying the plan and planning again is a no-op', () => {
    const before = [file('override.conf', host('0.0.0.0')), file('zzz-tailnet-bind.conf', host('100.124.211.75'))];
    const first = planBindConsolidation(before, target, opts);
    // Simulate applying it.
    const after: DropinFile[] = [
      ...before.filter((f) => !first.disable.some((d) => d.name === f.name)),
      ...first.disable.map((d) => ({ name: d.to, content: before.find((f) => f.name === d.name)?.content ?? '' })),
      { name: CANONICAL_BIND_DROPIN, content: first.canonical.content },
    ];
    const second = planBindConsolidation(after, target, opts);
    expect(second.noop).toBe(true);
    expect(second.disable).toEqual([]);
    expect(second.canonical.action).toBe('unchanged');
    expect(resolveOllamaBind(after).setBy).toBe(CANONICAL_BIND_DROPIN);
  });

  it('retires the installer’s own companionhub.conf when the canonical file carries its other key', () => {
    const files = [file('companionhub.conf', host('0.0.0.0:11434'), 'Environment="OLLAMA_LLM_LIBRARY=vulkan"')];
    const withVulkan = planBindConsolidation(files, target, { ...opts, extraEnv: ['OLLAMA_LLM_LIBRARY=vulkan'] });
    expect(withVulkan.disable.map((d) => d.name)).toEqual(['companionhub.conf']);
    expect(withVulkan.canonical.content).toContain('OLLAMA_LLM_LIBRARY=vulkan');
    // Without vulkan in the canonical file, moving it aside would lose the setting: keep it.
    const without = planBindConsolidation(files, target, opts);
    expect(without.disable).toEqual([]);
    expect(without.shadowed[0]?.extraKeys).toEqual(['OLLAMA_LLM_LIBRARY']);
  });

  it('moves a single-purpose setter aside even when it sorts after the canonical file', () => {
    // Leaving it would let it win; moving it is the fix, and it is a move, not a delete.
    const plan = planBindConsolidation([file('zzzzzz-later.conf', host('0.0.0.0'))], target, opts);
    expect(plan.disable.map((d) => d.name)).toEqual(['zzzzzz-later.conf']);
    expect(plan.unfixable).toEqual([]);
  });

  it('cannot fix a MIXED file that sorts after the canonical one, and says so', () => {
    const plan = planBindConsolidation([file('zzzzzz-manual.conf', host('0.0.0.0'), 'Environment="OLLAMA_DEBUG=1"')], target, opts);
    expect(plan.disable).toEqual([]);
    expect(plan.unfixable).toEqual([expect.objectContaining({ name: 'zzzzzz-manual.conf' })]);
    expect(plan.unfixable[0]?.why).toContain('OLLAMA_DEBUG');
    expect(plan.summary.some((s) => s.startsWith('CANNOT FIX'))).toBe(true);
    // A clear that sorts after is equally unfixable by naming.
    const cleared = planBindConsolidation([file('zzzzzz-reset.conf', 'Environment=')], target, opts);
    expect(cleared.unfixable[0]?.why).toMatch(/clears the environment/);
  });

  it('rewrites the canonical file when the requested bind changed', () => {
    const existing = { name: CANONICAL_BIND_DROPIN, content: canonicalBindDropinContent(normalizeOllamaHost('0.0.0.0')) };
    const plan = planBindConsolidation([existing], target, opts);
    expect(plan.canonical.action).toBe('write');
    expect(plan.noop).toBe(false);
  });

  // The dry run on beta-max and core-1 (2026-09-11) listed the file moves and the write, and said
  // nothing about the guard the execute path then installed and reported. The plan is the
  // operator's preview of the shell, so it names the guard the way the shell handles it.
  it('names the guard: installed before the restart for `all`, removed for tailnet and local', () => {
    const files = [file('override.conf', host('0.0.0.0'))];
    const all = planBindConsolidation(files, normalizeOllamaHost('0.0.0.0'), opts);
    expect(all.guard).toEqual({ unit: OLLAMA_PORT_GUARD.unitName, action: 'install', active: undefined });
    const guardLine = `install ${OLLAMA_PORT_GUARD.unitName} (accept lo,tailscale0,docker0,br-+; reset elsewhere) before restarting`;
    expect(all.summary).toContain(guardLine);
    // In shell order: after the canonical write, since the guard must be up before the restart.
    expect(all.summary.indexOf(guardLine)).toBe(all.summary.findIndex((l) => l.startsWith(`write ${CANONICAL_BIND_DROPIN}`)) + 1);

    // The tailnet address and loopback: the two binds that do not want a guard.
    for (const narrower of [target, normalizeOllamaHost('127.0.0.1')]) {
      const plan = planBindConsolidation(files, narrower, opts);
      expect(plan.guard.action).toBe('remove');
      expect(plan.summary).toContain(`remove ${OLLAMA_PORT_GUARD.unitName} if present`);
      expect(plan.summary.join('\n')).not.toContain('install ollama-tailnet-guard');
    }
  });

  it('a managed 0.0.0.0 whose guard is down is not a no-op — the guard is the work', () => {
    const all = normalizeOllamaHost('0.0.0.0');
    const managed = [{ name: CANONICAL_BIND_DROPIN, content: canonicalBindDropinContent(all) }];
    // The files alone say nothing to do; the probe's guard reading says otherwise.
    expect(planBindConsolidation(managed, all, opts).noop).toBe(true);
    expect(planBindConsolidation(managed, all, { ...opts, guardUnit: 'unknown' }).noop).toBe(true);
    for (const down of ['inactive', 'failed']) {
      const plan = planBindConsolidation(managed, all, { ...opts, guardUnit: down });
      expect(plan.noop).toBe(false);
      expect(plan.canonical.action).toBe('unchanged');
      expect(plan.guard.active).toBe(false);
      expect(plan.summary).toContain(`${CANONICAL_BIND_DROPIN} already sets OLLAMA_HOST=0.0.0.0:11434`);
      expect(plan.summary.some((l) => l.startsWith(`install ${OLLAMA_PORT_GUARD.unitName}`) && !l.includes('already active'))).toBe(true);
    }
    const up = planBindConsolidation(managed, all, { ...opts, guardUnit: 'active' });
    expect(up.noop).toBe(true);
    expect(up.summary.some((l) => l.startsWith(`install ${OLLAMA_PORT_GUARD.unitName}`) && l.endsWith('— already active'))).toBe(true);

    // And the mirror image: a tailnet bind that is already right still has a guard to take down.
    const tailnetManaged = [{ name: CANONICAL_BIND_DROPIN, content: canonicalBindDropinContent(target) }];
    expect(planBindConsolidation(tailnetManaged, target, { ...opts, guardUnit: 'inactive' }).noop).toBe(true);
    const leftover = planBindConsolidation(tailnetManaged, target, { ...opts, guardUnit: 'active' });
    expect(leftover.noop).toBe(false);
    expect(leftover.summary).toContain(`remove ${OLLAMA_PORT_GUARD.unitName} (active now; this bind does not need it)`);
  });
});

// ─── Ownership ───────────────────────────────────────────────────────────────

const BETA1_SS = 'LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:* users:(("ollama",pid=2417,fd=3))';
const BETA1_OWNER = '2417 ci /user.slice/user-1000.slice/user@1000.service/app.slice/ollama-local.service';

describe('decideSystemUnitOwnership', () => {
  it('beta-1: refuses the system-unit path when a user-scope unit owns the port', () => {
    const d = decideSystemUnitOwnership({ ss: BETA1_SS, owners: [BETA1_OWNER] });
    expect(d.refuse).toBe(true);
    if (!d.refuse) throw new Error('unreachable');
    expect(d.reason).toMatch(/ollama-local\.service under ci's systemd --user \(pid 2417\)/);
    expect(d.reason).toMatch(/second daemon/);
    expect(d.reason.split('. ').length).toBeLessThanOrEqual(2); // one sentence, one line
    expect(d.owners[0]).toMatchObject({ pid: 2417, user: 'ci', scope: 'user-unit', unit: 'ollama-local.service', address: '0.0.0.0:11434' });
  });

  it('refuses from `systemctl --user -M ci@ status` output alone, when ss cannot disclose the pid', () => {
    const status = [
      '● ollama-local.service - Ollama (user scope)',
      '     Loaded: loaded (/home/ci/.config/systemd/user/ollama-local.service; enabled; preset: enabled)',
      '     Active: active (running) since Tue 2026-09-09 21:02:11 UTC; 1 day ago',
      '   Main PID: 2417 (ollama)',
    ].join('\n');
    const d = decideSystemUnitOwnership({ ss: 'LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:*', userUnits: [{ user: 'ci', text: status }] });
    expect(d.refuse).toBe(true);
    if (!d.refuse) throw new Error('unreachable');
    expect(d.reason).toMatch(/ollama-local\.service is running under ci's systemd --user/);
  });

  it('refuses from `systemctl --user -M ci@ show` output, and quotes the unit’s own OLLAMA_HOST', () => {
    const show = [
      'Id=ollama-local.service',
      'ActiveState=active',
      'MainPID=2417',
      'Environment=OLLAMA_HOST=0.0.0.0 OLLAMA_MODELS=/home/ci/.ollama',
    ].join('\n');
    const d = decideSystemUnitOwnership({ userUnits: [{ user: 'ci', text: show }] });
    expect(d.refuse).toBe(true);
    if (!d.refuse) throw new Error('unreachable');
    expect(d.reason).toContain('OLLAMA_HOST=0.0.0.0');
  });

  it('does not refuse an inactive user unit', () => {
    const d = decideSystemUnitOwnership({ userUnits: [{ user: 'ci', text: 'ollama-local.service loaded inactive dead Ollama' }] });
    expect(d.refuse).toBe(false);
  });

  it('allows the system unit when it is the system unit that owns the port', () => {
    const d = decideSystemUnitOwnership({
      ss: 'LISTEN 0 4096 100.124.211.75:11434 0.0.0.0:* users:(("ollama",pid=910,fd=3))',
      owners: ['910 ollama /system.slice/ollama.service'],
    });
    expect(d.refuse).toBe(false);
    expect(d.owners[0]?.scope).toBe('system-ollama');
  });

  it('allows an idle port', () => {
    expect(decideSystemUnitOwnership({ ss: '', owners: [] }).refuse).toBe(false);
  });

  it('refuses a container and another system unit, naming each', () => {
    const container = decideSystemUnitOwnership({
      ss: 'LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:* users:(("docker-proxy",pid=5,fd=4))',
      owners: ['5 root /system.slice/docker-1f2e3d.scope'],
    });
    expect(container.refuse).toBe(true);
    if (container.refuse) expect(container.reason).toMatch(/container/);
    const other = decideSystemUnitOwnership({ owners: ['77 root /system.slice/ollama-custom.service'] });
    expect(other.refuse).toBe(true);
    if (other.refuse) expect(other.reason).toMatch(/ollama-custom\.service/);
  });

  it('names a hand-started `ollama serve` in a login session for what it is', () => {
    const d = decideSystemUnitOwnership({ owners: ['4242 ci /user.slice/user-1000.slice/session-7.scope'] });
    expect(d.refuse).toBe(true);
    if (d.refuse) expect(d.reason).toMatch(/login session \(session-7\.scope/);
  });
});

// core-2, 2026-09-21, as the unprivileged probe sees it: the system unit runs as `ollama` (uid 997),
// so `ss -p` discloses no pid to `ci` — but `ss -e` prints the socket's cgroup for anyone. And a
// user-scope unit whose name matches `ollama*` is active: an ssh forward to beta-1, not a daemon.
const CORE2_SS = 'LISTEN 0 4096 *:11434 *:* uid:997 ino:81099226 sk:8006 cgroup:/system.slice/ollama.service v6only:0 <->';
const CORE2_TUNNEL = 'ollama-tunnel.service loaded active running SSH tunnel: core-2 localhost:11435 -> beta-1 Ollama :11434';
// beta-1 through the same `ss -e`: the pid is disclosed (the prober is the unit's user) and the
// socket's cgroup says user scope even where /proc could not be read.
const BETA1_SS_E =
  'LISTEN 0 4096 *:11434 *:* users:(("ollama",pid=941661,fd=3)) uid:1000 ino:133057448 sk:9003 cgroup:/user.slice/user-1000.slice/user@1000.service/app.slice/ollama-local.service v6only:0 <->';

describe('decideSystemUnitOwnership goes by the listener, not by a unit name', () => {
  it('core-2: a user-scope `ollama-tunnel.service` does not refuse when the system unit serves :11434', () => {
    const d = decideSystemUnitOwnership({ ss: CORE2_SS, userUnits: [{ user: 'ci', text: CORE2_TUNNEL }] });
    expect(d.refuse).toBe(false);
    if (d.refuse) throw new Error('unreachable');
    expect(d.owners[0]).toMatchObject({ scope: 'system-ollama', unit: 'ollama.service', uid: 997, pid: undefined });
    // The unit the operator can see is named, and told apart from the daemon.
    expect(d.note).toBe(
      "ollama-tunnel.service is active under ci's systemd --user, but the system ollama.service (uid 997) is what serves :11434 — that unit is not the daemon; managing the system unit",
    );
    expect(d.userUnits).toEqual([{ user: 'ci', unit: 'ollama-tunnel.service', active: true }]);
  });

  it('beta-1: the socket cgroup alone refuses, pid or no pid', () => {
    const withPid = decideSystemUnitOwnership({
      ss: BETA1_SS_E,
      userUids: { ci: 1000 },
      userUnits: [{ user: 'ci', text: 'ollama-local.service loaded active running Ollama local model server' }],
    });
    expect(withPid.refuse).toBe(true);
    if (withPid.refuse)
      expect(withPid.reason).toMatch(
        /^ollama-local\.service under ci's systemd --user \(pid 941661\) already owns :11434; enabling the system ollama\.service would start a second daemon/,
      );
    // Same socket, pid withheld (another user probing): still the user unit, by cgroup; the socket's
    // uid names the user when the probe dumped the login users, and reads `?` when it did not.
    const noPid = decideSystemUnitOwnership({ ss: BETA1_SS_E.replace(/users:\(\([^)]*\)\) /, ''), userUids: { ci: 1000 } });
    expect(noPid.refuse).toBe(true);
    if (noPid.refuse) expect(noPid.reason).toMatch(/^ollama-local\.service under ci's systemd --user \(socket uid 1000\) already owns :11434/);
    expect(noPid.owners[0]).toMatchObject({ scope: 'user-unit', unit: 'ollama-local.service', pid: undefined, uid: 1000, user: 'ci' });
    const nameless = decideSystemUnitOwnership({ ss: BETA1_SS_E.replace(/users:\(\([^)]*\)\) /, '') });
    if (nameless.refuse) expect(nameless.reason).toMatch(/^ollama-local\.service under \?'s systemd --user \(socket uid 1000\)/);
  });

  it('nothing listens: an active `ollama*` user unit refuses on its name, as it always did', () => {
    // beta-1 between `systemctl --user restart ollama-local` stopping the daemon and the new one
    // binding: the unit is active, the port is momentarily free, and the probe's `list-units` row
    // carries no OLLAMA_HOST to say whether this unit ever binds here. A free port is not proof the
    // unit is not the daemon — enabling the system unit now would collide a second later.
    const restarting = decideSystemUnitOwnership({
      ss: '',
      userUids: { ci: 1000 },
      userUnits: [{ user: 'ci', text: 'ollama-local.service loaded active running Ollama local model server' }],
    });
    expect(restarting.refuse).toBe(true);
    if (restarting.refuse)
      expect(restarting.reason).toBe(
        "ollama-local.service is running under ci's systemd --user; the system ollama.service path would start a second daemon and collide on :11434",
      );
    // The same shape on core-2 (tunnel unit, daemon stopped): the name refuses too — the probe
    // cannot tell the tunnel from a daemon mid-restart, and the system unit is not the listener.
    // A system unit that is active per systemd but holds no socket is not the listener either.
    const tunnelOnly = decideSystemUnitOwnership({
      ss: '',
      systemUnit: { active: true, mainPid: 5, uid: 997 },
      userUnits: [{ user: 'ci', text: CORE2_TUNNEL }],
    });
    expect(tunnelOnly.refuse).toBe(true);
    if (tunnelOnly.refuse)
      expect(tunnelOnly.reason).toMatch(/^ollama-tunnel\.service is running under ci's systemd --user; the system ollama\.service path/);
    // A `show` fixture that names another port is still the name: the probe never carries it, and
    // a hand-pasted one is quoted for the operator, not weighed.
    const elsewhere = ['Id=ollama-local.service', 'ActiveState=active', 'Environment=OLLAMA_HOST=127.0.0.1:11435'].join('\n');
    const shown = decideSystemUnitOwnership({ ss: '', userUnits: [{ user: 'ci', text: elsewhere }] });
    expect(shown.refuse).toBe(true);
    if (shown.refuse) expect(shown.reason).toContain('(OLLAMA_HOST=127.0.0.1:11435)');
  });

  it('without a socket cgroup (older iproute2), the system unit’s uid or main pid pins the listener', () => {
    const noCgroup = 'LISTEN 0 4096 *:11434 *:* uid:997 ino:81099226 sk:8006 v6only:0 <->';
    const byUid = decideSystemUnitOwnership({
      ss: noCgroup,
      systemUnit: { active: true, uid: 997 },
      userUnits: [{ user: 'ci', text: CORE2_TUNNEL }],
    });
    expect(byUid.refuse).toBe(false);
    if (!byUid.refuse) {
      expect(byUid.owners[0]?.scope).toBe('system-ollama');
      expect(byUid.note).toMatch(/the system ollama\.service \(uid 997\) is what serves :11434/);
    }
    const byPid = decideSystemUnitOwnership({
      ss: 'LISTEN 0 4096 *:11434 *:* users:(("ollama",pid=3522669,fd=3))',
      systemUnit: { active: true, mainPid: 3522669 },
      userUnits: [{ user: 'ci', text: CORE2_TUNNEL }],
    });
    expect(byPid.refuse).toBe(false);
    if (!byPid.refuse) expect(byPid.note).toMatch(/the system ollama\.service \(pid 3522669\) is what serves :11434/);
    // An inactive system unit pins nothing: `UID` there is stale or `[not set]`.
    const inactive = decideSystemUnitOwnership({
      ss: noCgroup,
      systemUnit: { active: false, uid: 997 },
      userUnits: [{ user: 'ci', text: CORE2_TUNNEL }],
    });
    expect(inactive.owners[0]?.scope).toBe('unknown');
  });

  it('with only the socket uid, a login user’s socket refuses — the unit’s own user or anyone else’s — and a system uid does not', () => {
    const noCgroup = (uid: number) => `LISTEN 0 4096 *:11434 *:* uid:${uid} ino:1 sk:1 v6only:0 <->`;
    const theirs = decideSystemUnitOwnership({ ss: noCgroup(1001), userUids: { ci: 1001 }, userUnits: [{ user: 'ci', text: CORE2_TUNNEL }] });
    expect(theirs.refuse).toBe(true);
    if (theirs.refuse)
      expect(theirs.reason).toBe(
        "ollama-tunnel.service is running under ci's systemd --user; the system ollama.service path would start a second daemon and collide on :11434",
      );
    // Another login user's socket: a hand-started `ollama serve` in bob's session, or bob's own
    // unit that `-M bob@` could not list. Not the tunnel's, but not the system unit's either — and
    // the tunnel's user was not the only login user to compare against.
    const someoneElses = decideSystemUnitOwnership({
      ss: noCgroup(1002),
      userUids: { ci: 1001, bob: 1002 },
      userUnits: [{ user: 'ci', text: CORE2_TUNNEL }],
    });
    expect(someoneElses.refuse).toBe(true);
    if (someoneElses.refuse)
      expect(someoneElses.reason).toBe(
        "ollama-tunnel.service is running under ci's systemd --user and :11434 is held by bob's uid 1002; the system ollama.service path would start a second daemon and collide on :11434",
      );
    // Two users with active `ollama*` units and the socket is the SECOND one's: still refused.
    const secondUnit = decideSystemUnitOwnership({
      ss: noCgroup(1002),
      userUids: { ci: 1001, bob: 1002 },
      userUnits: [
        { user: 'ci', text: CORE2_TUNNEL },
        { user: 'bob', text: 'ollama-local.service loaded active running Ollama local model server' },
      ],
    });
    expect(secondUnit.refuse).toBe(true);
    if (secondUnit.refuse) expect(secondUnit.reason).toContain("held by bob's uid 1002");
    // A uid that is no login user's cannot be the unit's, nor anyone's shell: the system unit is managed.
    const notTheirs = decideSystemUnitOwnership({
      ss: noCgroup(997),
      userUids: { ci: 1001, bob: 1002 },
      userUnits: [{ user: 'ci', text: CORE2_TUNNEL }],
    });
    expect(notTheirs.refuse).toBe(false);
    if (!notTheirs.refuse)
      expect(notTheirs.note).toBe(
        "ollama-tunnel.service is active under ci's systemd --user, but :11434 is held by uid 997, which is no login user's (ci is 1001) — that unit is not the listener; managing the system unit",
      );
    // The unit's own user missing from the dump: nothing proves the socket is not theirs.
    const unlisted = decideSystemUnitOwnership({ ss: noCgroup(997), userUids: { bob: 1002 }, userUnits: [{ user: 'ci', text: CORE2_TUNNEL }] });
    expect(unlisted.refuse).toBe(true);
    // No uid to compare either: the listener may well be the unit's, and the old refusal stands.
    const blind = decideSystemUnitOwnership({ ss: 'LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:*', userUnits: [{ user: 'ci', text: CORE2_TUNNEL }] });
    expect(blind.refuse).toBe(true);
    if (blind.refuse)
      expect(blind.reason).toMatch(
        /ollama-tunnel\.service is running under ci's systemd --user; the system ollama\.service path would start a second daemon/,
      );
  });

  it('a bare `cgroup:/` on the socket is no cgroup: the /proc line classifies it, and without one it is unseen', () => {
    // The root cgroup, as `ss -e` prints it for a socket in a namespace whose root is the
    // listener's cgroup. Not a foreign unit; not proof of anything.
    const rootCgroup = 'LISTEN 0 4096 *:11434 *:* users:(("ollama",pid=910,fd=3)) uid:997 ino:1 sk:1 cgroup:/ v6only:0 <->';
    expect(parseSsListeners(rootCgroup)[0]).toMatchObject({ pid: 910, uid: 997, cgroup: undefined, scope: 'unknown' });
    const byProc = decideSystemUnitOwnership({
      ss: rootCgroup,
      owners: ['910 ollama /system.slice/ollama.service'],
      userUnits: [{ user: 'ci', text: CORE2_TUNNEL }],
    });
    expect(byProc.refuse).toBe(false);
    expect(byProc.owners[0]).toMatchObject({ pid: 910, scope: 'system-ollama', unit: 'ollama.service' });
    if (!byProc.refuse) expect(byProc.note).toMatch(/the system ollama\.service \(pid 910\) is what serves :11434/);
    // /proc says the root cgroup too (cgroup v1, a container's init): still nobody the probe can name.
    const rootEverywhere = decideSystemUnitOwnership({ ss: rootCgroup, owners: ['910 ollama /'], userUnits: [{ user: 'ci', text: CORE2_TUNNEL }] });
    expect(rootEverywhere.owners[0]).toMatchObject({ pid: 910, cgroup: undefined, scope: 'unknown' });
    expect(rootEverywhere.refuse).toBe(true);
    if (rootEverywhere.refuse) expect(rootEverywhere.reason).toMatch(/^ollama-tunnel\.service is running under ci's systemd --user;/);
  });

  it('no note when there is no user unit to explain', () => {
    const d = decideSystemUnitOwnership({ ss: CORE2_SS });
    expect(d.refuse).toBe(false);
    if (!d.refuse) expect(d.note).toBeUndefined();
  });
});

describe('parseSsListeners', () => {
  it('reads the uid and cgroup `ss -e` prints, and classifies by the cgroup', () => {
    expect(parseSsListeners(CORE2_SS)).toEqual([
      {
        address: '*:11434',
        process: undefined,
        pid: undefined,
        uid: 997,
        cgroup: '/system.slice/ollama.service',
        scope: 'system-ollama',
        unit: 'ollama.service',
      },
    ]);
    expect(parseSsListeners(BETA1_SS_E)[0]).toMatchObject({
      pid: 941661,
      process: 'ollama',
      uid: 1000,
      scope: 'user-unit',
      unit: 'ollama-local.service',
    });
    // Plain `ss -ltnp`: nothing to classify by.
    expect(parseSsListeners(BETA1_SS)[0]).toMatchObject({ pid: 2417, uid: undefined, cgroup: undefined, scope: 'unknown' });
    // Another cgroup namespace: `cgroup:unreachable:<id>` is not a path and names no unit.
    expect(parseSsListeners('LISTEN 0 4096 *:11434 *:* uid:997 ino:1 sk:1 cgroup:unreachable:00000000000000001 v6only:0 <->')[0]).toMatchObject({
      uid: 997,
      cgroup: undefined,
      scope: 'unknown',
    });
  });
});

// ─── Reading back ────────────────────────────────────────────────────────────

describe('verifyEffectiveBind', () => {
  it('passes when systemd resolved the requested bind, whatever the spelling', () => {
    const v = verifyEffectiveBind('Environment=PATH=/usr/bin OLLAMA_HOST=0.0.0.0', normalizeOllamaHost('0.0.0.0:11434'));
    expect(v.ok).toBe(true);
    expect(v.effective?.address).toBe('0.0.0.0:11434');
  });

  it('fails, naming both values and the merge order, when a later drop-in won', () => {
    const v = verifyEffectiveBind(
      'Environment=OLLAMA_HOST=0.0.0.0 PATH=/usr/bin',
      normalizeOllamaHost('100.124.211.75'),
      '/etc/systemd/system/ollama.service.d/zzzzz-cihub-bind.conf /etc/systemd/system/ollama.service.d/zzzzzz-manual.conf',
    );
    expect(v.ok).toBe(false);
    expect(v.why).toContain('requested OLLAMA_HOST=100.124.211.75:11434');
    expect(v.why).toContain('resolved 0.0.0.0:11434');
    expect(v.why).toContain('zzzzzz-manual.conf');
  });

  it('fails when nothing resolved at all', () => {
    const v = verifyEffectiveBind('Environment=PATH=/usr/bin', normalizeOllamaHost('0.0.0.0'));
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/no OLLAMA_HOST at all/);
  });

  it('reads OLLAMA_HOST even when it is the first variable in the merged list', () => {
    // `tr ' ' '\n' | sed -n 's/^OLLAMA_HOST=//p'` misses this case: the first token is glued to
    // `Environment=`. The parser here, and the shell in the apply script, both strip that first.
    expect(parseShowEnvironment('Environment=OLLAMA_HOST=100.1.2.3:11434 "OLLAMA_ORIGINS=a b"')).toEqual({
      OLLAMA_HOST: '100.1.2.3:11434',
      OLLAMA_ORIGINS: 'a b',
    });
  });
});

// ─── Probe → assessment ──────────────────────────────────────────────────────

const probeOutput = (parts: {
  show?: string[];
  ss?: string[];
  owners?: string[];
  userUnits?: string[];
  userUids?: string[];
  entries?: string[];
  files?: DropinFile[];
  unit?: string;
  ts?: string;
  guard?: string;
}) =>
  [
    'bind_probe=1',
    `unit_file=${parts.unit ?? '/etc/systemd/system/ollama.service'}`,
    ...(parts.show ?? []).map((l) => `show:${l}`),
    `tailscale_ip=${parts.ts ?? '100.124.211.75'}`,
    ...(parts.guard ? [`guard_unit=${parts.guard}`] : []),
    ...(parts.ss ?? []).map((l) => `ss=${l}`),
    ...(parts.owners ?? []).map((l) => `owner=${l}`),
    ...(parts.userUnits ?? []).map((l) => `user_unit=${l}`),
    ...(parts.userUids ?? []).map((l) => `user_uid=${l}`),
    ...(parts.entries ?? []).map((l) => `dir_entry=${l}`),
    ...(parts.files ?? []).flatMap((f) => [`===DROPIN /etc/systemd/system/ollama.service.d/${f.name}===`, f.content, '', '===END===']),
  ].join('\n');

describe('assessOllamaBind', () => {
  it('a 0.0.0.0 bind with no active guard is EXPOSED — that flag comes first, in the cell', () => {
    const out = probeOutput({
      show: ['ActiveState=active', 'UnitFileState=enabled', 'NeedDaemonReload=no', 'Environment=OLLAMA_HOST=0.0.0.0:11434'],
      ss: ['LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:*'],
      entries: ['zzzzz-cihub-bind.conf'],
      files: [file('zzzzz-cihub-bind.conf', host('0.0.0.0:11434'))],
      guard: 'inactive',
    });
    const a = assessOllamaBind(parseOllamaBindProbe(out));
    expect(a.guard.unit).toBe('inactive');
    expect(a.exposed).toBe(true);
    expect(a.summary).toContain('EXPOSED — no guard');
  });

  it('the same bind behind an active guard is not exposed, and says guarded', () => {
    const out = probeOutput({
      show: ['ActiveState=active', 'UnitFileState=enabled', 'NeedDaemonReload=no', 'Environment=OLLAMA_HOST=0.0.0.0:11434'],
      ss: ['LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:*'],
      entries: ['zzzzz-cihub-bind.conf'],
      files: [file('zzzzz-cihub-bind.conf', host('0.0.0.0:11434'))],
      guard: 'active',
    });
    const a = assessOllamaBind(parseOllamaBindProbe(out));
    expect(a.exposed).toBe(false);
    expect(a.summary).toContain('guarded');
    expect(a.summary).not.toContain('EXPOSED');
  });

  it('a tailnet or loopback bind is never "exposed", guard or no guard', () => {
    const out = probeOutput({
      show: ['ActiveState=active', 'UnitFileState=enabled', 'NeedDaemonReload=no', 'Environment=OLLAMA_HOST=100.124.211.75:11434'],
      entries: ['zzzzz-cihub-bind.conf'],
      files: [file('zzzzz-cihub-bind.conf', host('100.124.211.75:11434'))],
      guard: 'inactive',
    });
    expect(assessOllamaBind(parseOllamaBindProbe(out)).exposed).toBe(false);
  });

  it('beta-red: names the winner and flags the conflict, read-only', () => {
    const out = probeOutput({
      show: ['ActiveState=active', 'UnitFileState=enabled', 'NeedDaemonReload=no', 'Environment=PATH=/usr/bin OLLAMA_HOST=0.0.0.0'],
      ss: ['LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:*'],
      entries: ['zzz-tailnet-bind.conf', 'zzz-tailnet-bind.conf.bak-preclaude', 'zzzz-bind-all.conf'],
      files: [file('zzz-tailnet-bind.conf', host('100.124.211.75:11434')), file('zzzz-bind-all.conf', host('0.0.0.0'))],
    });
    const a = assessOllamaBind(parseOllamaBindProbe(out));
    expect(a.status).toBe('conflict');
    expect(a.summary).toContain('0.0.0.0:11434 ← zzzz-bind-all.conf');
    expect(a.summary).toContain('CONFLICT');
    expect(a.summary).toContain('zzz-tailnet-bind.conf < zzzz-bind-all.conf');
    expect(a.liveMatchesFiles).toBe(true);
    expect(a.resolution.ignored).toEqual(['zzz-tailnet-bind.conf.bak-preclaude']);
  });

  it('beta-1: reports the user-scope owner and the dead system unit', () => {
    const out = probeOutput({
      show: ['ActiveState=inactive', 'UnitFileState=disabled', 'NeedDaemonReload=no', 'Environment=OLLAMA_HOST=0.0.0.0:11434'],
      ss: [BETA1_SS],
      owners: [BETA1_OWNER],
      userUnits: ['ci ollama-local.service loaded active running Ollama'],
      files: [file('override.conf', host('0.0.0.0:11434'))],
    });
    const a = assessOllamaBind(parseOllamaBindProbe(out));
    expect(a.status).toBe('user-scope');
    expect(a.ownership.refuse).toBe(true);
    expect(a.summary).toContain('user-scope ollama-local.service (ci)');
    expect(a.summary).toContain('system unit inactive/disabled');
  });

  it('core-2: a user-scope `ollama-tunnel.service` beside a serving system unit reads as managed, and the unit is named', () => {
    // The unprivileged probe's actual dump on 2026-09-21: no `owner=` line (ss withheld the pid),
    // the socket's cgroup on the ss line, the system unit active as uid 997, the tunnel unit active.
    const out = probeOutput({
      show: [
        'ActiveState=active',
        'UnitFileState=enabled',
        'MainPID=3522669',
        'UID=997',
        'NeedDaemonReload=no',
        'Environment=OLLAMA_HOST=0.0.0.0:11434',
      ],
      ss: [CORE2_SS],
      userUnits: [`ci ${CORE2_TUNNEL}`],
      userUids: ['ci 1001'],
      guard: 'active',
      files: [file(CANONICAL_BIND_DROPIN, host('0.0.0.0:11434'))],
    });
    const probe = parseOllamaBindProbe(out);
    expect(probe.userUids).toEqual({ ci: 1001 });
    expect(probe.show.UID).toBe('997');
    const a = assessOllamaBind(probe);
    expect(a.status).toBe('managed');
    expect(a.ownership.refuse).toBe(false);
    if (!a.ownership.refuse)
      expect(a.ownership.note).toMatch(
        /ollama-tunnel\.service is active under ci's systemd --user, but the system ollama\.service \(uid 997\) is what serves :11434/,
      );
    expect(a.summary).toBe(`0.0.0.0:11434 ← ${CANONICAL_BIND_DROPIN}  [guarded; ollama-tunnel.service (ci) is not the listener]`);
  });

  it('the probe asks `ss -e` for the socket cgroup and uid, and dumps the uids it can compare them to', () => {
    const script = ollamaBindProbeScript();
    expect(script).toContain('ss -ltnpe');
    expect(script).toContain('-p UID');
    expect(script).toContain('echo "user_uid=$me $(id -u 2>/dev/null)"');
    expect(script).toContain('echo "user_uid=$u $uid"');
  });

  it('a managed node reads back as managed, with shadowed legacy files listed', () => {
    const out = probeOutput({
      show: ['ActiveState=active', 'UnitFileState=enabled', 'NeedDaemonReload=no', 'Environment=OLLAMA_HOST=100.124.211.75:11434 PATH=/usr/bin'],
      ss: ['LISTEN 0 4096 100.124.211.75:11434 0.0.0.0:*'],
      files: [file('override.conf', host('0.0.0.0')), file(CANONICAL_BIND_DROPIN, host('100.124.211.75:11434'))],
    });
    const a = assessOllamaBind(parseOllamaBindProbe(out));
    expect(a.status).toBe('managed');
    expect(a.summary).toBe(`100.124.211.75:11434 ← ${CANONICAL_BIND_DROPIN}  [shadows override.conf]`);
  });

  it('says when the files and the loaded unit disagree', () => {
    const out = probeOutput({
      show: ['ActiveState=active', 'UnitFileState=enabled', 'NeedDaemonReload=yes', 'Environment=OLLAMA_HOST=0.0.0.0'],
      files: [file(CANONICAL_BIND_DROPIN, host('100.124.211.75:11434'))],
    });
    const a = assessOllamaBind(parseOllamaBindProbe(out));
    expect(a.needDaemonReload).toBe(true);
    expect(a.liveMatchesFiles).toBe(false);
    expect(a.summary).toContain('reload pending');
  });

  it('distinguishes no unit, default bind, and an unmanaged single setter', () => {
    expect(assessOllamaBind(parseOllamaBindProbe(probeOutput({ unit: 'none' }))).status).toBe('no-unit');
    const dflt = assessOllamaBind(parseOllamaBindProbe(probeOutput({ show: ['Environment=PATH=/usr/bin'] })));
    expect(dflt.status).toBe('default');
    expect(dflt.summary).toContain('127.0.0.1:11434 default');
    const single = assessOllamaBind(
      parseOllamaBindProbe(probeOutput({ show: ['Environment=OLLAMA_HOST=0.0.0.0'], files: [file('override.conf', host('0.0.0.0'))] })),
    );
    expect(single.status).toBe('unmanaged');
    expect(single.summary).toContain('unmanaged');
  });

  it('reports a probe that never ran as not probed, rather than as a default bind', () => {
    const a = assessOllamaBind(parseOllamaBindProbe('bash: line 1: ss: command not found'));
    expect(a.status).toBe('unknown');
    expect(a.summary).toBe('not probed');
  });

  it('the probe script only reads', () => {
    const script = ollamaBindProbeScript();
    expect(script).not.toMatch(/\b(mv|rm|cat >|tee|systemctl (restart|enable|start|stop|daemon-reload))\b/);
    expect(script).toContain('systemctl show ollama');
    expect(script).toContain('tailscale ip -4');
    expect(script).toContain('systemctl --user -M "$u@" list-units');
  });
});

// ─── The apply shell ─────────────────────────────────────────────────────────

describe('ollamaBindApplyShell (static)', () => {
  it('refuses to fall back when tailnet is requested and the node has no tailnet address', () => {
    const script = ollamaBindApplyShell('tailnet');
    expect(script).toContain('tailscale ip -4');
    expect(script).toMatch(/ollama-bind-failed: --bind tailnet needs a tailnet address/);
    expect(script).not.toContain("cihub_bind_host='0.0.0.0'");
  });

  it('writes the canonical file only, and re-reads systemctl show after the restart', () => {
    const script = ollamaBindApplyShell('all', { extraEnv: ['OLLAMA_LLM_LIBRARY=vulkan'] });
    expect(script).toContain(`cihub_bind_file='${CANONICAL_BIND_DROPIN}'`);
    expect(script).not.toContain('companionhub.conf');
    expect(script).toContain('Environment="OLLAMA_LLM_LIBRARY=vulkan"');
    expect(script.indexOf('systemctl restart ollama')).toBeLessThan(script.indexOf('systemctl show ollama -p Environment'));
    expect(script).toContain('ollama-bind-mismatch:');
    expect(script).not.toMatch(/\brm -f?\b/);
  });

  it('the ownership guard runs before anything is written and exits without a failure code', () => {
    const guard = ollamaOwnershipGuardShell();
    expect(guard).toContain('/proc/$pid/cgroup');
    expect(guard).toContain('systemctl --user -M "$u@" list-units');
    expect(guard).toMatch(/ollama-bind-refused: .*exit 0/);
  });
});

describe('classifyBindApplyOutput', () => {
  it('keys the outcome on markers, not exit codes', () => {
    expect(
      classifyBindApplyOutput("ollama-bind-refused: ollama-local.service under ci's systemd --user (pid 1) already owns :11434", '').outcome,
    ).toBe('refused');
    expect(classifyBindApplyOutput('', 'ollama-bind-mismatch: requested OLLAMA_HOST=100.1.1.1:11434 but systemd resolved 0.0.0.0').outcome).toBe(
      'mismatch',
    );
    expect(classifyBindApplyOutput('', 'ollama-bind-failed: --bind tailnet needs a tailnet address').outcome).toBe('failed');
    const ok = classifyBindApplyOutput(
      'ollama-bind-disabled: override.conf → override.conf.disabled-by-cihub-2026-09-10\nollama-bind-effective: OLLAMA_HOST=0.0.0.0:11434 listening=0.0.0.0:11434\nollama-bind-complete',
      '',
    );
    expect(ok.outcome).toBe('applied');
    expect(ok.why).toContain('OLLAMA_HOST=0.0.0.0:11434');
    expect(ok.detail).toHaveLength(1);
    expect(classifyBindApplyOutput('installing…', '').outcome).toBe('incomplete');
  });
});

/**
 * Run the real apply shell in a sandbox: a temp drop-in directory and stub `systemctl`, `ss`,
 * `tailscale` on PATH. This is the only place the shell's own legacy-file logic is exercised, and it
 * is where "the post-restart check fails on a mismatch" is proven rather than asserted about a string.
 */
const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p));
const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
describe.skipIf(!bash)('ollamaBindApplyShell (sandboxed bash)', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function sandbox(stubs: { ollamaHostAfterRestart: string; tailscaleIp?: string }) {
    const root = mkdtempSync(path.join(tmpdir(), 'cihub-bind-'));
    sandboxes.push(root);
    const bin = path.join(root, 'bin');
    const dropins = path.join(root, 'ollama.service.d');
    mkdirSync(bin);
    mkdirSync(dropins);
    const log = path.join(root, 'calls.log');
    const stub = (name: string, body: string) => {
      const p = path.join(bin, name);
      writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
      chmodSync(p, 0o755);
    };
    // The stub resolves what "systemd" would: whatever the sandbox was told the merged value is.
    stub(
      'systemctl',
      [
        'case "$*" in',
        `  *"-p Environment"*) echo "Environment=OLLAMA_HOST=${stubs.ollamaHostAfterRestart} PATH=/usr/bin" ;;`,
        `  *"-p DropInPaths"*) ls "${dropins}"/*.conf 2>/dev/null | tr '\\n' ' ' ;;`,
        'esac',
      ].join('\n'),
    );
    stub('tailscale', `[ "$1 $2" = "ip -4" ] && printf '%s\\n' '${stubs.tailscaleIp ?? ''}'`);
    stub('ss', 'echo "LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:*"');
    stub('sleep', ':');
    // The guard's install proves its INPUT jump with `iptables -C`; the sandbox answers yes.
    stub('iptables', ':');
    const units = path.join(root, 'systemd-units');
    mkdirSync(units);
    return { root, bin, dropins, units, log };
  }

  function run(script: string, box: { bin: string; dropins: string; units: string }) {
    return spawnSync(bash as string, ['-e', '-c', script], {
      env: { PATH: `${box.bin}:/usr/bin:/bin`, CIHUB_BIND_DIR: box.dropins, CIHUB_GUARD_UNIT_DIR: box.units, HOME: '/tmp' },
      encoding: 'utf-8',
    });
  }

  it('a tailnet bind removes the guard an earlier `all` left behind, so switching modes is coherent', () => {
    const box = sandbox({ ollamaHostAfterRestart: '100.1.1.1:11434', tailscaleIp: '100.1.1.1' });
    writeFileSync(path.join(box.units, 'ollama-tailnet-guard.service'), '[Unit]\nDescription=stale\n');
    const res = run(ollamaBindApplyShell('tailnet'), box);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(path.join(box.units, 'ollama-tailnet-guard.service'))).toBe(false);
    const outcome = classifyBindApplyOutput(res.stdout, res.stderr);
    expect(outcome.outcome).toBe('applied');
    expect(outcome.detail).toContain('ollama-bind-unguarded: ollama-tailnet-guard.service removed (the bind no longer needs it)');
    expect(readFileSync(box.log, 'utf-8')).toContain('systemctl disable --now ollama-tailnet-guard.service');
  });

  it('moves single-purpose setters aside, keeps a mixed one, writes the canonical file, verifies', () => {
    const box = sandbox({ ollamaHostAfterRestart: '0.0.0.0:11434' });
    writeFileSync(path.join(box.dropins, 'override.conf'), `[Service]\n${host('0.0.0.0')}\n`);
    writeFileSync(path.join(box.dropins, 'zzz-tailnet-bind.conf'), `[Service]\n${host('100.1.1.1:11434')}\n`);
    writeFileSync(path.join(box.dropins, '10-ci-models.conf'), `[Service]\n${host('0.0.0.0')}\nEnvironment="OLLAMA_MODELS=/nvme"\n`);
    writeFileSync(path.join(box.dropins, 'zz-ci-ollama-context.conf'), '[Service]\nEnvironment="OLLAMA_CONTEXT_LENGTH=16384"\n');
    writeFileSync(path.join(box.dropins, 'zzz-tailnet-bind.conf.bak-preclaude'), `[Service]\n${host('100.1.1.1')}\n`);

    const res = run(ollamaBindApplyShell('all'), box);
    expect(res.status, res.stderr).toBe(0);
    const outcome = classifyBindApplyOutput(res.stdout, res.stderr);
    expect(outcome.outcome).toBe('applied');
    // The shell stamps the LOCAL date, as `date +%Y-%m-%d` does on the node.
    const stamp = localDate();
    expect([...outcome.detail].sort()).toEqual(
      [
        `ollama-bind-disabled: override.conf → override.conf.disabled-by-cihub-${stamp}`,
        `ollama-bind-disabled: zzz-tailnet-bind.conf → zzz-tailnet-bind.conf.disabled-by-cihub-${stamp}`,
        'ollama-bind-shadowed: 10-ci-models.conf also sets OLLAMA_MODELS — left in place, outranked by zzzzz-cihub-bind.conf',
        'ollama-bind-guarded: ollama-tailnet-guard.service active; tcp/11434 accepted from lo,tailscale0,docker0,br-+, reset elsewhere',
      ].sort(),
    );
    // `all` is only ever applied behind the guard, and the guard is up before the daemon restarts.
    expect(existsSync(path.join(box.units, 'ollama-tailnet-guard.service'))).toBe(true);
    expect(readFileSync(path.join(box.units, 'ollama-tailnet-guard.service'), 'utf-8')).toContain('-i br-+ -p tcp --dport 11434 -j ACCEPT');

    const names = readdirSync(box.dropins).sort();
    expect(names).toContain(CANONICAL_BIND_DROPIN);
    expect(names).toContain('10-ci-models.conf');
    expect(names).toContain('zz-ci-ollama-context.conf');
    expect(names).toContain('zzz-tailnet-bind.conf.bak-preclaude');
    expect(names).not.toContain('override.conf');
    expect(names.filter((n) => n.startsWith('override.conf.disabled-by-cihub-'))).toHaveLength(1);
    expect(readFileSync(path.join(box.dropins, CANONICAL_BIND_DROPIN), 'utf-8')).toContain('Environment="OLLAMA_HOST=0.0.0.0:11434"');

    const calls = readFileSync(box.log, 'utf-8');
    expect(calls).toMatch(
      /systemctl daemon-reload[\s\S]*systemctl restart ollama-tailnet-guard\.service[\s\S]*systemctl restart ollama\n[\s\S]*systemctl show ollama -p Environment/,
    );

    // Idempotent: the second run moves nothing and rewrites the same content.
    const again = run(ollamaBindApplyShell('all'), box);
    expect(again.status).toBe(0);
    expect(classifyBindApplyOutput(again.stdout, again.stderr).detail.sort()).toEqual(
      [
        'ollama-bind-shadowed: 10-ci-models.conf also sets OLLAMA_MODELS — left in place, outranked by zzzzz-cihub-bind.conf',
        // The guard is re-asserted every run — idempotent by construction (create-or-flush, one jump).
        'ollama-bind-guarded: ollama-tailnet-guard.service active; tcp/11434 accepted from lo,tailscale0,docker0,br-+, reset elsewhere',
      ].sort(),
    );
    // And what systemd would resolve from the files on disk is the canonical file.
    const onDisk: DropinFile[] = readdirSync(box.dropins).map((n) => ({ name: n, content: readFileSync(path.join(box.dropins, n), 'utf-8') }));
    expect(resolveOllamaBind(onDisk).setBy).toBe(CANONICAL_BIND_DROPIN);
  });

  it('fails the step when systemd resolves a different bind than requested', () => {
    // A MIXED drop-in that sorts after the canonical one is the one way this happens: it cannot be
    // moved aside without losing its other setting, and systemd applies it last. The stub plays it.
    const box = sandbox({ ollamaHostAfterRestart: '0.0.0.0', tailscaleIp: '100.124.211.75' });
    writeFileSync(path.join(box.dropins, 'zzzzzz-manual.conf'), `[Service]\n${host('0.0.0.0')}\nEnvironment="OLLAMA_DEBUG=1"\n`);
    const res = run(ollamaBindApplyShell('tailnet'), box);
    expect(res.status).toBe(1);
    const outcome = classifyBindApplyOutput(res.stdout, res.stderr);
    expect(outcome.outcome).toBe('mismatch');
    expect(outcome.why).toContain('requested OLLAMA_HOST=100.124.211.75:11434');
    expect(outcome.why).toContain("resolved '0.0.0.0'");
    expect(outcome.why).toContain('zzzzzz-manual.conf');
    // The canonical file was still written — the operator can see what was attempted.
    expect(existsSync(path.join(box.dropins, CANONICAL_BIND_DROPIN))).toBe(true);
    // Not renamed: it carries another setting, so the shell left it — and named it as shadowed even
    // though, sorting last, it is in fact the winner. The verify step is what catches that.
    expect(existsSync(path.join(box.dropins, 'zzzzzz-manual.conf'))).toBe(true);
  });

  it('binds the tailnet address by default and fails, touching nothing, when the node has none', () => {
    const withIp = sandbox({ ollamaHostAfterRestart: '100.124.211.75:11434', tailscaleIp: '100.124.211.75' });
    const ok = run(ollamaBindApplyShell('tailnet'), withIp);
    expect(ok.status, ok.stderr).toBe(0);
    expect(readFileSync(path.join(withIp.dropins, CANONICAL_BIND_DROPIN), 'utf-8')).toContain('OLLAMA_HOST=100.124.211.75:11434');

    const without = sandbox({ ollamaHostAfterRestart: '0.0.0.0' });
    writeFileSync(path.join(without.dropins, 'override.conf'), `[Service]\n${host('0.0.0.0')}\n`);
    const bad = run(ollamaBindApplyShell('tailnet'), without);
    expect(bad.status).toBe(1);
    expect(classifyBindApplyOutput(bad.stdout, bad.stderr).outcome).toBe('failed');
    expect(readdirSync(without.dropins)).toEqual(['override.conf']);
    expect(readFileSync(without.log, 'utf-8')).not.toContain('systemctl');
  });
});

/**
 * The guard shell against stubbed `ss`, `loginctl` and `systemctl`: the three listener shapes the
 * fleet actually has. Run for real because the bug it fixes was in the shell's control flow — the
 * user-manager loop refused after the listener loop had already found the system unit.
 */
describe.skipIf(!bash)('ollamaOwnershipGuardShell (sandboxed bash)', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * `procCgroup` stands in for `/proc/<pid>/cgroup` — the guard reads it with `tail -1`, so a
   * `tail` stub answers for that path only and defers to the real one otherwise. The pids in
   * these fixtures are not this machine's; the real /proc would say "no such process".
   */
  function runGuard(stubs: { ss: string; userUnits?: string; procCgroup?: string }) {
    const root = mkdtempSync(path.join(tmpdir(), 'cihub-guard-'));
    sandboxes.push(root);
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const stub = (name: string, body: string) => {
      const p = path.join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
    };
    stub('ss', `printf '%s\\n' '${stubs.ss}'`);
    stub('loginctl', "printf '%s\\n' ' 1001 ci          yes active' '60578 gdm-greeter no  active'");
    stub('systemctl', ['case "$*" in', `  *"-M ci@"*"list-units"*) printf '%s\\n' '${stubs.userUnits ?? ''}' ;;`, 'esac'].join('\n'));
    if (stubs.procCgroup !== undefined) {
      stub(
        'tail',
        ['case "$*" in', `  *"/proc/"*"/cgroup"*) printf '%s\\n' '${stubs.procCgroup}' ;;`, '  *) exec /usr/bin/tail "$@" ;;', 'esac'].join('\n'),
      );
      stub('stat', 'echo ollama');
    }
    const res = spawnSync(bash as string, ['-e', '-c', `${ollamaOwnershipGuardShell()}\necho guard-passed`], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: '/tmp' },
      encoding: 'utf-8',
    });
    return { status: res.status, out: res.stdout, err: res.stderr };
  }

  it('core-2: the system unit serves :11434 beside an active `ollama-tunnel.service` — passes, with the note', () => {
    // Root's `ss -ltnpe` on core-2: pid disclosed AND the socket cgroup printed.
    const res = runGuard({
      ss: 'LISTEN 0 4096 *:11434 *:* users:(("ollama",pid=3522669,fd=3)) uid:997 ino:81099226 sk:8006 cgroup:/system.slice/ollama.service v6only:0 <->',
      userUnits: CORE2_TUNNEL,
    });
    expect(res.status, res.err).toBe(0);
    expect(res.out).not.toContain(BIND_MARKERS.refused);
    expect(res.out).toContain(
      "ollama-bind-note: ollama-tunnel.service is active under ci's systemd --user, but the system ollama.service (pid 3522669) is what serves :11434 — that unit is not the daemon; managing the system unit",
    );
    expect(res.out.trim().endsWith('guard-passed')).toBe(true);
    // The apply-output classifier carries the note as detail and does not mistake it for a refusal.
    const outcome = classifyBindApplyOutput(`${res.out}\n${BIND_MARKERS.complete}`, '');
    expect(outcome.outcome).toBe('applied');
    expect(outcome.detail.some((l) => l.startsWith(BIND_MARKERS.note))).toBe(true);
  });

  it('beta-1: a user-scope unit serves :11434 — refuses, by the socket cgroup, before asking any user manager', () => {
    const res = runGuard({ ss: BETA1_SS_E, userUnits: 'ollama-local.service loaded active running Ollama local model server' });
    expect(res.status, res.err).toBe(0);
    expect(res.out).toContain(
      "ollama-bind-refused: ollama-local.service under ?'s systemd --user (pid 941661) already owns :11434; enabling the system ollama.service would start a second daemon that collides on the port",
    );
    expect(res.out).not.toContain('guard-passed');
    expect(res.out).not.toContain(BIND_MARKERS.note);
  });

  it('nothing listens: an active `ollama*` user unit refuses on its name, as it always did', () => {
    // beta-1 with `ollama-local.service` between its stop and its bind: the unit is active, the
    // port is free for a moment, and the guard has nothing but the name to go by. Enabling the
    // system unit here is exactly the collision the guard exists to prevent.
    const restarting = runGuard({ ss: '', userUnits: 'ollama-local.service loaded active running Ollama local model server' });
    expect(restarting.status, restarting.err).toBe(0);
    expect(restarting.out).toContain(
      "ollama-bind-refused: ollama-local.service is running under ci's systemd --user; the system ollama.service path would start a second daemon and collide on :11434",
    );
    expect(restarting.out).not.toContain('guard-passed');
    expect(restarting.out).not.toContain(BIND_MARKERS.note);
    // core-2's tunnel with the system daemon stopped looks the same to the guard, and is refused
    // the same way: the relaxation is for a SERVING system unit only.
    const tunnel = runGuard({ ss: '', userUnits: CORE2_TUNNEL });
    expect(tunnel.out).toContain("ollama-bind-refused: ollama-tunnel.service is running under ci's systemd --user;");
    expect(tunnel.out).not.toContain('guard-passed');
    // With no user unit at all a free port passes, as before.
    const free = runGuard({ ss: '' });
    expect(free.status, free.err).toBe(0);
    expect(free.out.trim()).toBe('guard-passed');
  });

  it('a listener whose owner the guard cannot name, beside an active `ollama*` user unit, still refuses', () => {
    // No pid, no cgroup: an `ss` too old for `-e` cgroups, on a box where the guard is not root.
    const res = runGuard({ ss: 'LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:*', userUnits: CORE2_TUNNEL });
    expect(res.status, res.err).toBe(0);
    expect(res.out).toContain(
      "ollama-bind-refused: ollama-tunnel.service is running under ci's systemd --user; the system ollama.service path would start a second daemon and collide on :11434",
    );
    expect(res.out).not.toContain('guard-passed');
  });

  it('an unreachable socket cgroup falls back to /proc, and with no pid to read it refuses on the name', () => {
    const res = runGuard({
      ss: 'LISTEN 0 4096 *:11434 *:* uid:997 ino:1 sk:1 cgroup:unreachable:00000000000000001 v6only:0 <->',
      userUnits: CORE2_TUNNEL,
    });
    expect(res.out).not.toMatch(/owned by unreachable/);
    expect(res.out).toMatch(/ollama-bind-refused: ollama-tunnel\.service is running under ci's systemd --user/);
  });

  it('a bare `cgroup:/` on the socket is no cgroup: /proc classifies the listener when there is a pid', () => {
    // The root cgroup on the socket, the real unit in /proc: the system unit serves, the tunnel is
    // noted, the guard passes. Before: `unit=""` and a refusal reading "owned by  (pid 3522669)".
    const rootSocket = 'LISTEN 0 4096 *:11434 *:* users:(("ollama",pid=3522669,fd=3)) uid:997 ino:1 sk:1 cgroup:/ v6only:0 <->';
    const byProc = runGuard({ ss: rootSocket, userUnits: CORE2_TUNNEL, procCgroup: '0::/system.slice/ollama.service' });
    expect(byProc.status, byProc.err).toBe(0);
    expect(byProc.out).not.toContain(BIND_MARKERS.refused);
    expect(byProc.out).toContain(
      "ollama-bind-note: ollama-tunnel.service is active under ci's systemd --user, but the system ollama.service (pid 3522669) is what serves :11434",
    );
    expect(byProc.out.trim().endsWith('guard-passed')).toBe(true);
    // /proc names a user unit instead: refused by that, not by the socket's empty cgroup.
    const userByProc = runGuard({
      ss: rootSocket,
      userUnits: 'ollama-local.service loaded active running Ollama local model server',
      procCgroup: '0::/user.slice/user-1001.slice/user@1001.service/app.slice/ollama-local.service',
    });
    expect(userByProc.out).toContain("ollama-bind-refused: ollama-local.service under ollama's systemd --user (pid 3522669) already owns :11434");
    // /proc says the root cgroup too: nobody the guard can name, and the user unit's name refuses —
    // never "owned by  (pid …)" with an empty unit.
    const rootEverywhere = runGuard({ ss: rootSocket, userUnits: CORE2_TUNNEL, procCgroup: '0::/' });
    expect(rootEverywhere.out).not.toMatch(/owned by\s+\(pid/);
    expect(rootEverywhere.out).toMatch(/ollama-bind-refused: ollama-tunnel\.service is running under ci's systemd --user/);
    // And with no pid to read, the same: unseen, and the name refuses.
    const noPid = runGuard({ ss: 'LISTEN 0 4096 *:11434 *:* uid:997 ino:1 sk:1 cgroup:/ v6only:0 <->', userUnits: CORE2_TUNNEL });
    expect(noPid.out).not.toMatch(/owned by\s+\(pid/);
    expect(noPid.out).toMatch(/ollama-bind-refused: ollama-tunnel\.service is running under ci's systemd --user/);
  });

  it('a container or a foreign system unit on the port refuses, whatever the user managers say', () => {
    const container = runGuard({
      ss: 'LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:* users:(("docker-proxy",pid=5,fd=4)) uid:0 cgroup:/system.slice/docker-1f2e3d.scope',
    });
    expect(container.out).toMatch(/ollama-bind-refused: :11434 is served by a container/);
    const foreign = runGuard({
      ss: 'LISTEN 0 4096 0.0.0.0:11434 0.0.0.0:* users:(("ollama",pid=77,fd=4)) uid:0 cgroup:/system.slice/ollama-custom.service',
      userUnits: CORE2_TUNNEL,
    });
    expect(foreign.out).toMatch(/ollama-bind-refused: :11434 is owned by ollama-custom\.service \(pid 77\), not ollama\.service/);
    expect(foreign.out).not.toContain(BIND_MARKERS.note);
  });
});
