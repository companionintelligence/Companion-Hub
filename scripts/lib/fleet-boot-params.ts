/**
 * Strix Halo (gfx1151) GTT boot parameters for nodes provisioned before CI-OS set them.
 *
 * CI-OS applies `iommu=pt amdgpu.gttsize=<N> ttm.pages_limit=<M>` at FIRST BOOT only
 * (`scripts/lib/strix-halo-boot-params.sh`, PR #50). Ten of the twelve gfx1151 nodes on this fleet
 * were provisioned before that shipped, and as measured on 2026-09-10 they have the parameters
 * absent (core-1, core-4, core-7, core-14, fzzy, beta-max, localhost-0) or partial (core-2,
 * liam-demo, core-6). Without them the amdgpu driver exposes only the firmware VRAM carve-out, and
 * every model above it fails to load on a box with 64–128 GB of unified memory sitting idle.
 *
 * Three decisions here are inherited from CI-OS on purpose, so a node it provisions and a node this
 * brings up to date end in the same state:
 *
 *   · **The formula is CI-OS's, not a new one.** `reserve = max(4 GiB, total/8)`,
 *     `gttsize = total − reserve`, `pages_limit = gttsize × 256`, below a 30 000 MiB floor nothing is
 *     set. Two tools disagreeing on the number would make every re-run a change.
 *   · **A `GRUB_CMDLINE_LINUX_DEFAULT` line that is not plainly double-quoted is REFUSED.** CI-OS
 *     originally extracted the value with a double-quote-only regex; on a single-quoted line it
 *     silently matched nothing, tokenised the whole raw line, re-wrapped it, and fed the corrupted
 *     file to `update-grub` with no error. The fix (CI-OS 121ee0c) refuses rather than guesses, and so
 *     does this.
 *   · **Idempotent.** Managed tokens are stripped and re-appended; a line already carrying the target
 *     produces no change, and re-running on the output of a run produces no change.
 *
 * Two things CI-OS did not have to face, because it runs on a machine someone is installing:
 *
 *   · **Live and staged can disagree, and both are reported.** `/proc/cmdline` is what the running
 *     kernel got; `/etc/default/grub` is what the next boot will get. A node with the parameters
 *     staged but not live needs a reboot and nothing else; a node with them live but not staged will
 *     lose them on its next reboot. One column would hide both.
 *   · **A reboot is the dangerous part, and this never performs one.** Two gfx1151 nodes (core-10,
 *     razer) have `GRUB_TIMEOUT=0` with `GRUB_TIMEOUT_STYLE=hidden` and no out-of-band console. A
 *     kernel that fails to come up on the new parameters there has no menu to fall back to and nobody
 *     who can reach one — recovery is physical. `consoleGate` refuses to stage anything on such a node
 *     unless the roster records a console for it or the operator passes `--i-have-console`.
 *
 * Everything in this file except the two SSH wrappers at the bottom is pure, so the classification,
 * the formula, the refusal and the gate are all testable against fixture text.
 */

import { sshCapture, type SshTarget } from './fleet-ssh.js';

// ─── The formula ───────────────────────────────────────────────────────────────────────────────────

/** CI-OS's floor. ~29.3 GiB: below a nominal 32 GB SKU, above what /proc/meminfo reports for one. */
export const MIN_TOTAL_RAM_MIB = 30_000;

/** Below this the reserve is pinned, so a 32 GB box keeps 4 GiB rather than 12.5 %. */
const MIN_RESERVE_MIB = 4096;

export const MANAGED_KEYS = ['iommu', 'amdgpu.gttsize', 'ttm.pages_limit'] as const;
export type ManagedKey = (typeof MANAGED_KEYS)[number];

export interface GttTarget {
  totalRamMib: number;
  reserveMib: number;
  gttSizeMib: number;
  pagesLimit: number;
  /** Effective value per managed key. */
  values: Record<ManagedKey, string>;
  /** The three tokens in CI-OS's order, so a staged line reads the same whichever tool wrote it. */
  tokens: string[];
}

export type GttTargetDecision = { kind: 'target'; target: GttTarget } | { kind: 'skip'; why: string };

/**
 * CI-OS's sizing, verbatim: integer arithmetic in MiB, reserve floored at 4 GiB.
 *
 * `total/8` is bash integer division in the original, hence `Math.floor`. A fractional reserve would
 * put this one MiB off CI-OS on odd totals, and every such node would read as "partial" forever.
 */
export function computeGttTarget(totalRamMib: number): GttTarget {
  if (!Number.isFinite(totalRamMib) || totalRamMib <= 0) throw new RangeError(`total RAM must be a positive number of MiB, got ${totalRamMib}`);
  const total = Math.floor(totalRamMib);
  const reserveMib = Math.max(MIN_RESERVE_MIB, Math.floor(total / 8));
  const gttSizeMib = total - reserveMib;
  const pagesLimit = gttSizeMib * 256;
  const values: Record<ManagedKey, string> = {
    iommu: 'pt',
    'amdgpu.gttsize': String(gttSizeMib),
    'ttm.pages_limit': String(pagesLimit),
  };
  return {
    totalRamMib: total,
    reserveMib,
    gttSizeMib,
    pagesLimit,
    values,
    tokens: MANAGED_KEYS.map((key) => `${key}=${values[key]}`),
  };
}

/** The formula behind CI-OS's gate: no RAM reading, or a reading under the floor, sets nothing. */
export function decideGttTarget(totalRamMib: number | undefined): GttTargetDecision {
  if (totalRamMib === undefined || !Number.isFinite(totalRamMib) || totalRamMib <= 0) {
    return { kind: 'skip', why: 'total RAM could not be read, and the GTT size is a fraction of it' };
  }
  if (totalRamMib < MIN_TOTAL_RAM_MIB) {
    return {
      kind: 'skip',
      why: `${Math.floor(totalRamMib)} MiB RAM is below the ${MIN_TOTAL_RAM_MIB} MiB floor CI-OS applies these parameters above — a small-RAM SKU is left alone`,
    };
  }
  return { kind: 'target', target: computeGttTarget(totalRamMib) };
}

// ─── Classification ────────────────────────────────────────────────────────────────────────────────

export type ParamState = 'full' | 'partial' | 'absent';

export interface ParamPresence {
  state: ParamState;
  /** Effective value per managed key that is present. Last occurrence wins, as the kernel does. */
  values: Partial<Record<ManagedKey, string>>;
  missing: ManagedKey[];
  /** Present, but not at the target's value — a hand-set number, or a RAM total that has changed. */
  stale: ManagedKey[];
  /** One line for a table cell. */
  detail: string;
}

function splitTokens(cmdline: string): string[] {
  return cmdline.split(/\s+/).filter(Boolean);
}

/**
 * The tokens this tool owns, exactly as CI-OS strips them: `iommu=pt` literally, the other two by key.
 *
 * `iommu=on` is deliberately NOT managed. CI-OS leaves it and appends `iommu=pt` after it, the kernel
 * takes the last, and matching that keeps a re-run here from producing a different line than CI-OS.
 */
function isManagedToken(token: string): boolean {
  return token === 'iommu=pt' || token.startsWith('amdgpu.gttsize=') || token.startsWith('ttm.pages_limit=');
}

/**
 * Classify one kernel command line — `/proc/cmdline` as booted, or the staged
 * `GRUB_CMDLINE_LINUX_DEFAULT` value — against the target.
 *
 * `full` is all three keys present at the target's values. `absent` is none of them. Everything
 * else is `partial`, and `detail` says which: the state measured on core-2, liam-demo and core-6.
 */
export function classifyParams(cmdline: string, target?: GttTarget): ParamPresence {
  const values: Partial<Record<ManagedKey, string>> = {};
  for (const token of splitTokens(cmdline)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    if ((MANAGED_KEYS as readonly string[]).includes(key)) values[key as ManagedKey] = token.slice(eq + 1);
  }
  const missing = MANAGED_KEYS.filter((key) => values[key] === undefined);
  const stale = MANAGED_KEYS.filter((key) => {
    const have = values[key];
    if (have === undefined) return false;
    // Without a target, "present" is the best that can be said; with one, the value must match.
    return target ? have !== target.values[key] : key === 'iommu' && have !== 'pt';
  });

  let state: ParamState;
  if (missing.length === MANAGED_KEYS.length) state = 'absent';
  else if (missing.length === 0 && stale.length === 0) state = 'full';
  else state = 'partial';

  const parts: string[] = [];
  for (const key of stale) parts.push(`${key}=${values[key]}${target ? ` (target ${target.values[key]})` : ''}`);
  for (const key of missing) if (state !== 'absent') parts.push(`${key} missing`);
  const detail = parts.length ? `${state}: ${parts.join(', ')}` : state;

  return { state, values, missing, stale, detail };
}

// ─── /etc/default/grub ─────────────────────────────────────────────────────────────────────────────

const CMDLINE_DEFAULT_KEY = 'GRUB_CMDLINE_LINUX_DEFAULT';

/**
 * The only line shape this tool will edit: `GRUB_CMDLINE_LINUX_DEFAULT="…"` with nothing after the
 * closing quote and nothing inside it that shell quoting would give meaning to.
 *
 * `"`, `\`, `$`, `` ` `` and `'` are excluded from the value on purpose. The file is sourced by
 * `grub-mkconfig` as shell, so any of them makes "split on whitespace and re-wrap" a different
 * string than the shell would have read — the exact class of silent corruption CI-OS's single-quote
 * bug was. A value containing one is refused, not interpreted.
 */
const PLAIN_DOUBLE_QUOTED = /^GRUB_CMDLINE_LINUX_DEFAULT="([^"\\$`']*)"$/;

export type GrubCmdlineLine =
  | { kind: 'ok'; lineIndex: number; line: string; value: string }
  | { kind: 'missing' }
  | { kind: 'unsupported'; lineIndex: number; line: string; why: string };

/** Find the effective `GRUB_CMDLINE_LINUX_DEFAULT` line — the last one, since the file is shell. */
export function readGrubCmdlineDefault(grubText: string): GrubCmdlineLine {
  const lines = grubText.split('\n');
  let lastIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').startsWith(`${CMDLINE_DEFAULT_KEY}=`)) lastIndex = i;
  }
  if (lastIndex < 0) return { kind: 'missing' };
  const line = lines[lastIndex] ?? '';
  const match = PLAIN_DOUBLE_QUOTED.exec(line);
  if (match) return { kind: 'ok', lineIndex: lastIndex, line, value: match[1] ?? '' };
  const why = line.startsWith(`${CMDLINE_DEFAULT_KEY}='`)
    ? 'the line is single-quoted; a double-quote-only rewrite silently corrupted exactly this shape in CI-OS, so it is refused rather than guessed'
    : 'the line is not in the plain double-quoted form this tool edits (a trailing comment, an escaped quote, or a shell expansion); refusing to guess a format';
  return { kind: 'unsupported', lineIndex: lastIndex, line, why };
}

export interface GrubMenuPolicy {
  timeout?: number;
  timeoutStyle?: string;
  /**
   * `GRUB_TIMEOUT=0` with `GRUB_TIMEOUT_STYLE=hidden`: no menu is ever shown, so a boot that fails on
   * new parameters cannot be caught at the keyboard. core-10 and razer on this fleet.
   */
  hiddenZeroTimeout: boolean;
}

function readShellAssignment(grubText: string, key: string): string | undefined {
  let found: string | undefined;
  for (const raw of grubText.split('\n')) {
    if (!raw.startsWith(`${key}=`)) continue;
    let value = raw.slice(key.length + 1).trim();
    // Strip a trailing comment only when the value is unquoted; a quoted value keeps its text.
    const quoted = /^(["'])(.*)\1\s*(#.*)?$/.exec(value);
    if (quoted) value = quoted[2] ?? '';
    else value = value.replace(/\s+#.*$/, '').trim();
    found = value;
  }
  return found;
}

/** What the GRUB menu will do on the next boot, read from the staged file. */
export function readGrubMenuPolicy(grubText: string): GrubMenuPolicy {
  const timeoutRaw = readShellAssignment(grubText, 'GRUB_TIMEOUT');
  const timeout = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  const timeoutStyle = readShellAssignment(grubText, 'GRUB_TIMEOUT_STYLE');
  return {
    timeout: timeout !== undefined && Number.isFinite(timeout) ? timeout : undefined,
    timeoutStyle,
    hiddenZeroTimeout: timeout === 0 && timeoutStyle === 'hidden',
  };
}

export type GrubEditPlan =
  | { kind: 'noop'; value: string; why: string }
  | { kind: 'edit'; before: string; after: string; beforeValue: string; afterValue: string; newText: string }
  | { kind: 'refuse'; why: string };

/**
 * Plan the one-line edit CI-OS makes, on the text as read — and refuse where CI-OS refuses.
 *
 * Managed tokens are dropped wherever they sit and the target's three are appended in CI-OS's order,
 * so the two tools converge on a byte-identical line. `overriddenBy` names `/etc/default/grub.d/*.cfg`
 * files that also assign `GRUB_CMDLINE_LINUX_DEFAULT`; `grub-mkconfig` sources those after the main
 * file, so an edit here would change nothing on the next boot while looking staged. Refused for the
 * same reason as the quoting cases: the tool would otherwise report work it had not done.
 */
export function planGrubCmdlineEdit(grubText: string | null, target: GttTarget, overriddenBy: readonly string[] = []): GrubEditPlan {
  if (grubText === null)
    return { kind: 'refuse', why: '/etc/default/grub does not exist — this node does not boot through GRUB the way this tool expects' };
  if (overriddenBy.length) {
    return {
      kind: 'refuse',
      why: `${CMDLINE_DEFAULT_KEY} is also set in ${overriddenBy.join(', ')}, which grub-mkconfig sources after /etc/default/grub; an edit here would be silently overridden`,
    };
  }
  const found = readGrubCmdlineDefault(grubText);
  if (found.kind === 'missing') return { kind: 'refuse', why: `no ${CMDLINE_DEFAULT_KEY} line in /etc/default/grub; refusing to guess a format` };
  if (found.kind === 'unsupported') return { kind: 'refuse', why: `${found.why}: ${found.line}` };

  const kept = splitTokens(found.value).filter((token) => !isManagedToken(token));
  const afterValue = [...kept, ...target.tokens].join(' ');
  if (afterValue === found.value) {
    return { kind: 'noop', value: found.value, why: `${CMDLINE_DEFAULT_KEY} already carries the target parameters` };
  }
  const after = `${CMDLINE_DEFAULT_KEY}="${afterValue}"`;
  const lines = grubText.split('\n');
  lines[found.lineIndex] = after;
  let newText = lines.join('\n');
  if (!newText.endsWith('\n')) newText += '\n';
  return { kind: 'edit', before: found.line, after, beforeValue: found.value, afterValue, newText };
}

// ─── The safety gate ───────────────────────────────────────────────────────────────────────────────

export type ConsoleGate = { allowed: true; note?: string } | { allowed: false; why: string };

/**
 * May this node be given parameters it will only pick up on a reboot nobody can watch?
 *
 * Fires on the exact configuration measured on core-10 and razer: a hidden zero-timeout GRUB menu
 * with no out-of-band console recorded in the roster. `--i-have-console` is the operator asserting
 * they are at the machine or have a KVM the roster does not know about; recording the console on the
 * roster entry is the durable version of the same assertion.
 */
export function consoleGate(input: { nodeName: string; menu?: GrubMenuPolicy; console?: string; iHaveConsole: boolean }): ConsoleGate {
  if (!input.menu?.hiddenZeroTimeout) return { allowed: true };
  if (input.console) return { allowed: true, note: `hidden zero-timeout GRUB menu, but the roster records a console: ${input.console}` };
  if (input.iHaveConsole) return { allowed: true, note: 'hidden zero-timeout GRUB menu and no roster console; proceeding on --i-have-console' };
  return {
    allowed: false,
    why: `${input.nodeName} has GRUB_TIMEOUT=0 with GRUB_TIMEOUT_STYLE=hidden and no out-of-band console in the roster, so a boot that fails on the new parameters can only be recovered at the machine — re-run with --i-have-console if you are there, or set "console" on its fleet.json entry.`,
  };
}

// ─── Per-node assessment ───────────────────────────────────────────────────────────────────────────

export interface NodeBootParamAssessment {
  node: string;
  target: GttTarget;
  /** What the running kernel was given. */
  live: ParamPresence;
  /** What the next boot will be given, or why that could not be read. */
  staged: { kind: 'parsed'; presence: ParamPresence } | { kind: 'unreadable'; why: string };
  menu?: GrubMenuPolicy;
  plan: GrubEditPlan;
  gate: ConsoleGate;
  /**
   * The kernel is not running the target and the staged file has (or will have, once the plan lands)
   * the target — so the remaining step is a reboot, which this tool never performs.
   */
  rebootRequired: boolean;
}

export function assessNode(input: {
  node: string;
  cmdline: string;
  grubText: string | null;
  overriddenBy?: readonly string[];
  target: GttTarget;
  console?: string;
  iHaveConsole: boolean;
}): NodeBootParamAssessment {
  const live = classifyParams(input.cmdline, input.target);
  const overriddenBy = input.overriddenBy ?? [];
  const plan = planGrubCmdlineEdit(input.grubText, input.target, overriddenBy);
  const menu = input.grubText === null ? undefined : readGrubMenuPolicy(input.grubText);

  let staged: NodeBootParamAssessment['staged'];
  if (input.grubText === null) staged = { kind: 'unreadable', why: 'no /etc/default/grub' };
  else {
    const found = readGrubCmdlineDefault(input.grubText);
    if (found.kind === 'ok') staged = { kind: 'parsed', presence: classifyParams(found.value, input.target) };
    else if (found.kind === 'missing') staged = { kind: 'unreadable', why: `no ${CMDLINE_DEFAULT_KEY} line` };
    else staged = { kind: 'unreadable', why: found.why };
  }

  const gate = consoleGate({ nodeName: input.node, menu, console: input.console, iHaveConsole: input.iHaveConsole });
  const stagedFull = staged.kind === 'parsed' && staged.presence.state === 'full';
  const willBeStaged = stagedFull || (plan.kind === 'edit' && gate.allowed);
  return { node: input.node, target: input.target, live, staged, menu, plan, gate, rebootRequired: live.state !== 'full' && willBeStaged };
}

// ─── Remote read and write ─────────────────────────────────────────────────────────────────────────

const MARK = {
  cmdline: '---CIHUB_BOOT_CMDLINE---',
  grub: '---CIHUB_BOOT_GRUB_DEFAULT---',
  sha: '---CIHUB_BOOT_GRUB_SHA256---',
  overrides: '---CIHUB_BOOT_GRUB_OVERRIDES---',
  updateGrub: '---CIHUB_BOOT_UPDATE_GRUB---',
  end: '---CIHUB_BOOT_END---',
} as const;

const NO_GRUB_DEFAULT = 'CIHUB_NO_GRUB_DEFAULT';

/**
 * One round trip reads everything the assessment needs. No `sudo`: `/proc/cmdline` and
 * `/etc/default/grub` are world-readable on every distribution this fleet runs.
 *
 * The file is followed by an `echo` so a final line without a newline cannot swallow the next marker;
 * the parser removes exactly that one newline. The SHA-256 travels alongside so the write can refuse
 * if the file changed between this read and the edit.
 */
export const BOOT_PARAM_PROBE_SCRIPT = [
  `echo "${MARK.cmdline}"`,
  'cat /proc/cmdline 2>/dev/null || true',
  `echo "${MARK.grub}"`,
  `if [ -f /etc/default/grub ]; then cat /etc/default/grub; echo; else echo "${NO_GRUB_DEFAULT}"; fi`,
  `echo "${MARK.sha}"`,
  '[ -f /etc/default/grub ] && sha256sum /etc/default/grub 2>/dev/null | cut -d" " -f1 || true',
  `echo "${MARK.overrides}"`,
  `grep -ls "^${CMDLINE_DEFAULT_KEY}=" /etc/default/grub.d/*.cfg 2>/dev/null || true`,
  `echo "${MARK.updateGrub}"`,
  'command -v update-grub >/dev/null 2>&1 && echo yes || echo no',
  `echo "${MARK.end}"`,
  'true',
].join('; ');

export interface BootParamProbe {
  cmdline: string;
  /** Null when `/etc/default/grub` does not exist. */
  grubText: string | null;
  grubSha256?: string;
  /** `/etc/default/grub.d/*.cfg` files that also assign the default cmdline. */
  overriddenBy: string[];
  hasUpdateGrub: boolean;
}

export function parseBootParamProbe(out: string): BootParamProbe | null {
  const section = (start: string, end: string): string | null => {
    const a = out.indexOf(start);
    const b = out.indexOf(end);
    if (a < 0 || b < 0 || b < a) return null;
    return out.slice(a + start.length, b).replace(/^\n/, '');
  };
  const cmdline = section(MARK.cmdline, MARK.grub);
  const grubRaw = section(MARK.grub, MARK.sha);
  const sha = section(MARK.sha, MARK.overrides);
  const overrides = section(MARK.overrides, MARK.updateGrub);
  const updateGrub = section(MARK.updateGrub, MARK.end);
  if (cmdline === null || grubRaw === null || overrides === null || updateGrub === null) return null;

  let grubText: string | null;
  if (grubRaw.trim() === NO_GRUB_DEFAULT) grubText = null;
  else grubText = grubRaw.replace(/\n$/, '');
  const shaValue = (sha ?? '').trim();
  return {
    cmdline: cmdline.trim(),
    grubText,
    grubSha256: /^[0-9a-f]{64}$/.test(shaValue) ? shaValue : undefined,
    overriddenBy: overrides
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    hasUpdateGrub: updateGrub.trim() === 'yes',
  };
}

export async function readBootParamState(target: SshTarget, timeoutMs = 25_000): Promise<{ probe: BootParamProbe | null; error?: string }> {
  const result = await sshCapture(target, BOOT_PARAM_PROBE_SCRIPT, timeoutMs);
  const probe = parseBootParamProbe(result.out);
  if (probe) return { probe };
  return { probe: null, error: result.err || `ssh exited ${result.code} without a readable boot-param probe` };
}

const HEREDOC_MARK = 'CIHUB_GRUB_DEFAULT_EOF';

/**
 * The write, as one root script. What it does, in order, and what it will not do:
 *
 *   1. Refuses (exit 3) unless `/etc/default/grub` still hashes to what the probe read. The plan was
 *      computed on that text; a file another hand changed in between is not the file the dry run
 *      showed.
 *   2. Copies the file to `grub.bak-<stamp>` beside it, permissions preserved. Not under
 *      `/etc/default/grub.d/`, which grub-mkconfig would source.
 *   3. Writes the planned text in place (`cat >`, so the inode and mode survive).
 *   4. Runs `update-grub`. Without one on PATH it reports that the file is written but the boot
 *      config was NOT regenerated, exactly as CI-OS does, rather than inventing a grub-mkconfig call.
 *   5. Never reboots. The word does not appear as a command here, and a test holds it to that.
 */
export function applyBootParamsScript(input: { newText: string; expectedSha256: string }): string {
  if (!/^[0-9a-f]{64}$/.test(input.expectedSha256)) throw new RangeError('expectedSha256 must be a hex SHA-256');
  if (input.newText.split('\n').includes(HEREDOC_MARK)) throw new RangeError('planned grub text contains the heredoc marker');
  const body = input.newText.endsWith('\n') ? input.newText.slice(0, -1) : input.newText;
  return [
    'set -euo pipefail',
    'f=/etc/default/grub',
    `if ! echo "${input.expectedSha256}  $f" | sha256sum -c --status; then`,
    '  echo "boot-params-changed-underneath: $f no longer matches what the plan was computed on"',
    '  exit 3',
    'fi',
    'stamp="$(date +%Y%m%d-%H%M%S)"',
    'cp -p "$f" "$f.bak-$stamp"',
    'echo "boot-params-backup=$f.bak-$stamp"',
    `cat > "$f" <<'${HEREDOC_MARK}'`,
    body,
    HEREDOC_MARK,
    'if command -v update-grub >/dev/null 2>&1; then',
    '  update-grub',
    '  echo "boot-params-staged"',
    'else',
    '  echo "boot-params-written-no-update-grub"',
    'fi',
  ].join('\n');
}

export type BootParamApplyOutcome = 'staged' | 'written-no-update-grub' | 'changed-underneath' | 'no-sudo' | 'failed';

export interface BootParamApplyResult {
  outcome: BootParamApplyOutcome;
  detail: string;
  backupPath?: string;
  ms: number;
}

/** Run the write on one node. `sudo -n`, so a node whose sudo wants a password fails fast and says so. */
export async function applyBootParams(
  target: SshTarget,
  plan: Extract<GrubEditPlan, { kind: 'edit' }>,
  expectedSha256: string,
  timeoutMs = 5 * 60_000,
): Promise<BootParamApplyResult> {
  const script = applyBootParamsScript({ newText: plan.newText, expectedSha256 });
  const marker = 'CIHUB_BOOT_PARAMS_EOF';
  const started = Date.now();
  const result = await sshCapture(target, `sudo -n bash <<'${marker}'\n${script}\n${marker}`, timeoutMs);
  const ms = Date.now() - started;
  const combined = `${result.out}\n${result.err}`;
  const tail = (text: string) => text.split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 400);
  const backupPath = /boot-params-backup=(\S+)/.exec(result.out)?.[1];

  if (result.out.includes('boot-params-staged'))
    return { outcome: 'staged', detail: `backup at ${backupPath ?? '?'}; update-grub ran`, backupPath, ms };
  if (result.out.includes('boot-params-written-no-update-grub')) {
    return {
      outcome: 'written-no-update-grub',
      detail: `/etc/default/grub written (backup at ${backupPath ?? '?'}) but no update-grub on PATH — the boot config was NOT regenerated; run it by hand`,
      backupPath,
      ms,
    };
  }
  if (result.out.includes('boot-params-changed-underneath')) {
    return {
      outcome: 'changed-underneath',
      detail: '/etc/default/grub changed between the read and the write; nothing written — re-run to plan against the current file',
      ms,
    };
  }
  if (/sudo:.*password is required|a terminal is required/i.test(combined)) {
    return {
      outcome: 'no-sudo',
      detail: 'passwordless sudo is not available for this account, so /etc/default/grub cannot be written unattended',
      ms,
    };
  }
  return {
    outcome: 'failed',
    detail:
      result.code === null
        ? `no completion marker within ${Math.round(timeoutMs / 60_000)} minutes`
        : `exited ${result.code}: ${tail(result.err || result.out)}`,
    ms,
  };
}
