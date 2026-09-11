/**
 * `cihub fleet boot-params` — the gfx1151 GTT formula, GRUB classification, the edit, and its gates.
 *
 * Each case is a state measured on this fleet or a failure CI-OS already shipped and fixed:
 *
 *   · Ten of twelve gfx1151 nodes have the parameters absent or partial, because CI-OS sets them at
 *     first boot only and they were provisioned earlier.
 *   · CI-OS's first version extracted `GRUB_CMDLINE_LINUX_DEFAULT` with a double-quote-only regex;
 *     on a single-quoted line it matched nothing, tokenised the whole raw line, re-wrapped it and
 *     fed the corrupted file to `update-grub` with no error. The fix refuses; so must this.
 *   · core-10 and razer have `GRUB_TIMEOUT=0` + `GRUB_TIMEOUT_STYLE=hidden` and no out-of-band
 *     console. A boot that fails there is recovered at the machine, so staging a change nobody can
 *     watch boot is refused unless someone says they can.
 */

import { describe, expect, it } from 'vitest';
import { parseFleetArgs } from '../lib/cli-fleet.js';
import {
  applyBootParamsScript,
  assessNode,
  BOOT_PARAM_PROBE_SCRIPT,
  classifyParams,
  computeGttTarget,
  consoleGate,
  decideGttTarget,
  MIN_TOTAL_RAM_MIB,
  parseBootParamProbe,
  planGrubCmdlineEdit,
  readGrubCmdlineDefault,
  readGrubMenuPolicy,
} from '../lib/fleet-boot-params.js';
import { parseFleetRoster } from '../lib/fleet-roster.js';

// ─── Fixtures, shaped like the real files ──────────────────────────────────────────────────────────

/** A nominal 128 GB Strix Halo box: what CI-OS's formula produces for it. */
const target128 = computeGttTarget(131072);

const CMDLINE_ABSENT = 'BOOT_IMAGE=/boot/vmlinuz-6.14.0-29-generic root=UUID=3b1c9e2a-7f4d-4c1e-9a2b-5d6e7f8a9b0c ro quiet splash vt.handoff=7';
const CMDLINE_FULL = `BOOT_IMAGE=/boot/vmlinuz-6.14.0-29-generic root=UUID=3b1c9e2a-7f4d-4c1e-9a2b-5d6e7f8a9b0c ro quiet splash ${target128.tokens.join(' ')} vt.handoff=7`;
/** The partial state measured on core-2 / liam-demo / core-6: a hand-set gttsize, nothing else. */
const CMDLINE_PARTIAL = 'BOOT_IMAGE=/boot/vmlinuz-6.14.0-29-generic root=UUID=3b1c9e2a ro quiet splash amdgpu.gttsize=120000 vt.handoff=7';

/** Ubuntu's stock /etc/default/grub — which is ALSO the hidden zero-timeout menu core-10 and razer have. */
const GRUB_UBUNTU_DEFAULT = `# If you change this file, run 'update-grub' afterwards to update
# /boot/grub/grub.cfg.
# For full documentation of the options in this file, see:
#   info -f grub -n 'Simple configuration'

GRUB_DEFAULT=0
GRUB_TIMEOUT_STYLE=hidden
GRUB_TIMEOUT=0
GRUB_DISTRIBUTOR=\`( . /etc/os-release; echo \${NAME} ) 2>/dev/null || echo Debian\`
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"
GRUB_CMDLINE_LINUX=""

# If you want to enable the memory Bootloader, uncomment this line
#GRUB_TERMINAL=console
`;

const GRUB_WITH_MENU = GRUB_UBUNTU_DEFAULT.replace('GRUB_TIMEOUT_STYLE=hidden', 'GRUB_TIMEOUT_STYLE=menu').replace(
  'GRUB_TIMEOUT=0',
  'GRUB_TIMEOUT=5',
);
const GRUB_SINGLE_QUOTED = GRUB_UBUNTU_DEFAULT.replace('GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"', "GRUB_CMDLINE_LINUX_DEFAULT='quiet splash'");
const GRUB_STAGED_FULL = GRUB_UBUNTU_DEFAULT.replace(
  'GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"',
  `GRUB_CMDLINE_LINUX_DEFAULT="quiet splash ${target128.tokens.join(' ')}"`,
);

// ─── The formula ───────────────────────────────────────────────────────────────────────────────────

describe('computeGttTarget — CI-OS strix-halo-boot-params.sh, reproduced', () => {
  it('sizes a 128 GB box: 12.5 % reserved, the rest to GTT, 256 pages per MiB', () => {
    expect(target128).toMatchObject({ totalRamMib: 131072, reserveMib: 16384, gttSizeMib: 114688, pagesLimit: 29360128 });
    expect(target128.tokens).toEqual(['iommu=pt', 'amdgpu.gttsize=114688', 'ttm.pages_limit=29360128']);
  });

  it('sizes a 64 GB box', () => {
    expect(computeGttTarget(65536)).toMatchObject({ reserveMib: 8192, gttSizeMib: 57344, pagesLimit: 14680064 });
  });

  it('pins the reserve at 4 GiB on a 32 GB box, where 12.5 % would be less', () => {
    // 31900/8 = 3987 < 4096, so the reserve is the floor rather than the fraction.
    expect(computeGttTarget(31900)).toMatchObject({ reserveMib: 4096, gttSizeMib: 27804, pagesLimit: 7117824 });
  });

  it('uses integer division like bash, so an odd MemTotal lands on the same MiB CI-OS wrote', () => {
    // A real 128 GB Strix Halo reports ~128748 MiB after firmware reservations. 128748/8 = 16093.5;
    // bash truncates. A fractional reserve here would make every such node read as partial forever.
    expect(computeGttTarget(128748)).toMatchObject({ reserveMib: 16093, gttSizeMib: 112655, pagesLimit: 28839680 });
  });

  it('rejects nonsense rather than sizing GTT from it', () => {
    expect(() => computeGttTarget(0)).toThrow(RangeError);
    expect(() => computeGttTarget(Number.NaN)).toThrow(RangeError);
  });
});

describe('decideGttTarget — the RAM floor', () => {
  it('leaves a small-RAM SKU alone, exactly at CI-OS’s floor', () => {
    expect(MIN_TOTAL_RAM_MIB).toBe(30_000);
    const below = decideGttTarget(29_999);
    expect(below.kind).toBe('skip');
    if (below.kind === 'skip') expect(below.why).toMatch(/below the 30000 MiB floor/);
    expect(decideGttTarget(30_000).kind).toBe('target');
  });

  it('does not size anything from a RAM reading it does not have', () => {
    expect(decideGttTarget(undefined).kind).toBe('skip');
  });
});

// ─── Classification ────────────────────────────────────────────────────────────────────────────────

describe('classifyParams', () => {
  it('reads a stock Ubuntu cmdline as absent', () => {
    const p = classifyParams(CMDLINE_ABSENT, target128);
    expect(p.state).toBe('absent');
    expect(p.missing).toEqual(['iommu', 'amdgpu.gttsize', 'ttm.pages_limit']);
    expect(p.detail).toBe('absent');
  });

  it('reads all three at target as full', () => {
    const p = classifyParams(CMDLINE_FULL, target128);
    expect(p.state).toBe('full');
    expect(p.detail).toBe('full');
    expect(p.values).toEqual({ iommu: 'pt', 'amdgpu.gttsize': '114688', 'ttm.pages_limit': '29360128' });
  });

  it('reads a lone hand-set gttsize as partial, naming what is missing and what is off-target', () => {
    const p = classifyParams(CMDLINE_PARTIAL, target128);
    expect(p.state).toBe('partial');
    expect(p.stale).toEqual(['amdgpu.gttsize']);
    expect(p.missing).toEqual(['iommu', 'ttm.pages_limit']);
    expect(p.detail).toBe('partial: amdgpu.gttsize=120000 (target 114688), iommu missing, ttm.pages_limit missing');
  });

  it('reads all three present but sized for a different RAM total as partial, not full', () => {
    // The state a BIOS UMA change produces: MemTotal moved, the staged numbers did not.
    const other = computeGttTarget(65536);
    const p = classifyParams(`quiet ${other.tokens.join(' ')}`, target128);
    expect(p.state).toBe('partial');
    expect(p.stale).toEqual(['amdgpu.gttsize', 'ttm.pages_limit']);
  });

  it('takes the last occurrence of a key, as the kernel does', () => {
    const p = classifyParams(`amdgpu.gttsize=1 ${target128.tokens.join(' ')}`, target128);
    expect(p.state).toBe('full');
  });

  it('without a target, treats presence as enough — except iommu, which must be pt', () => {
    expect(classifyParams('quiet iommu=pt amdgpu.gttsize=5 ttm.pages_limit=6').state).toBe('full');
    expect(classifyParams('quiet iommu=on amdgpu.gttsize=5 ttm.pages_limit=6').state).toBe('partial');
  });
});

// ─── /etc/default/grub ─────────────────────────────────────────────────────────────────────────────

describe('readGrubCmdlineDefault', () => {
  it('finds the double-quoted line in a stock file', () => {
    const found = readGrubCmdlineDefault(GRUB_UBUNTU_DEFAULT);
    expect(found.kind).toBe('ok');
    if (found.kind === 'ok') {
      expect(found.value).toBe('quiet splash');
      expect(found.line).toBe('GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"');
    }
  });

  it('refuses a single-quoted line and says that is why', () => {
    const found = readGrubCmdlineDefault(GRUB_SINGLE_QUOTED);
    expect(found.kind).toBe('unsupported');
    if (found.kind === 'unsupported') expect(found.why).toMatch(/single-quoted/);
  });

  it('refuses a trailing comment, an escaped quote, and a shell expansion rather than tokenising them', () => {
    for (const line of [
      'GRUB_CMDLINE_LINUX_DEFAULT="quiet splash" # keep',
      'GRUB_CMDLINE_LINUX_DEFAULT="quiet \\"splash\\""',
      'GRUB_CMDLINE_LINUX_DEFAULT="quiet $EXTRA"',
      'GRUB_CMDLINE_LINUX_DEFAULT=quiet',
    ]) {
      expect(readGrubCmdlineDefault(`GRUB_TIMEOUT=0\n${line}\n`).kind).toBe('unsupported');
    }
  });

  it('reports a file with no such line as missing, ignoring a commented one', () => {
    expect(readGrubCmdlineDefault('GRUB_TIMEOUT=0\n#GRUB_CMDLINE_LINUX_DEFAULT="quiet"\n').kind).toBe('missing');
  });

  it('takes the last assignment, since grub-mkconfig sources the file as shell', () => {
    const found = readGrubCmdlineDefault('GRUB_CMDLINE_LINUX_DEFAULT="first"\nGRUB_CMDLINE_LINUX_DEFAULT="second"\n');
    expect(found.kind).toBe('ok');
    if (found.kind === 'ok') expect(found.value).toBe('second');
  });
});

describe('readGrubMenuPolicy', () => {
  it('recognises the hidden zero-timeout menu (Ubuntu default; core-10 and razer)', () => {
    expect(readGrubMenuPolicy(GRUB_UBUNTU_DEFAULT)).toEqual({ timeout: 0, timeoutStyle: 'hidden', hiddenZeroTimeout: true });
  });

  it('does not fire on a menu that is shown, or a timeout that is not zero', () => {
    expect(readGrubMenuPolicy(GRUB_WITH_MENU).hiddenZeroTimeout).toBe(false);
    expect(readGrubMenuPolicy('GRUB_TIMEOUT_STYLE=hidden\nGRUB_TIMEOUT=3\n').hiddenZeroTimeout).toBe(false);
    expect(readGrubMenuPolicy('GRUB_TIMEOUT_STYLE=menu\nGRUB_TIMEOUT=0\n').hiddenZeroTimeout).toBe(false);
  });

  it('reads quoted values too', () => {
    expect(readGrubMenuPolicy('GRUB_TIMEOUT_STYLE="hidden"\nGRUB_TIMEOUT="0"\n').hiddenZeroTimeout).toBe(true);
  });
});

// ─── The edit ──────────────────────────────────────────────────────────────────────────────────────

describe('planGrubCmdlineEdit', () => {
  it('appends the three tokens in CI-OS order to a stock line and touches nothing else', () => {
    const plan = planGrubCmdlineEdit(GRUB_UBUNTU_DEFAULT, target128);
    expect(plan.kind).toBe('edit');
    if (plan.kind !== 'edit') return;
    expect(plan.before).toBe('GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"');
    expect(plan.after).toBe('GRUB_CMDLINE_LINUX_DEFAULT="quiet splash iommu=pt amdgpu.gttsize=114688 ttm.pages_limit=29360128"');
    // Every other byte of the file survives — the distributor line with its backticks included.
    expect(plan.newText).toBe(GRUB_UBUNTU_DEFAULT.replace(plan.before, plan.after));
  });

  it('is idempotent: planning on its own output is a no-op', () => {
    const first = planGrubCmdlineEdit(GRUB_UBUNTU_DEFAULT, target128);
    expect(first.kind).toBe('edit');
    if (first.kind !== 'edit') return;
    const second = planGrubCmdlineEdit(first.newText, target128);
    expect(second.kind).toBe('noop');
    if (second.kind === 'noop') expect(second.value).toBe(first.afterValue);
  });

  it('is a no-op on a line CI-OS already wrote', () => {
    expect(planGrubCmdlineEdit(GRUB_STAGED_FULL, target128).kind).toBe('noop');
  });

  it('replaces stale managed tokens wherever they sit and keeps every foreign one', () => {
    const text = 'GRUB_CMDLINE_LINUX_DEFAULT="amdgpu.gttsize=120000 quiet iommu=pt splash ttm.pages_limit=1 amd_iommu=on"\n';
    const plan = planGrubCmdlineEdit(text, target128);
    expect(plan.kind).toBe('edit');
    if (plan.kind === 'edit') expect(plan.afterValue).toBe('quiet splash amd_iommu=on iommu=pt amdgpu.gttsize=114688 ttm.pages_limit=29360128');
  });

  it('REFUSES a single-quoted line — the corruption CI-OS shipped and fixed — and produces no text', () => {
    const plan = planGrubCmdlineEdit(GRUB_SINGLE_QUOTED, target128);
    expect(plan.kind).toBe('refuse');
    if (plan.kind === 'refuse') {
      expect(plan.why).toMatch(/single-quoted/);
      expect(plan.why).toContain("GRUB_CMDLINE_LINUX_DEFAULT='quiet splash'");
    }
    expect('newText' in plan).toBe(false);
  });

  it('refuses when there is no line, no file, or a grub.d override that would silently win', () => {
    expect(planGrubCmdlineEdit('GRUB_TIMEOUT=0\n', target128)).toMatchObject({
      kind: 'refuse',
      why: expect.stringMatching(/no GRUB_CMDLINE_LINUX_DEFAULT line/),
    });
    expect(planGrubCmdlineEdit(null, target128)).toMatchObject({ kind: 'refuse', why: expect.stringMatching(/does not exist/) });
    expect(planGrubCmdlineEdit(GRUB_UBUNTU_DEFAULT, target128, ['/etc/default/grub.d/50-cloudimg-settings.cfg'])).toMatchObject({
      kind: 'refuse',
      why: expect.stringMatching(/50-cloudimg-settings\.cfg.*silently overridden/),
    });
  });

  it('edits only the effective (last) line when the file carries two', () => {
    const text = 'GRUB_CMDLINE_LINUX_DEFAULT="first"\nGRUB_CMDLINE_LINUX_DEFAULT="second"\n';
    const plan = planGrubCmdlineEdit(text, target128);
    expect(plan.kind).toBe('edit');
    if (plan.kind === 'edit') {
      expect(plan.newText.split('\n')[0]).toBe('GRUB_CMDLINE_LINUX_DEFAULT="first"');
      expect(plan.newText.split('\n')[1]).toBe(`GRUB_CMDLINE_LINUX_DEFAULT="second ${target128.tokens.join(' ')}"`);
    }
  });

  it('always ends the written file with a newline', () => {
    const plan = planGrubCmdlineEdit('GRUB_CMDLINE_LINUX_DEFAULT="quiet"', target128);
    if (plan.kind === 'edit') expect(plan.newText.endsWith('\n')).toBe(true);
  });
});

// ─── The safety gate ───────────────────────────────────────────────────────────────────────────────

describe('consoleGate', () => {
  const hidden = readGrubMenuPolicy(GRUB_UBUNTU_DEFAULT);

  it('refuses a hidden zero-timeout node with no roster console, in one sentence that says why', () => {
    const gate = consoleGate({ nodeName: 'core-10', menu: hidden, iHaveConsole: false });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) return;
    expect(gate.why).toContain('core-10');
    expect(gate.why).toMatch(/GRUB_TIMEOUT=0/);
    expect(gate.why).toMatch(/no out-of-band console/);
    expect(gate.why).toMatch(/--i-have-console/);
    // One sentence: a single terminator, at the end.
    expect(gate.why.trim().split(/(?<=[.!?])\s+/)).toHaveLength(1);
  });

  it('allows the same node once the roster records a console, and names it', () => {
    const gate = consoleGate({ nodeName: 'core-10', menu: hidden, console: 'nanokvm 192.168.0.115', iHaveConsole: false });
    expect(gate.allowed).toBe(true);
    if (gate.allowed) expect(gate.note).toContain('nanokvm 192.168.0.115');
  });

  it('allows it on --i-have-console, and says that is the only reason', () => {
    const gate = consoleGate({ nodeName: 'razer', menu: hidden, iHaveConsole: true });
    expect(gate.allowed).toBe(true);
    if (gate.allowed) expect(gate.note).toMatch(/--i-have-console/);
  });

  it('does not fire on a node whose menu is shown, whatever the roster says', () => {
    expect(consoleGate({ nodeName: 'core-1', menu: readGrubMenuPolicy(GRUB_WITH_MENU), iHaveConsole: false })).toEqual({ allowed: true });
    expect(consoleGate({ nodeName: 'core-1', menu: undefined, iHaveConsole: false })).toEqual({ allowed: true });
  });
});

// ─── Per-node assessment ───────────────────────────────────────────────────────────────────────────

describe('assessNode', () => {
  it('absent everywhere on a menu-shown node: plans the edit and needs a reboot afterwards', () => {
    const a = assessNode({ node: 'core-1', cmdline: CMDLINE_ABSENT, grubText: GRUB_WITH_MENU, target: target128, iHaveConsole: false });
    expect(a.live.state).toBe('absent');
    expect(a.staged).toMatchObject({ kind: 'parsed', presence: { state: 'absent' } });
    expect(a.plan.kind).toBe('edit');
    expect(a.gate.allowed).toBe(true);
    expect(a.rebootRequired).toBe(true);
  });

  it('staged but not live: nothing to write, only a reboot', () => {
    const a = assessNode({
      node: 'core-2',
      cmdline: CMDLINE_ABSENT,
      grubText: GRUB_STAGED_FULL.replace('GRUB_TIMEOUT=0', 'GRUB_TIMEOUT=5'),
      target: target128,
      iHaveConsole: false,
    });
    expect(a.staged).toMatchObject({ kind: 'parsed', presence: { state: 'full' } });
    expect(a.plan.kind).toBe('noop');
    expect(a.rebootRequired).toBe(true);
  });

  it('live but not staged: the edit is planned and no reboot is needed — the next one would have lost them', () => {
    const a = assessNode({ node: 'core-6', cmdline: CMDLINE_FULL, grubText: GRUB_WITH_MENU, target: target128, iHaveConsole: false });
    expect(a.live.state).toBe('full');
    expect(a.plan.kind).toBe('edit');
    expect(a.rebootRequired).toBe(false);
  });

  it('core-10: absent, hidden zero-timeout, no console — the edit is planned, the gate refuses, no reboot is listed', () => {
    const a = assessNode({ node: 'core-10', cmdline: CMDLINE_ABSENT, grubText: GRUB_UBUNTU_DEFAULT, target: target128, iHaveConsole: false });
    expect(a.plan.kind).toBe('edit');
    expect(a.gate.allowed).toBe(false);
    expect(a.menu?.hiddenZeroTimeout).toBe(true);
    // Nothing will be staged, so listing it as "reboot required" would send someone to reboot a
    // node that gains nothing from it.
    expect(a.rebootRequired).toBe(false);
  });

  it('reports the two sides separately when the file is unreadable', () => {
    const a = assessNode({ node: 'x', cmdline: CMDLINE_PARTIAL, grubText: GRUB_SINGLE_QUOTED, target: target128, iHaveConsole: false });
    expect(a.live.state).toBe('partial');
    expect(a.staged).toMatchObject({ kind: 'unreadable', why: expect.stringMatching(/single-quoted/) });
    expect(a.plan.kind).toBe('refuse');
  });
});

// ─── The wire format and the write ─────────────────────────────────────────────────────────────────

describe('parseBootParamProbe', () => {
  const sha = 'a'.repeat(64);
  // The byte stream the probe script emits: `cat file; echo` puts exactly one newline between the
  // file's last byte and the next marker, whether or not the file ended with one. `join('\n')`
  // supplies that newline here.
  const wrap = (grub: string | null, overrides = '') =>
    [
      '---CIHUB_BOOT_CMDLINE---',
      CMDLINE_ABSENT,
      '---CIHUB_BOOT_GRUB_DEFAULT---',
      grub === null ? 'CIHUB_NO_GRUB_DEFAULT' : grub,
      '---CIHUB_BOOT_GRUB_SHA256---',
      grub === null ? '' : sha,
      '---CIHUB_BOOT_GRUB_OVERRIDES---',
      overrides,
      '---CIHUB_BOOT_UPDATE_GRUB---',
      'yes',
      '---CIHUB_BOOT_END---',
    ].join('\n');

  it('recovers the grub file byte-for-byte, including one without a trailing newline', () => {
    expect(parseBootParamProbe(wrap(GRUB_UBUNTU_DEFAULT))?.grubText).toBe(GRUB_UBUNTU_DEFAULT);
    const noTrailing = GRUB_UBUNTU_DEFAULT.trimEnd();
    expect(parseBootParamProbe(wrap(noTrailing))?.grubText).toBe(noTrailing);
  });

  it('carries the cmdline, the hash, the overrides and update-grub presence', () => {
    const probe = parseBootParamProbe(wrap(GRUB_UBUNTU_DEFAULT, '/etc/default/grub.d/50-cloudimg-settings.cfg'));
    expect(probe).toMatchObject({
      cmdline: CMDLINE_ABSENT,
      grubSha256: sha,
      overriddenBy: ['/etc/default/grub.d/50-cloudimg-settings.cfg'],
      hasUpdateGrub: true,
    });
  });

  it('reports a missing file as null rather than as an empty file', () => {
    const probe = parseBootParamProbe(wrap(null));
    expect(probe?.grubText).toBeNull();
    expect(probe?.grubSha256).toBeUndefined();
  });

  it('returns null for output that is not a probe, so a garbled reply is a failure not a plan', () => {
    expect(parseBootParamProbe('bash: line 1: syntax error')).toBeNull();
  });

  it('the probe script reads without sudo and ends true, like the hardware probe', () => {
    expect(BOOT_PARAM_PROBE_SCRIPT).not.toMatch(/sudo/);
    expect(BOOT_PARAM_PROBE_SCRIPT.endsWith('; true')).toBe(true);
  });
});

describe('applyBootParamsScript', () => {
  const plan = planGrubCmdlineEdit(GRUB_WITH_MENU, target128);
  const sha = 'b'.repeat(64);
  const script = plan.kind === 'edit' ? applyBootParamsScript({ newText: plan.newText, expectedSha256: sha }) : '';

  it('refuses to write a file that changed since it was read, before touching anything', () => {
    const guard = script.indexOf('sha256sum -c --status');
    const write = script.indexOf('cat > "$f"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);
    expect(script).toContain(`echo "${sha}  $f"`);
    expect(script).toContain('exit 3');
  });

  it('backs up beside the file — not under grub.d, which grub-mkconfig sources — then runs update-grub', () => {
    expect(script).toMatch(/cp -p "\$f" "\$f\.bak-\$stamp"/);
    expect(script).not.toContain('grub.d');
    expect(script).toContain('update-grub');
    expect(script).toContain('boot-params-written-no-update-grub');
  });

  it('writes exactly the planned text', () => {
    if (plan.kind !== 'edit') throw new Error('fixture should plan an edit');
    expect(script).toContain(`<<'CIHUB_GRUB_DEFAULT_EOF'\n${plan.newText.slice(0, -1)}\nCIHUB_GRUB_DEFAULT_EOF`);
  });

  it('never reboots', () => {
    expect(script).not.toMatch(/\b(reboot|shutdown|kexec|poweroff|halt)\b/);
  });

  it('will not build a script around a bad hash or a text that would break its own heredoc', () => {
    expect(() => applyBootParamsScript({ newText: 'x\n', expectedSha256: 'nope' })).toThrow(RangeError);
    expect(() => applyBootParamsScript({ newText: 'CIHUB_GRUB_DEFAULT_EOF\n', expectedSha256: sha })).toThrow(RangeError);
  });
});

// ─── The CLI surface and the roster field ──────────────────────────────────────────────────────────

describe('cihub fleet boot-params argv', () => {
  it('is a subcommand, dry-run by default, with the console assertion off', () => {
    const args = parseFleetArgs(['boot-params']);
    expect(args.subcommand).toBe('boot-params');
    expect(args.execute).toBe(false);
    expect(args.iHaveConsole).toBe(false);
  });

  it('takes --i-have-console and --execute as exact flags', () => {
    const args = parseFleetArgs(['boot-params', '--nodes', 'core-10', '--i-have-console', '--execute']);
    expect(args.iHaveConsole).toBe(true);
    expect(args.execute).toBe(true);
    expect(args.nodes).toEqual(['core-10']);
    expect(() => parseFleetArgs(['boot-params', '--i-have-consoles'])).toThrow(/Unknown flag/);
  });
});

describe('roster console field', () => {
  it('keeps a console string and drops a blank one', () => {
    const { nodes } = parseFleetRoster([
      { name: 'core-10', ip: '100.64.0.10', console: ' nanokvm 192.168.0.115 ' },
      { name: 'razer', ip: '100.64.0.11', console: '   ' },
      { name: 'core-1', ip: '100.64.0.1' },
    ]);
    expect(nodes.map((n) => n.console)).toEqual(['nanokvm 192.168.0.115', undefined, undefined]);
  });
});
