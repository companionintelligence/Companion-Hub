/**
 * Where Ollama listens, decided once and readable back.
 *
 * Three things were measured across this fleet on 2026-09-10, and each one is a way the installer's
 * previous drop-in (`companionhub.conf`, `OLLAMA_HOST=0.0.0.0:11434`) could be written correctly and
 * still not be what the node does:
 *
 *   · **systemd applies drop-ins in byte order of filename, and the last assignment wins.** On
 *     beta-red, `zzzz-bind-all.conf` (0.0.0.0) outranks `zzz-tailnet-bind.conf`, so the node binds
 *     everywhere while the tailnet-bind drop-in "is there". Six different names set OLLAMA_HOST
 *     across the fleet — `override.conf`, `10-tailnet-bind.conf`, `zzz-…`, `zzzz-…`, plus a `.bak`
 *     that systemd never reads — and nobody can say what a node binds without sorting them by hand.
 *   · **beta-1 runs Ollama as a USER-scope unit** (`ollama-local.service` under the `ci` user's
 *     `systemd --user`) with the system `ollama.service` disabled. `systemctl enable --now ollama`
 *     there starts a second daemon that collides on :11434, and every drop-in under
 *     `/etc/systemd/system/ollama.service.d/` is dead configuration.
 *   · **Some nodes bind the Tailscale address, some 0.0.0.0, some loopback.** A probe of
 *     127.0.0.1:11434 reads "no Ollama" on a healthy tailnet-bound node.
 *
 * So this module does three things, all pure and all tested against the real filenames above:
 * resolve the EFFECTIVE `OLLAMA_HOST` exactly as systemd would and name the file that won; plan a
 * consolidation into ONE canonical file that outranks every legacy name, moving the legacy setters
 * aside (never deleting them); and refuse the system-unit path when something else already owns the
 * port. The shell it emits re-derives everything on the node and then re-reads
 * `systemctl show ollama -p Environment` to prove the bind it applied is the bind systemd resolved.
 *
 * NOTHING HERE RUNS ANYTHING. The shell strings are executed by callers under an explicit
 * `--execute`; the probe script is read-only.
 */

export const OLLAMA_BIND_PORT = 11434;
import { guardInstallShell, guardRemoveShell, OLLAMA_PORT_GUARD } from './fleet-port-guard.js';

export const OLLAMA_DROPIN_DIR = '/etc/systemd/system/ollama.service.d';

/**
 * The one file cihub writes for the bind.
 *
 * The name is the load-bearing part. systemd sorts drop-ins with `strcmp` on the basename, so digits
 * sort before letters and `90-cihub-bind.conf` would lose to `override.conf` — the exact hazard the
 * CI-Engineering fleet notes record, where `10-tailnet-bind.conf` was silently overridden by
 * `override.conf` because `o` sorts after `1`. Five `z`s outrank every name seen on this fleet,
 * including `zzzz-bind-all.conf`, and any future `zzzz-<anything>.conf` as well, because `z` sorts
 * after `-`. {@link KNOWN_LEGACY_BIND_DROPINS} and its test keep that claim honest.
 */
export const CANONICAL_BIND_DROPIN = 'zzzzz-cihub-bind.conf';

/** Suffix appended to a legacy file when it is moved aside. Not `.conf`, so systemd stops reading it. */
export const DISABLED_SUFFIX_PREFIX = '.disabled-by-cihub-';

/**
 * Every filename observed setting `OLLAMA_HOST` on this fleet, plus what the installer itself used
 * to write. The canonical name must sort after all of them; a test enforces it.
 */
export const KNOWN_LEGACY_BIND_DROPINS: readonly string[] = [
  'override.conf',
  '10-tailnet-bind.conf',
  '10-ci-gpu.conf',
  'zz-ci-ollama-context.conf',
  'zzz-tailnet-bind.conf',
  'zzzz-bind-all.conf',
  'companionhub.conf',
];

export const OLLAMA_BIND_MODES = ['tailnet', 'all', 'local'] as const;
export type OllamaBindMode = (typeof OLLAMA_BIND_MODES)[number];

export type BindClass = 'all' | 'local' | 'tailnet' | 'other';

// ─── Drop-in ordering ────────────────────────────────────────────────────────

/** Byte-order comparison, which is what systemd's `strcmp` on basenames amounts to. */
export function systemdNameCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Which files systemd reads, and in what order.
 *
 * Only `*.conf` counts. `zzz-tailnet-bind.conf.bak-preclaude` sits in the directory looking like
 * configuration and is never parsed — reported as ignored so an operator reading the plan is not
 * left wondering why a file that "sets" OLLAMA_HOST had no effect.
 */
export function systemdDropinOrder(names: readonly string[]): { applied: string[]; ignored: string[] } {
  const applied = names.filter((n) => n.endsWith('.conf')).sort(systemdNameCompare);
  const ignored = names.filter((n) => !n.endsWith('.conf')).sort(systemdNameCompare);
  return { applied, ignored };
}

// ─── Parsing a unit / drop-in ────────────────────────────────────────────────

export type EnvDirective = { kind: 'set'; key: string; value: string } | { kind: 'clear' } | { kind: 'unset'; keys: string[] };

/** Join `\`-continued lines, the way systemd's config loader does before parsing. */
function logicalLines(content: string): string[] {
  const out: string[] = [];
  let pending = '';
  for (const raw of content.split(/\r?\n/)) {
    const line = pending + raw;
    if (line.endsWith('\\')) {
      pending = `${line.slice(0, -1)} `;
      continue;
    }
    pending = '';
    out.push(line);
  }
  if (pending) out.push(pending);
  return out;
}

/**
 * Shell-like word splitting for an `Environment=` value.
 *
 * `Environment="A=1 2" B=3 'C=4'` is three assignments. systemd unquotes with C-style escapes inside
 * double quotes; this handles the forms that appear in unit files without pretending to be a shell.
 */
function splitEnvWords(value: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let inWord = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < value.length) {
        current += value[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
      continue;
    }
    if (ch === '\\' && i + 1 < value.length) {
      current += value[++i];
      inWord = true;
      continue;
    }
    current += ch;
    inWord = true;
  }
  if (inWord) words.push(current);
  return words;
}

/**
 * The `[Service]` environment directives of one unit file or drop-in, in order.
 *
 * Three directives matter for "what will OLLAMA_HOST be": `Environment=K=V` assigns, an EMPTY
 * `Environment=` clears everything assigned so far (by this file AND every file before it), and
 * `UnsetEnvironment=K` removes a key at exec time. Anything outside `[Service]` is not environment.
 */
export function parseServiceEnvironment(content: string): EnvDirective[] {
  const directives: EnvDirective[] = [];
  let section = '';
  for (const raw of logicalLines(content)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1] ?? '';
      continue;
    }
    if (section !== 'Service') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'Environment') {
      if (value === '') {
        directives.push({ kind: 'clear' });
        continue;
      }
      for (const word of splitEnvWords(value)) {
        const split = word.indexOf('=');
        // systemd logs and skips an assignment with no `=`; so do we.
        if (split <= 0) continue;
        directives.push({ kind: 'set', key: word.slice(0, split), value: word.slice(split + 1) });
      }
    } else if (key === 'UnsetEnvironment') {
      if (value === '') continue;
      directives.push({ kind: 'unset', keys: splitEnvWords(value).map((w) => w.split('=')[0] ?? w) });
    }
  }
  return directives;
}

// ─── Resolving one key across the merge order ────────────────────────────────

export interface DropinFile {
  /** Basename, e.g. `override.conf`. Ordering is decided on this. */
  name: string;
  content: string;
  /** Full path when known; used for messages only. */
  path?: string;
}

export interface EnvResolution {
  /** The effective value, or undefined when nothing sets it (or something cleared it last). */
  value?: string;
  /** The file whose assignment is in effect. `(unit)` for the unit file itself. */
  setBy?: string;
  /** Every applied file that assigns the key, in merge order. */
  setters: string[];
  /** Files that wiped it after it had been set (an empty `Environment=`, or `UnsetEnvironment=`). */
  clearedBy: string[];
  /** Files systemd does not read at all (wrong suffix). */
  ignored: string[];
  /** The merge order actually used. */
  order: string[];
}

export const UNIT_FILE_LABEL = '(unit)';

/**
 * Resolve one environment key across a unit file and its drop-ins, exactly as systemd merges them:
 * unit file first, then every `*.conf` in byte order, last assignment wins, an empty `Environment=`
 * resets everything before it.
 */
export function resolveEnvironmentKey(files: readonly DropinFile[], key: string, unitFileContent?: string): EnvResolution {
  const byName = new Map(files.map((f) => [f.name, f] as const));
  const { applied, ignored } = systemdDropinOrder([...byName.keys()]);
  const sequence: Array<{ label: string; content: string }> = [];
  if (unitFileContent !== undefined) sequence.push({ label: UNIT_FILE_LABEL, content: unitFileContent });
  for (const name of applied) sequence.push({ label: name, content: byName.get(name)?.content ?? '' });

  let value: string | undefined;
  let setBy: string | undefined;
  const setters: string[] = [];
  const clearedBy: string[] = [];
  const unsetBy: string[] = [];

  for (const { label, content } of sequence) {
    for (const directive of parseServiceEnvironment(content)) {
      if (directive.kind === 'clear') {
        if (value !== undefined) clearedBy.push(label);
        value = undefined;
        setBy = undefined;
      } else if (directive.kind === 'set' && directive.key === key) {
        value = directive.value;
        setBy = label;
        if (!setters.includes(label)) setters.push(label);
      } else if (directive.kind === 'unset' && directive.keys.includes(key)) {
        // UnsetEnvironment= applies at exec time regardless of where it sits in the merge, so it
        // beats every assignment. Recorded, and the value is gone.
        unsetBy.push(label);
      }
    }
  }
  if (unsetBy.length) {
    value = undefined;
    setBy = undefined;
    clearedBy.push(...unsetBy.filter((l) => !clearedBy.includes(l)));
  }
  return { value, setBy, setters, clearedBy, ignored, order: sequence.map((s) => s.label) };
}

// ─── OLLAMA_HOST specifics ───────────────────────────────────────────────────

export interface OllamaAddress {
  host: string;
  port: number;
  /** `host:port`, the form written to the drop-in and compared everywhere. */
  address: string;
}

/**
 * `OLLAMA_HOST` accepts `0.0.0.0`, `0.0.0.0:11434`, `http://0.0.0.0:11434`, `[::]:11434`. Normalise so
 * that a comparison between what was requested and what systemd resolved is about the bind, not the
 * spelling.
 */
export function normalizeOllamaHost(raw: string | undefined): OllamaAddress {
  let text = (raw ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (text === '') text = '127.0.0.1';
  let host = text;
  let port = OLLAMA_BIND_PORT;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (v6) {
    host = `[${v6[1]}]`;
    if (v6[2]) port = Number(v6[2]);
  } else if (text.includes(':') && text.indexOf(':') === text.lastIndexOf(':')) {
    const [h, p] = text.split(':');
    host = h || '0.0.0.0';
    if (p && /^\d+$/.test(p)) port = Number(p);
  } else if (text.includes(':')) {
    // Bare IPv6 with no port.
    host = `[${text}]`;
  }
  return { host, port, address: `${host}:${port}` };
}

export function classifyBindAddress(hostOrAddress: string | undefined): BindClass {
  const { host } = normalizeOllamaHost(hostOrAddress);
  if (host === '0.0.0.0' || host === '[::]' || host === '::' || host === '') return 'all';
  if (host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)) return 'local';
  // Tailscale hands out 100.64.0.0/10 (CGNAT space): 100.64.x.x through 100.127.x.x.
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return 'tailnet';
  return 'other';
}

/** The address a bind mode asks for on a node. `tailnet` needs the node's Tailscale IPv4. */
export function bindAddressFor(mode: OllamaBindMode, tailscaleIp?: string): OllamaAddress | undefined {
  switch (mode) {
    case 'all':
      return normalizeOllamaHost('0.0.0.0');
    case 'local':
      return normalizeOllamaHost('127.0.0.1');
    case 'tailnet':
      return tailscaleIp ? normalizeOllamaHost(tailscaleIp) : undefined;
  }
}

export interface OllamaBindResolution {
  /** Normalised `host:port` in effect. Ollama's own default when nothing sets it. */
  effective: OllamaAddress;
  /** True when no applied file assigns OLLAMA_HOST (or the last word was a clear). */
  defaulted: boolean;
  setBy: string | null;
  setters: string[];
  clearedBy: string[];
  ignored: string[];
  order: string[];
  bindClass: BindClass;
  canonicalPresent: boolean;
  canonicalWins: boolean;
  /**
   * More than one file assigns OLLAMA_HOST and the canonical one is not deciding. This is beta-red:
   * `zzz-tailnet-bind.conf` and `zzzz-bind-all.conf` both present, the latter winning by one `z`.
   * A canonical file that wins over legacy setters is NOT a conflict — they are shadowed, and the
   * plan says so — because that is the steady state on a node CI-OS keeps re-creating `override.conf`.
   */
  conflict: boolean;
  /** Setters other than the winner: present, harmless, and worth knowing about. */
  shadowed: string[];
}

export function resolveOllamaBind(files: readonly DropinFile[], unitFileContent?: string): OllamaBindResolution {
  const res = resolveEnvironmentKey(files, 'OLLAMA_HOST', unitFileContent);
  const defaulted = res.value === undefined;
  const effective = normalizeOllamaHost(res.value);
  const canonicalPresent = files.some((f) => f.name === CANONICAL_BIND_DROPIN);
  const canonicalWins = res.setBy === CANONICAL_BIND_DROPIN;
  const shadowed = res.setters.filter((s) => s !== res.setBy);
  const conflict = (res.setters.length > 1 && !canonicalWins) || (canonicalPresent && !canonicalWins);
  return {
    effective,
    defaulted,
    setBy: res.setBy ?? null,
    setters: res.setters,
    clearedBy: res.clearedBy,
    ignored: res.ignored,
    order: res.order,
    bindClass: classifyBindAddress(effective.address),
    canonicalPresent,
    canonicalWins,
    conflict,
    shadowed,
  };
}

// ─── The canonical file ──────────────────────────────────────────────────────

/** Keys a drop-in assigns under `[Service]`, for deciding whether moving it aside loses anything. */
export function environmentKeysOf(content: string): string[] {
  const keys: string[] = [];
  for (const d of parseServiceEnvironment(content)) {
    if (d.kind === 'set' && !keys.includes(d.key)) keys.push(d.key);
  }
  return keys;
}

/**
 * Content of the canonical drop-in.
 *
 * `extraEnv` carries the installer's other managed settings (today: `OLLAMA_LLM_LIBRARY=vulkan` on
 * gfx1151) so the installer writes ONE file rather than a bind file and a settings file. Every line
 * is a plain `Environment="K=V"`; nothing here should ever need quoting rules.
 */
export function canonicalBindDropinContent(address: OllamaAddress, extraEnv: readonly string[] = []): string {
  const lines = [
    '# Managed by cihub fleet — the ONE file that sets OLLAMA_HOST on this node.',
    '# systemd applies drop-ins in byte order of filename and the last assignment wins; this name',
    '# sorts after every legacy file seen on the fleet (override.conf, zz-*, zzz-*, zzzz-*).',
    '# Change the bind with: cihub fleet backends --backends ollama --bind <tailnet|all|local> --execute',
    '[Service]',
    `Environment="OLLAMA_HOST=${address.address}"`,
  ];
  for (const kv of extraEnv) lines.push(`Environment="${kv}"`);
  return `${lines.join('\n')}\n`;
}

// ─── Consolidation plan ──────────────────────────────────────────────────────

export interface ConsolidationPlan {
  canonical: { name: string; path: string; content: string; action: 'write' | 'unchanged' };
  /** Legacy setters that carry nothing the canonical file does not — moved aside, never deleted. */
  disable: Array<{ name: string; to: string; why: string }>;
  /** Legacy setters that also set other keys — left in place; the canonical file outranks them. */
  shadowed: Array<{ name: string; extraKeys: string[]; why: string }>;
  /** A file that sorts AFTER the canonical one and sets or clears OLLAMA_HOST: naming cannot fix it. */
  unfixable: Array<{ name: string; why: string }>;
  /** Files in the directory systemd never reads. Listed so nobody "fixes" one by editing it. */
  ignored: string[];
  /** True when applying the plan would change nothing on disk. */
  noop: boolean;
  /** What the bind will be once applied (or is already). */
  target: OllamaAddress;
  /**
   * What the bind step does to the port guard, and whether that is work. `all` installs
   * `ollama-tailnet-guard.service` before the daemon restarts onto 0.0.0.0; the other two modes
   * remove one an earlier `all` left behind. `active` is the probe's reading, when it had one.
   */
  guard: { unit: string; action: 'install' | 'remove'; active?: boolean };
  /** One line per action, in the order they would happen. */
  summary: string[];
}

export interface ConsolidationOptions {
  /** `YYYY-MM-DD`, baked into the disabled filename. Injected so plans are reproducible in tests. */
  date: string;
  extraEnv?: readonly string[];
  dropinDir?: string;
  /**
   * `systemctl is-active` of the port guard as the probe read it (`active`, `inactive`, `failed`,
   * `unknown`). With it, a node whose canonical file is already right but whose guard is down is
   * not a no-op: the guard is the work. Without it the plan judges the files alone.
   */
  guardUnit?: string;
}

/**
 * Plan the move from N files setting OLLAMA_HOST to one.
 *
 * Idempotent: a node already carrying the canonical file with the intended content, no other
 * setter, and its guard in the state this bind wants yields `noop: true`. Re-running a fleet
 * command must be cheap.
 *
 * Moving aside is decided per file on one question: would anything be lost? A file whose every
 * `Environment=` key is also written by the canonical file (`override.conf` setting only
 * `OLLAMA_HOST`, the old `companionhub.conf` setting host + the vulkan library on a gfx1151 box) is
 * renamed to `<name>.disabled-by-cihub-<date>`. A file that also sets something else — an
 * `OLLAMA_MODELS` repoint to local NVMe, on the nodes whose NFS store hung Ollama through 77,622
 * restarts — is left exactly where it is and merely outranked. Editing another tool's file to strip
 * one line is how the next run of that tool puts it back, or drops the rest.
 */
export function planBindConsolidation(files: readonly DropinFile[], target: OllamaAddress, opts: ConsolidationOptions): ConsolidationPlan {
  const dir = opts.dropinDir ?? OLLAMA_DROPIN_DIR;
  const extraEnv = opts.extraEnv ?? [];
  const content = canonicalBindDropinContent(target, extraEnv);
  const canonicalKeys = new Set(environmentKeysOf(content));
  const existing = files.find((f) => f.name === CANONICAL_BIND_DROPIN);
  const { applied, ignored } = systemdDropinOrder(files.map((f) => f.name));
  const byName = new Map(files.map((f) => [f.name, f] as const));

  const disable: ConsolidationPlan['disable'] = [];
  const shadowed: ConsolidationPlan['shadowed'] = [];
  const unfixable: ConsolidationPlan['unfixable'] = [];

  for (const name of applied) {
    if (name === CANONICAL_BIND_DROPIN) continue;
    const file = byName.get(name);
    if (!file) continue;
    const directives = parseServiceEnvironment(file.content);
    const setsHost = directives.some((d) => d.kind === 'set' && d.key === 'OLLAMA_HOST');
    const clears = directives.some((d) => d.kind === 'clear' || (d.kind === 'unset' && d.keys.includes('OLLAMA_HOST')));
    const sortsAfter = systemdNameCompare(name, CANONICAL_BIND_DROPIN) > 0;

    if (!setsHost && !clears) continue;
    if (clears && !setsHost) {
      if (sortsAfter) {
        // An empty Environment= applied after the canonical file wipes the host it just set. No
        // rename fixes that without also changing what the file does to every other key.
        unfixable.push({
          name,
          why: `sorts after ${CANONICAL_BIND_DROPIN} and clears the environment — systemd would apply it last; remove or rename it by hand`,
        });
        continue;
      }
      // Sorting before: it wipes only what came before it, and the canonical file re-asserts the
      // host afterwards. Harmless for the bind; worth a note.
      shadowed.push({ name, extraKeys: [], why: 'contains an empty Environment= that resets earlier files; the canonical file is applied after it' });
      continue;
    }
    const keys = environmentKeysOf(file.content);
    const extra = keys.filter((k) => !canonicalKeys.has(k));
    if (extra.length === 0) {
      // Single-purpose: moving it aside is the fix whatever its position in the order — including a
      // name that sorts after the canonical file, where leaving it would let it win.
      disable.push({
        name,
        to: `${name}${DISABLED_SUFFIX_PREFIX}${opts.date}`,
        why: 'sets OLLAMA_HOST and nothing the canonical file does not — moved aside so one file decides the bind',
      });
    } else if (sortsAfter) {
      // Mixed AND later: it carries settings that must stay, and its OLLAMA_HOST will be applied
      // after ours. Naming cannot fix it, and editing another tool's file is not this tool's call.
      unfixable.push({
        name,
        why: `sorts after ${CANONICAL_BIND_DROPIN}, sets OLLAMA_HOST and also ${extra.join(', ')} — systemd would apply it last; move its OLLAMA_HOST line by hand`,
      });
    } else {
      shadowed.push({
        name,
        extraKeys: extra,
        why: `also sets ${extra.join(', ')} — left in place; its OLLAMA_HOST is outranked by ${CANONICAL_BIND_DROPIN}`,
      });
    }
  }

  // Trailing-newline-insensitive: the probe's `cat` + `echo` framing drops the file's final newline.
  const unchanged = existing !== undefined && existing.content.trimEnd() === content.trimEnd();

  // The guard is part of the bind, not a footnote to it: a 0.0.0.0 whose guard is down is the
  // exposure `all` exists to avoid, and the files alone cannot see that. Mirrors the apply shell,
  // which installs for `all` and removes for the rest — so switching modes stays coherent.
  const guardAction = classifyBindAddress(target.host) === 'all' ? 'install' : 'remove';
  const guardKnown = opts.guardUnit !== undefined && opts.guardUnit !== 'unknown';
  const guardActive = guardKnown ? opts.guardUnit === 'active' : undefined;
  const guardWork = guardActive !== undefined && (guardAction === 'install' ? !guardActive : guardActive);
  const guard: ConsolidationPlan['guard'] = { unit: OLLAMA_PORT_GUARD.unitName, action: guardAction, active: guardActive };

  const noop = unchanged && disable.length === 0 && !guardWork;
  const summary: string[] = [];
  for (const d of disable) summary.push(`move ${d.name} → ${d.to}`);
  for (const s of shadowed) summary.push(`leave ${s.name} (${s.why})`);
  for (const u of unfixable) summary.push(`CANNOT FIX ${u.name}: ${u.why}`);
  summary.push(
    unchanged
      ? `${CANONICAL_BIND_DROPIN} already sets OLLAMA_HOST=${target.address}`
      : `write ${CANONICAL_BIND_DROPIN} with OLLAMA_HOST=${target.address}`,
  );
  // In shell order: the guard goes up (or comes down) after the file is written and before the restart.
  summary.push(
    guardAction === 'install'
      ? `install ${guard.unit} (accept ${OLLAMA_PORT_GUARD.acceptInterfaces.join(',')}; reset elsewhere) before restarting${guardActive ? ' — already active' : ''}`
      : `remove ${guard.unit} ${guardActive ? '(active now; this bind does not need it)' : 'if present'}`,
  );
  for (const i of ignored) summary.push(`ignored by systemd (not *.conf): ${i}`);

  return {
    canonical: { name: CANONICAL_BIND_DROPIN, path: `${dir}/${CANONICAL_BIND_DROPIN}`, content, action: unchanged ? 'unchanged' : 'write' },
    disable,
    shadowed,
    unfixable,
    ignored,
    noop,
    target,
    guard,
    summary,
  };
}

// ─── Unit ownership ──────────────────────────────────────────────────────────

export interface PortOwner {
  pid?: number;
  user?: string;
  /** Process name as `ss -p` reported it. */
  process?: string;
  /** cgroup path from /proc/<pid>/cgroup, e.g. `/user.slice/user-1000.slice/user@1000.service/app.slice/ollama-local.service`. */
  cgroup?: string;
  /** Local address the socket is bound to, e.g. `100.124.211.75:11434` or `*:11434`. */
  address?: string;
  scope: 'system-ollama' | 'user-unit' | 'other-system-unit' | 'container' | 'unknown';
  unit?: string;
}

export interface UserUnitEvidence {
  user: string;
  unit: string;
  active: boolean;
  mainPid?: number;
  /** OLLAMA_HOST from that unit's own Environment, when the fixture carried it. */
  ollamaHost?: string;
}

export type OwnershipDecision =
  | { refuse: false; owners: PortOwner[]; userUnits: UserUnitEvidence[] }
  | { refuse: true; reason: string; owners: PortOwner[]; userUnits: UserUnitEvidence[] };

/** `ss -ltnp` rows for the port: local address plus whatever `users:(...)` disclosed. */
export function parseSsListeners(ss: string, port = OLLAMA_BIND_PORT): PortOwner[] {
  const owners: PortOwner[] = [];
  for (const line of ss.split('\n')) {
    const cols = line.trim().split(/\s+/);
    // `ss -ltn` columns: State Recv-Q Send-Q Local:Port Peer:Port [Process]. Some builds omit State
    // when filtered; find the local address by shape rather than by column index.
    const address = cols.find((c) => new RegExp(`:${port}$`).test(c));
    if (!address) continue;
    const proc = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    owners.push({
      address,
      process: proc?.[1],
      pid: proc ? Number(proc[2]) : undefined,
      scope: 'unknown',
    });
  }
  return owners;
}

function classifyCgroup(cgroup: string): { scope: PortOwner['scope']; unit?: string } {
  const segments = cgroup.split('/').filter(Boolean);
  const last = segments.at(-1);
  if (/(^|\/)user@\d+\.service(\/|$)/.test(cgroup) || segments.some((s) => /^user-\d+\.slice$/.test(s))) {
    const unit = [...segments]
      .reverse()
      .find((s) => /\.(service|scope)$/.test(s) && !/^user@\d+\.service$/.test(s) && !/^session-.*\.scope$/.test(s));
    return { scope: 'user-unit', unit: unit ?? last };
  }
  if (/(^|\/)docker(\/|-)|\.scope$/.test(cgroup) && /docker|containerd|podman|libpod/.test(cgroup)) {
    return { scope: 'container', unit: last };
  }
  if (last === 'ollama.service') return { scope: 'system-ollama', unit: last };
  if (last?.endsWith('.service')) return { scope: 'other-system-unit', unit: last };
  return { scope: 'unknown', unit: last };
}

/**
 * `owner=<pid> <user> <cgroup>` lines from the probe — one per pid `ss` attributed to the port.
 * The cgroup path is what says user unit vs system unit vs container; `ps -o unit,uunit` would say
 * the same but depends on how procps was built, and /proc/<pid>/cgroup is always there and readable.
 */
export function parseOwnerLines(lines: readonly string[]): PortOwner[] {
  const owners: PortOwner[] = [];
  for (const line of lines) {
    const m = /^(\d+)\s+(\S+)\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const cgroup = (m[3] ?? '').trim();
    const { scope, unit } = classifyCgroup(cgroup);
    owners.push({ pid: Number(m[1]), user: m[2], cgroup: cgroup || undefined, scope, unit });
  }
  return owners;
}

/**
 * Evidence about a user-scope unit from `systemctl --user [-M user@] list-units`, `status`, or
 * `show` output. All three shapes are accepted because all three are what an operator pastes.
 */
export function parseUserUnitEvidence(user: string, text: string): UserUnitEvidence[] {
  const out: UserUnitEvidence[] = [];
  const show = parseKeyValueBlock(text);
  if (show.Id) {
    out.push({
      user,
      unit: show.Id,
      active: show.ActiveState === 'active',
      mainPid: show.MainPID ? Number(show.MainPID) : undefined,
      ollamaHost: parseShowEnvironment(`Environment=${show.Environment ?? ''}`).OLLAMA_HOST,
    });
    return out;
  }
  // `systemctl status` shape.
  const header = /^[●○×*]?\s*(\S+\.service)\b/m.exec(text);
  if (header && /^\s*Active:/m.test(text)) {
    const active = /^\s*Active:\s*active/m.test(text);
    const pid = /^\s*Main PID:\s*(\d+)/m.exec(text);
    out.push({ user, unit: header[1] as string, active, mainPid: pid ? Number(pid[1]) : undefined });
    return out;
  }
  // `list-units --no-legend --plain` shape: UNIT LOAD ACTIVE SUB DESCRIPTION.
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || !cols[0]?.endsWith('.service')) continue;
    out.push({ user, unit: cols[0], active: cols[2] === 'active' });
  }
  return out;
}

export interface OwnershipInput {
  /** `ss -ltnp` output (whole, or already filtered to the port). */
  ss?: string;
  /** `owner=` lines from the probe, without the prefix. */
  owners?: readonly string[];
  /** Per-user output of `systemctl --user [-M user@] …` about ollama units. */
  userUnits?: ReadonlyArray<{ user: string; text: string }>;
  port?: number;
}

/**
 * May the installer touch the SYSTEM `ollama.service` on this node?
 *
 * Refused when the port already belongs to something the system unit is not: a user-scope unit
 * (beta-1), a container, or another system unit. In each case `systemctl enable --now ollama`
 * would start a second daemon that fails to bind — and, worse, restart-loop under systemd's
 * `Restart=always` while the drop-ins the installer just wrote configure a service that is not the
 * one serving. The reason is one sentence because it is printed on one line of a fleet report.
 */
export function decideSystemUnitOwnership(input: OwnershipInput): OwnershipDecision {
  const port = input.port ?? OLLAMA_BIND_PORT;
  const fromSs = parseSsListeners(input.ss ?? '', port);
  const fromCgroups = parseOwnerLines(input.owners ?? []);
  // Merge: the cgroup line knows the scope, the ss line knows the address.
  const owners: PortOwner[] = fromCgroups.map((o) => {
    const socket = fromSs.find((s) => s.pid === o.pid);
    return { ...o, address: socket?.address, process: socket?.process };
  });
  for (const s of fromSs) {
    if (s.pid === undefined || !owners.some((o) => o.pid === s.pid)) owners.push(s);
  }
  const userUnits = (input.userUnits ?? []).flatMap((u) => parseUserUnitEvidence(u.user, u.text)).filter((u) => /ollama/i.test(u.unit));

  const userOwner = owners.find((o) => o.scope === 'user-unit');
  if (userOwner) {
    const who = /^session-/.test(userOwner.unit ?? '')
      ? `a process in ${userOwner.user ?? '?'}'s login session (${userOwner.unit}, pid ${userOwner.pid} — a hand-started \`ollama serve\`?)`
      : `${userOwner.unit ?? 'a user-scope unit'} under ${userOwner.user ?? '?'}'s systemd --user (pid ${userOwner.pid})`;
    return {
      refuse: true,
      reason: `${who} already owns :${port}; enabling the system ollama.service would start a second daemon that collides on the port, and its drop-ins would configure a service that is not the one serving`,
      owners,
      userUnits,
    };
  }
  const container = owners.find((o) => o.scope === 'container');
  if (container) {
    return {
      refuse: true,
      reason: `:${port} is served by a container (${container.process ?? container.unit ?? `pid ${container.pid}`}); the system ollama.service is not what answers here and enabling it would collide on the port`,
      owners,
      userUnits,
    };
  }
  const other = owners.find((o) => o.scope === 'other-system-unit');
  if (other) {
    return {
      refuse: true,
      reason: `:${port} is owned by ${other.unit} (pid ${other.pid}), not ollama.service; not touching a listener this installer does not manage`,
      owners,
      userUnits,
    };
  }
  const activeUser = userUnits.find((u) => u.active);
  if (activeUser) {
    return {
      refuse: true,
      reason: `${activeUser.unit} is running under ${activeUser.user}'s systemd --user${activeUser.ollamaHost ? ` (OLLAMA_HOST=${activeUser.ollamaHost})` : ''}; the system ollama.service path would start a second daemon and collide on :${port}`,
      owners,
      userUnits,
    };
  }
  return { refuse: false, owners, userUnits };
}

// ─── Reading back what systemd resolved ──────────────────────────────────────

/** `Key=Value` lines, as `systemctl show` prints them. */
export function parseKeyValueBlock(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * `systemctl show <unit> -p Environment` prints `Environment=A=1 B=2 "C=x y"` — space-separated,
 * quoted where needed. This is the merged result after every drop-in, i.e. the one value that is
 * the truth about what the service will get, which is why the post-restart check reads it.
 */
export function parseShowEnvironment(showOutput: string): Record<string, string> {
  const env: Record<string, string> = {};
  const line = showOutput
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('Environment='));
  if (!line) return env;
  for (const word of splitEnvWords(line.slice('Environment='.length))) {
    const eq = word.indexOf('=');
    if (eq <= 0) continue;
    env[word.slice(0, eq)] = word.slice(eq + 1);
  }
  return env;
}

export interface BindVerification {
  ok: boolean;
  requested: OllamaAddress;
  effective?: OllamaAddress;
  why: string;
}

/**
 * Did the bind we asked for become the bind systemd resolved?
 *
 * Compared after normalisation, so `0.0.0.0` and `0.0.0.0:11434` agree. Anything else is a
 * mismatch and the install step fails, naming both values — the state this function exists to make
 * impossible is "the drop-in is there" while the node binds something else.
 */
export function verifyEffectiveBind(showOutput: string, requested: OllamaAddress, dropInPaths?: string): BindVerification {
  const env = parseShowEnvironment(showOutput);
  if (env.OLLAMA_HOST === undefined) {
    return {
      ok: false,
      requested,
      why: `requested OLLAMA_HOST=${requested.address} but systemd resolved no OLLAMA_HOST at all${dropInPaths ? ` (drop-ins: ${dropInPaths})` : ''} — a later drop-in clears it, or daemon-reload did not run`,
    };
  }
  const effective = normalizeOllamaHost(env.OLLAMA_HOST);
  if (effective.address === requested.address) {
    return { ok: true, requested, effective, why: `OLLAMA_HOST=${effective.address}` };
  }
  return {
    ok: false,
    requested,
    effective,
    why: `requested OLLAMA_HOST=${requested.address} but systemd resolved ${effective.address}${dropInPaths ? ` (drop-ins in merge order: ${dropInPaths})` : ''} — a drop-in sorting after ${CANONICAL_BIND_DROPIN} is overriding it`,
  };
}

// ─── Remote scripts ──────────────────────────────────────────────────────────

export const BIND_PROBE_MARKER = 'bind_probe=1';
export const DROPIN_BEGIN = '===DROPIN ';
export const DROPIN_END = '===END===';

/**
 * Read-only dump of everything the assessment needs, in one round trip.
 *
 * Every line is `key=value`; drop-in bodies are fenced. Nothing here needs root: the drop-in
 * directory is world-readable, `systemctl show` answers anyone, and `ss -p` simply omits the pid
 * for processes the caller may not inspect (the owner line is then absent, and the assessment says
 * "unknown" rather than guessing).
 */
export function ollamaBindProbeScript(dropinDir = OLLAMA_DROPIN_DIR): string {
  return [
    `echo "${BIND_PROBE_MARKER}"`,
    'frag="$(systemctl show ollama -p FragmentPath --value 2>/dev/null || true)"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion in the generated script.
    'echo "unit_file=${frag:-none}"',
    'systemctl show ollama -p ActiveState -p UnitFileState -p MainPID -p NeedDaemonReload -p DropInPaths -p Environment 2>/dev/null | sed "s/^/show:/" || true',
    'echo "tailscale_ip=$(tailscale ip -4 2>/dev/null | head -1)"',
    `echo "guard_unit=$(systemctl is-active ${OLLAMA_PORT_GUARD.unitName} 2>/dev/null || echo inactive)"`,
    `ss -ltnp 2>/dev/null | awk '$4 ~ /:${OLLAMA_BIND_PORT}$/ {print "ss=" $0}'`,
    `for pid in $(ss -ltnp 2>/dev/null | awk '$4 ~ /:${OLLAMA_BIND_PORT}$/' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do echo "owner=$pid $(stat -c %U /proc/$pid 2>/dev/null || echo '?') $(tail -1 /proc/$pid/cgroup 2>/dev/null | cut -d: -f3-)"; done`,
    'me="$(id -un 2>/dev/null)"',
    'systemctl --user list-units --type=service --no-legend --plain 2>/dev/null | awk -v u="$me" \'tolower($0) ~ /ollama/ {print "user_unit=" u " " $0}\'',
    'for u in $(loginctl list-users --no-legend 2>/dev/null | awk \'{print $2}\'); do [ "$u" = "$me" ] && continue; systemctl --user -M "$u@" list-units --type=service --no-legend --plain 2>/dev/null | awk -v u="$u" \'tolower($0) ~ /ollama/ {print "user_unit=" u " " $0}\'; done',
    `d='${dropinDir}'`,
    'if [ -d "$d" ]; then for f in "$d"/*; do [ -e "$f" ] || continue; echo "dir_entry=$(basename "$f")"; done; fi',
    `for f in "$d"/*.conf; do [ -f "$f" ] || continue; echo "${DROPIN_BEGIN}$f==="; cat "$f"; echo; echo "${DROPIN_END}"; done`,
    'true',
  ].join('\n');
}

export interface OllamaBindProbe {
  /** The marker line arrived — the script ran at all. */
  present: boolean;
  unitFile: string | null;
  show: Record<string, string>;
  tailscaleIp?: string;
  /** `systemctl is-active` of the port guard. A RemainAfterExit oneshot whose rules failed is `failed`, not `active`, so this is evidence, not a hint. */
  guard: { unit: string };
  ss: string[];
  ownerLines: string[];
  userUnits: Array<{ user: string; text: string }>;
  dirEntries: string[];
  dropins: DropinFile[];
}

export function parseOllamaBindProbe(out: string): OllamaBindProbe {
  const probe: OllamaBindProbe = {
    present: false,
    unitFile: null,
    guard: { unit: 'unknown' },
    show: {},
    ss: [],
    ownerLines: [],
    userUnits: [],
    dirEntries: [],
    dropins: [],
  };
  const lines = out.split('\n');
  const perUser = new Map<string, string[]>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith(DROPIN_BEGIN)) {
      const path = line.slice(DROPIN_BEGIN.length).replace(/===$/, '');
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i] !== DROPIN_END) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      probe.dropins.push({ name: path.split('/').pop() ?? path, path, content: body.join('\n').replace(/\n$/, '') });
      continue;
    }
    if (line === BIND_PROBE_MARKER) {
      probe.present = true;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'unit_file') probe.unitFile = value === 'none' || value === '' ? null : value;
    else if (key.startsWith('show:')) probe.show[key.slice(5)] = value;
    else if (key === 'tailscale_ip') probe.tailscaleIp = value.trim() || undefined;
    else if (key === 'guard_unit') probe.guard.unit = value.trim() || 'unknown';
    else if (key === 'ss') probe.ss.push(value);
    else if (key === 'owner') probe.ownerLines.push(value);
    else if (key === 'dir_entry') probe.dirEntries.push(value);
    else if (key === 'user_unit') {
      const [user, ...rest] = value.split(' ');
      if (!user) continue;
      const list = perUser.get(user) ?? [];
      list.push(rest.join(' '));
      perUser.set(user, list);
    }
  }
  for (const [user, rows] of perUser) probe.userUnits.push({ user, text: rows.join('\n') });
  return probe;
}

export type BindStatus = 'managed' | 'conflict' | 'unmanaged' | 'default' | 'user-scope' | 'foreign-owner' | 'no-unit' | 'unknown';

export interface OllamaBindAssessment {
  status: BindStatus;
  /** From the files, as systemd would merge them. */
  resolution: OllamaBindResolution;
  /** OLLAMA_HOST as `systemctl show` reports it — the loaded truth. Absent when the unit is absent. */
  live?: OllamaAddress;
  /** False when the files and the loaded unit disagree: a daemon-reload is pending. */
  liveMatchesFiles: boolean;
  needDaemonReload: boolean;
  systemUnit?: { active: string; enabled: string; mainPid?: number };
  sockets: string[];
  ownership: OwnershipDecision;
  tailscaleIp?: string;
  /** Legacy setters present but outranked — informational. */
  shadowed: string[];
  /** The guard that makes a 0.0.0.0 bind tailnet-only in practice. */
  guard: { unit: string };
  /** Bound on every interface with no active guard: reachable from the LAN. The thing to fix first. */
  exposed: boolean;
  /** One cell for the status table. */
  summary: string;
}

/**
 * Everything `fleet status` prints about the bind, from one probe. Read-only by construction.
 *
 * The cell names the effective bind AND the file that set it, because "what does this node bind"
 * was the question nobody could answer without resolving the merge order by hand.
 */
export function assessOllamaBind(probe: OllamaBindProbe): OllamaBindAssessment {
  // Files systemd will read, in the dir, plus anything the directory listing says is being ignored.
  const files = [...probe.dropins];
  const dirOnly = probe.dirEntries.filter((n) => !files.some((f) => f.name === n));
  for (const n of dirOnly) files.push({ name: n, content: '' });
  const resolution = resolveOllamaBind(files);
  const ownership = decideSystemUnitOwnership({ ss: probe.ss.join('\n'), owners: probe.ownerLines, userUnits: probe.userUnits });
  const sockets = parseSsListeners(probe.ss.join('\n'))
    .map((o) => o.address ?? '')
    .filter(Boolean);
  const liveEnv = probe.show.Environment === undefined ? {} : parseShowEnvironment(`Environment=${probe.show.Environment}`);
  const live = probe.unitFile ? normalizeOllamaHost(liveEnv.OLLAMA_HOST) : undefined;
  const needDaemonReload = probe.show.NeedDaemonReload === 'yes';
  const liveMatchesFiles = live ? live.address === resolution.effective.address : true;
  const systemUnit = probe.unitFile
    ? {
        active: probe.show.ActiveState ?? '?',
        enabled: probe.show.UnitFileState ?? '?',
        mainPid: probe.show.MainPID ? Number(probe.show.MainPID) : undefined,
      }
    : undefined;

  let status: BindStatus;
  if (!probe.present) status = 'unknown';
  else if (ownership.refuse)
    status = ownership.owners.some((o) => o.scope === 'user-unit') || ownership.userUnits.some((u) => u.active) ? 'user-scope' : 'foreign-owner';
  else if (!probe.unitFile) status = 'no-unit';
  else if (resolution.conflict) status = 'conflict';
  else if (resolution.canonicalWins) status = 'managed';
  else if (resolution.defaulted) status = 'default';
  else status = 'unmanaged';

  const flags: string[] = [];
  if (status === 'conflict') flags.push(`CONFLICT ${resolution.setters.length} files set it: ${resolution.setters.join(' < ')}`);
  if (status === 'unmanaged') flags.push('unmanaged');
  if (needDaemonReload || !liveMatchesFiles) flags.push(`reload pending (loaded ${live?.address ?? 'unset'})`);
  if (resolution.shadowed.length && status === 'managed') flags.push(`shadows ${resolution.shadowed.join(', ')}`);

  const bindsAll = classifyBindAddress((live ?? resolution.effective).host) === 'all';
  const guardUp = probe.guard.unit === 'active';
  const exposed = bindsAll && !guardUp && status !== 'unknown' && status !== 'no-unit';

  let summary: string;
  if (status === 'unknown') summary = 'not probed';
  else if (status === 'user-scope' || status === 'foreign-owner') {
    const owner = ownership.owners.find((o) => o.scope !== 'system-ollama') ?? ownership.owners[0];
    const unit = owner?.unit ?? ownership.userUnits.find((u) => u.active)?.unit ?? 'unknown unit';
    const who = owner?.user ?? ownership.userUnits.find((u) => u.active)?.user;
    summary = `${status === 'user-scope' ? 'user-scope' : 'foreign'} ${unit}${who ? ` (${who})` : ''}${sockets.length ? ` binds ${sockets.join(',')}` : ''}${systemUnit ? ` — system unit ${systemUnit.active}/${systemUnit.enabled}` : ''}`;
  } else if (status === 'no-unit') {
    summary = sockets.length ? `no ollama.service; :${OLLAMA_BIND_PORT} held at ${sockets.join(',')}` : 'no ollama.service';
  } else {
    const shown = live ?? resolution.effective;
    const source = resolution.defaulted ? 'default, no drop-in sets it' : `← ${resolution.setBy}`;
    if (classifyBindAddress(shown.host) === 'all') flags.unshift(exposed ? 'EXPOSED — no guard' : 'guarded');
    summary = `${shown.address} ${source}${flags.length ? `  [${flags.join('; ')}]` : ''}`;
  }

  return {
    status,
    resolution,
    live,
    liveMatchesFiles,
    needDaemonReload,
    systemUnit,
    sockets,
    ownership,
    tailscaleIp: probe.tailscaleIp,
    shadowed: resolution.shadowed,
    guard: probe.guard,
    exposed,
    summary,
  };
}

// ─── The apply script ────────────────────────────────────────────────────────

/** Output markers the apply script prints. Callers key outcomes on these, never on exit codes alone. */
export const BIND_MARKERS = {
  refused: 'ollama-bind-refused:',
  failed: 'ollama-bind-failed:',
  mismatch: 'ollama-bind-mismatch:',
  disabled: 'ollama-bind-disabled:',
  shadowed: 'ollama-bind-shadowed:',
  effective: 'ollama-bind-effective:',
  guarded: 'ollama-bind-guarded:',
  unguarded: 'ollama-bind-unguarded:',
  complete: 'ollama-bind-complete',
} as const;

/**
 * The ownership guard as shell, for the top of the install script — BEFORE `install.sh` runs,
 * because ollama.com's installer itself runs `systemctl enable ollama && systemctl restart ollama`
 * on a systemd box. On beta-1 that alone would start the colliding second daemon.
 *
 * Prints a `ollama-bind-refused:` line and exits 0: the outcome is decided by the marker, and a
 * refusal is a fact about the machine, not a failed install.
 */
export function ollamaOwnershipGuardShell(): string {
  return [
    `for pid in $(ss -ltnp 2>/dev/null | awk '$4 ~ /:${OLLAMA_BIND_PORT}$/' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do`,
    '  cg="$(tail -1 /proc/$pid/cgroup 2>/dev/null | cut -d: -f3-)"',
    '  who="$(stat -c %U /proc/$pid 2>/dev/null || echo \'?\')"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion in the generated script.
    '  unit="${cg##*/}"',
    '  case "$cg" in',
    `    *user@*|*/user-*.slice/*) echo "${BIND_MARKERS.refused} $unit under $who's systemd --user (pid $pid) already owns :${OLLAMA_BIND_PORT}; enabling the system ollama.service would start a second daemon that collides on the port"; exit 0 ;;`,
    `    *docker*|*containerd*|*libpod*) echo "${BIND_MARKERS.refused} :${OLLAMA_BIND_PORT} is served by a container (cgroup $cg); the system ollama.service is not what answers here"; exit 0 ;;`,
    '    */ollama.service|"") : ;;',
    `    *) echo "${BIND_MARKERS.refused} :${OLLAMA_BIND_PORT} is owned by $unit (pid $pid), not ollama.service; not touching a listener this installer does not manage"; exit 0 ;;`,
    '  esac',
    'done',
    // A running user unit whose pid ss would not disclose (probe not root). Ask the user managers.
    "for u in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $2}'); do",
    '  uu="$(systemctl --user -M "$u@" list-units --type=service --state=active --no-legend --plain 2>/dev/null | awk \'tolower($1) ~ /ollama/ {print $1; exit}\')"',
    `  [ -n "$uu" ] && { echo "${BIND_MARKERS.refused} $uu is running under $u's systemd --user; the system ollama.service path would start a second daemon and collide on :${OLLAMA_BIND_PORT}"; exit 0; }`,
    'done',
  ].join('\n');
}

/**
 * The one precondition worth failing on before anything is downloaded: `tailnet` needs a tailnet
 * address. Empty for the other modes. The apply shell checks again; this is the early exit.
 */
export function ollamaBindPreflightShell(mode: OllamaBindMode): string {
  if (mode !== 'tailnet') return ': # bind preflight: nothing to check for this mode';
  return `[ -n "$(tailscale ip -4 2>/dev/null | head -1)" ] || { echo "${BIND_MARKERS.failed} --bind tailnet needs a tailnet address and 'tailscale ip -4' returned nothing on this node; pass --bind all or --bind local" >&2; exit 1; }`;
}

export interface BindApplyOptions {
  extraEnv?: readonly string[];
  /** Skip `systemctl enable`; only restart. For the adopt path, where the unit is already up. */
  enable?: boolean;
}

/**
 * Apply the bind policy on a node. Runs as root. Idempotent.
 *
 * In order: resolve the requested address (`tailscale ip -4` for `tailnet`, and FAIL rather than
 * fall back when the node has none — a silent fallback to 0.0.0.0 is how one policy becomes three);
 * move aside every `*.conf` that sets OLLAMA_HOST and nothing else, naming each; write the canonical
 * file; `daemon-reload`; enable and restart; then re-read `systemctl show ollama -p Environment`
 * and fail loudly if the merged value is not the requested one.
 *
 * `CIHUB_BIND_DIR` is overridable through the environment purely so the script can be exercised in
 * a sandbox; `sudo` resets the environment, so on a node the default always applies.
 */
export function ollamaBindApplyShell(mode: OllamaBindMode, opts: BindApplyOptions = {}): string {
  const extraEnv = opts.extraEnv ?? [];
  const enable = opts.enable ?? true;
  const canonicalKeys = ['OLLAMA_HOST', ...extraEnv.map((kv) => kv.split('=')[0] ?? kv)];
  const lines: string[] = [
    `cihub_bind_dir="\${CIHUB_BIND_DIR:-${OLLAMA_DROPIN_DIR}}"`,
    `cihub_bind_file='${CANONICAL_BIND_DROPIN}'`,
    'cihub_bind_stamp="$(date +%Y-%m-%d)"',
    `cihub_bind_norm() { printf '%s' "$1" | sed -E 's#^https?://##; s#/+$##; s#:${OLLAMA_BIND_PORT}$##'; }`,
  ];
  switch (mode) {
    case 'tailnet':
      lines.push(
        'cihub_bind_host="$(tailscale ip -4 2>/dev/null | head -1)"',
        `[ -n "$cihub_bind_host" ] || { echo "${BIND_MARKERS.failed} --bind tailnet needs a tailnet address and 'tailscale ip -4' returned nothing on this node; pass --bind all or --bind local" >&2; exit 1; }`,
      );
      break;
    case 'all':
      lines.push("cihub_bind_host='0.0.0.0'");
      break;
    case 'local':
      lines.push("cihub_bind_host='127.0.0.1'");
      break;
  }
  lines.push(
    `cihub_bind_addr="$cihub_bind_host:${OLLAMA_BIND_PORT}"`,
    'install -d -m 0755 "$cihub_bind_dir"',
    // Move aside, never delete. A file that also sets something else is left where it is: it loses
    // on name, and editing another tool's file is how that tool's next run puts the line back.
    'for f in "$cihub_bind_dir"/*.conf; do',
    '  [ -f "$f" ] || continue',
    '  b="$(basename "$f")"',
    '  [ "$b" = "$cihub_bind_file" ] && continue',
    '  grep -qE \'^[[:space:]]*Environment=.*OLLAMA_HOST=\' "$f" || continue',
    `  others="$(grep -E '^[[:space:]]*Environment=' "$f" | grep -oE '[A-Za-z_][A-Za-z0-9_]*=' | tr -d = | grep -vx Environment | sort -u | grep -vx ${canonicalKeys.map((k) => `-e '${k}'`).join(' ')} || true)"`,
    '  if [ -z "$others" ]; then',
    '    mv "$f" "$f.disabled-by-cihub-$cihub_bind_stamp"',
    `    echo "${BIND_MARKERS.disabled} $b → $b.disabled-by-cihub-$cihub_bind_stamp"`,
    '  else',
    `    echo "${BIND_MARKERS.shadowed} $b also sets $(echo "$others" | tr '\\n' ' ')— left in place, outranked by $cihub_bind_file"`,
    '  fi',
    'done',
    'cat >"$cihub_bind_dir/$cihub_bind_file" <<CIHUB_BIND_EOF',
    '# Managed by cihub fleet — the ONE file that sets OLLAMA_HOST on this node.',
    '# systemd applies drop-ins in byte order of filename and the last assignment wins; this name',
    '# sorts after every legacy file seen on the fleet (override.conf, zz-*, zzz-*, zzzz-*).',
    '# Change the bind with: cihub fleet backends --backends ollama --bind <tailnet|all|local> --execute',
    '[Service]',
    'Environment="OLLAMA_HOST=$cihub_bind_addr"',
  );
  for (const kv of extraEnv) lines.push(`Environment="${kv}"`);
  lines.push(
    'CIHUB_BIND_EOF',
    'systemctl daemon-reload',
    enable ? 'systemctl enable ollama >/dev/null 2>&1 || true' : ': # adopt path: unit already enabled by whoever set it up',
  );
  // `all` is only acceptable behind the guard, and the guard goes up BEFORE the daemon restarts onto
  // 0.0.0.0 so there is no window where the LAN can reach it. A guard that fails to install fails the
  // bind — a 0.0.0.0 with no guard is the exposure this mode exists to avoid. The other two modes do
  // not need it and remove one left behind by an earlier `all`, so switching modes is coherent.
  lines.push(
    ...(mode === 'all'
      ? guardInstallShell(OLLAMA_PORT_GUARD, {
          heredocTag: 'CIHUB_OLLAMA_GUARD_EOF',
          okMarker: BIND_MARKERS.guarded,
          failMarker: BIND_MARKERS.failed,
        })
      : guardRemoveShell(OLLAMA_PORT_GUARD, { marker: BIND_MARKERS.unguarded })),
    'systemctl restart ollama',
    // Re-read what systemd merged. This is the check the whole file exists for.
    // `Environment=` is stripped first: the merged list often begins with OLLAMA_HOST itself, and a
    // parse that only splits on spaces misses a value glued to the property name.
    "cihub_bind_eff=\"$(systemctl show ollama -p Environment 2>/dev/null | sed 's/^Environment=//' | tr ' ' '\\n' | sed -n 's/^\"\\{0,1\\}OLLAMA_HOST=//p' | tr -d '\"' | head -1)\"",
    'if [ "$(cihub_bind_norm "$cihub_bind_eff")" != "$(cihub_bind_norm "$cihub_bind_addr")" ]; then',
    `  echo "${BIND_MARKERS.mismatch} requested OLLAMA_HOST=$cihub_bind_addr but systemd resolved '\${cihub_bind_eff:-<unset>}' (drop-ins in merge order: $(systemctl show ollama -p DropInPaths --value 2>/dev/null))" >&2`,
    '  exit 1',
    'fi',
    // The socket, informationally: Ollama takes a moment to bind after restart.
    `for i in 1 2 3 4 5 6 7 8 9 10; do ss -ltn 2>/dev/null | awk '$4 ~ /:${OLLAMA_BIND_PORT}$/' | grep -q . && break; sleep 1; done`,
    `echo "${BIND_MARKERS.effective} OLLAMA_HOST=$cihub_bind_eff listening=$(ss -ltn 2>/dev/null | awk '$4 ~ /:${OLLAMA_BIND_PORT}$/ {print $4}' | paste -sd, - )"`,
    `echo "${BIND_MARKERS.complete}"`,
  );
  return lines.join('\n');
}

/**
 * Classify the output of a script that embedded {@link ollamaBindApplyShell}.
 *
 * Markers, not exit codes: a refusal exits 0 by design, and a mismatch exits 1 with a sentence that
 * is far more useful than "exited 1".
 */
export function classifyBindApplyOutput(
  out: string,
  err: string,
): { outcome: 'applied' | 'refused' | 'mismatch' | 'failed' | 'incomplete'; why: string; detail: string[] } {
  const text = `${out}\n${err}`;
  const lines = text.split('\n').map((l) => l.trim());
  const pick = (marker: string) =>
    lines
      .find((l) => l.startsWith(marker))
      ?.slice(marker.length)
      .trim();
  const detail = lines.filter(
    (l) =>
      l.startsWith(BIND_MARKERS.disabled) ||
      l.startsWith(BIND_MARKERS.shadowed) ||
      l.startsWith(BIND_MARKERS.guarded) ||
      l.startsWith(BIND_MARKERS.unguarded),
  );
  const refused = pick(BIND_MARKERS.refused);
  if (refused) return { outcome: 'refused', why: refused, detail };
  const mismatch = pick(BIND_MARKERS.mismatch);
  if (mismatch) return { outcome: 'mismatch', why: mismatch, detail };
  const failed = pick(BIND_MARKERS.failed);
  if (failed) return { outcome: 'failed', why: failed, detail };
  if (lines.includes(BIND_MARKERS.complete)) {
    return { outcome: 'applied', why: pick(BIND_MARKERS.effective) ?? 'bind applied', detail };
  }
  return { outcome: 'incomplete', why: 'the bind step produced no completion marker', detail };
}
