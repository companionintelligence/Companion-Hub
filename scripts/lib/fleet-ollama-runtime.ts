/**
 * Ollama's runtime environment — parallelism, keep-alive, context, iGPU — in a file of its own.
 *
 * Measured on the 2026-09-20 fleet: no node sets `OLLAMA_NUM_PARALLEL`, so every Ollama serves ONE
 * sequence at a time and the pool's ceiling is the sum of fifteen single streams (~450-550 tok/s on
 * qwen3-coder:30b). Raising it is the only lever that lifts that ceiling, and the same file is where
 * `OLLAMA_KEEP_ALIVE` (so a spill lands on a warm peer instead of a 60-108 s reload),
 * `OLLAMA_CONTEXT_LENGTH` (a node whose default context is too large for its GTT spills to CPU with
 * HTTP 200s) and `OLLAMA_IGPU_ENABLE` (3-5x single-stream on the B2-flagged Strix Halo boxes) belong.
 *
 * A SEPARATE drop-in from the bind, on purpose. `zzzzz-cihub-bind.conf` is the one file that sets
 * the bind, and the bind step moves aside any drop-in that sets the bind and nothing the canonical
 * file does not — so a runtime file that also carried it would be a file the bind step fights with,
 * and a bind change would restart the daemon over a runtime change and vice versa. This file never
 * mentions the bind variable, and a test keeps it that way.
 *
 * The whole file is rendered from the four flags every time: a key the operator did not pass (or
 * passed as `unset`) is simply not in it, and falls back to whatever Ollama or another drop-in
 * decides. That makes a run reproducible from its command line, and makes "revert" a run with the
 * keys left out. The daemon is restarted only when the rendered bytes differ from what is on disk,
 * or when systemd has not loaded the bytes that are there — a restart unloads every resident model,
 * and a fleet command WILL be re-run.
 *
 * "Nothing to do" is decided on what the daemon runs, not on the file alone. A file whose bytes
 * already match while `systemctl show` resolves a managed key to something else — a drop-in sorting
 * after ours, or an earlier run cut off between `install` and `daemon-reload` — is not a no-op: the
 * apply step runs, and its read-back fails the node with the reason. The file being there while the
 * daemon runs something else is the state the bind module exists to make impossible, and skipping
 * the apply because the bytes matched would report exactly that state as adopted.
 *
 * NOTHING HERE RUNS ANYTHING. The shell is executed by `cihub fleet backends --execute`.
 */

import {
  BIND_MARKERS,
  type DropinFile,
  OLLAMA_DROPIN_DIR,
  ollamaOwnershipGuardShell,
  parseShowEnvironment,
  systemdNameCompare,
} from './fleet-ollama-bind.js';

/**
 * Five `z`s for the same reason the bind file has them: systemd sorts drop-ins with `strcmp`, and
 * `zzzz-bind-all.conf` — seen on this fleet — would outrank a `zz-` name. Sorts after the bind file
 * too (`b` < `r`), which does not matter: the two never assign the same key.
 */
export const RUNTIME_DROPIN = 'zzzzz-cihub-runtime.conf';

export const OLLAMA_RUNTIME_KEYS = ['OLLAMA_NUM_PARALLEL', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_CONTEXT_LENGTH', 'OLLAMA_IGPU_ENABLE'] as const;
export type OllamaRuntimeKey = (typeof OLLAMA_RUNTIME_KEYS)[number];

/**
 * What the operator asked for. `undefined` on a field means "leave the key out of the file".
 *
 * `igpu` is a boolean because `OLLAMA_IGPU_ENABLE` is: `on` writes `1`, `off` writes `0` — an
 * explicit `0` is a real setting on a node where something else turned it on.
 */
export interface OllamaRuntimeSettings {
  parallel?: number;
  keepAlive?: string;
  contextLength?: number;
  igpu?: boolean;
}

/** The word that leaves a key out. Accepted by every runtime flag. */
export const RUNTIME_UNSET = 'unset';

export class OllamaRuntimeFlagError extends Error {}

/** Go's duration syntax as Ollama parses `OLLAMA_KEEP_ALIVE`: `24h`, `1h30m`, `10m`, plain seconds, or `-1` for forever. */
const KEEP_ALIVE_SHAPE = /^(-1|\d+|(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+)$/;

const parseBoundedInt = (flag: string, raw: string, min: number, max: number): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new OllamaRuntimeFlagError(`${flag} must be an integer between ${min} and ${max}, or '${RUNTIME_UNSET}' (got '${raw}').`);
  }
  return n;
};

/**
 * Validate one runtime flag's value at parse time, so a typo is refused before any machine is
 * dialled. Returns `undefined` for `unset`.
 */
export function parseOllamaRuntimeValue(flag: '--ollama-parallel', raw: string): number | undefined;
export function parseOllamaRuntimeValue(flag: '--ollama-context', raw: string): number | undefined;
export function parseOllamaRuntimeValue(flag: '--ollama-keep-alive', raw: string): string | undefined;
export function parseOllamaRuntimeValue(flag: '--ollama-igpu', raw: string): boolean | undefined;
export function parseOllamaRuntimeValue(flag: string, raw: string): number | string | boolean | undefined {
  const value = raw.trim();
  if (value === RUNTIME_UNSET) return undefined;
  switch (flag) {
    case '--ollama-parallel':
      // One sequence is Ollama's own default; 64 is far past where any node here has the KV memory.
      return parseBoundedInt(flag, value, 1, 64);
    case '--ollama-context':
      return parseBoundedInt(flag, value, 512, 1_048_576);
    case '--ollama-keep-alive':
      if (!KEEP_ALIVE_SHAPE.test(value)) {
        throw new OllamaRuntimeFlagError(`${flag} must be a duration such as 24h, 30m or -1 (forever), or '${RUNTIME_UNSET}' (got '${raw}').`);
      }
      return value;
    case '--ollama-igpu':
      if (value === 'on') return true;
      if (value === 'off') return false;
      throw new OllamaRuntimeFlagError(`${flag} must be on, off or '${RUNTIME_UNSET}' (got '${raw}').`);
    default:
      throw new OllamaRuntimeFlagError(`Unknown Ollama runtime flag '${flag}'.`);
  }
}

/** The `K=V` pairs the file carries, in a fixed order so identical settings render identical bytes. */
export function ollamaRuntimeEnvironment(settings: OllamaRuntimeSettings): Array<[OllamaRuntimeKey, string]> {
  const env: Array<[OllamaRuntimeKey, string]> = [];
  if (settings.parallel !== undefined) env.push(['OLLAMA_NUM_PARALLEL', String(settings.parallel)]);
  if (settings.keepAlive !== undefined) env.push(['OLLAMA_KEEP_ALIVE', settings.keepAlive]);
  if (settings.contextLength !== undefined) env.push(['OLLAMA_CONTEXT_LENGTH', String(settings.contextLength)]);
  if (settings.igpu !== undefined) env.push(['OLLAMA_IGPU_ENABLE', settings.igpu ? '1' : '0']);
  return env;
}

/** Just the target values, keyed. Absent means "not managed by this run". */
export function ollamaRuntimeTargets(settings: OllamaRuntimeSettings): Partial<Record<OllamaRuntimeKey, string>> {
  return Object.fromEntries(ollamaRuntimeEnvironment(settings)) as Partial<Record<OllamaRuntimeKey, string>>;
}

/**
 * Content of the runtime drop-in. Every line is a plain `Environment="K=V"`; the header says what
 * wrote it and how to change it, and deliberately never names the bind or its variable.
 */
export function ollamaRuntimeDropinContent(settings: OllamaRuntimeSettings): string {
  const lines = [
    '# Managed by cihub fleet — Ollama runtime settings on this node. The bind lives in its own file.',
    '# Rendered whole from the --ollama-parallel / --ollama-keep-alive / --ollama-context / --ollama-igpu',
    "# flags of 'cihub fleet backends --execute'; a key not listed here is not managed by cihub.",
    '[Service]',
  ];
  for (const [key, value] of ollamaRuntimeEnvironment(settings)) lines.push(`Environment="${key}=${value}"`);
  return `${lines.join('\n')}\n`;
}

/** The four managed keys as `systemctl show -p Environment` currently resolves them. */
export function readRuntimeEnvironment(showEnvironment: string | undefined): Partial<Record<OllamaRuntimeKey, string>> {
  if (showEnvironment === undefined) return {};
  const env = parseShowEnvironment(showEnvironment.startsWith('Environment=') ? showEnvironment : `Environment=${showEnvironment}`);
  const out: Partial<Record<OllamaRuntimeKey, string>> = {};
  for (const key of OLLAMA_RUNTIME_KEYS) if (env[key] !== undefined) out[key] = env[key];
  return out;
}

/** `OLLAMA_NUM_PARALLEL 1 → 4, OLLAMA_KEEP_ALIVE <unset> → 24h` — one cell per managed key, plus any that changed underneath. */
export function describeRuntimeTransition(
  before: Partial<Record<OllamaRuntimeKey, string>>,
  after: Partial<Record<OllamaRuntimeKey, string>>,
  settings: OllamaRuntimeSettings,
): string {
  const targets = ollamaRuntimeTargets(settings);
  const show = (v: string | undefined) => v ?? '<unset>';
  const cells: string[] = [];
  for (const key of OLLAMA_RUNTIME_KEYS) {
    const managed = targets[key] !== undefined;
    const changed = before[key] !== after[key];
    if (!managed && !changed) continue;
    cells.push(changed ? `${key} ${show(before[key])} → ${show(after[key])}` : `${key} ${show(after[key])}`);
  }
  return cells.join(', ') || 'no runtime keys managed';
}

export interface OllamaRuntimePlan {
  file: { name: string; path: string; content: string; action: 'write' | 'unchanged' };
  /** The daemon is restarted only when the file changes (or, found by the apply shell, when systemd never loaded it). */
  restart: boolean;
  /** Effective values now, from `systemctl show`. */
  current: Partial<Record<OllamaRuntimeKey, string>>;
  target: Partial<Record<OllamaRuntimeKey, string>>;
  /** A drop-in sorting after ours that assigns a managed key: our value would lose. Named so nobody hunts for it. */
  outranked: Array<{ key: OllamaRuntimeKey; by: string }>;
  /** Managed keys whose effective value is not the one requested, file bytes notwithstanding. */
  unresolved: OllamaRuntimeKey[];
  /** True only when the file matches AND every managed key already resolves to its value: nothing to run. */
  noop: boolean;
  summary: string[];
}

/**
 * What applying `settings` would do on a node, from the read-only bind probe (which already dumps
 * every drop-in and the merged environment). Pure, so every fleet shape is a unit test.
 */
export function planOllamaRuntime(
  files: readonly DropinFile[],
  showEnvironment: string | undefined,
  settings: OllamaRuntimeSettings,
  dropinDir = OLLAMA_DROPIN_DIR,
): OllamaRuntimePlan {
  const content = ollamaRuntimeDropinContent(settings);
  const target = ollamaRuntimeTargets(settings);
  const current = readRuntimeEnvironment(showEnvironment);
  const existing = files.find((f) => f.name === RUNTIME_DROPIN);
  // Trailing-newline-insensitive: the probe's `cat` + `echo` framing drops the file's final newline.
  const unchanged = existing !== undefined && existing.content.trimEnd() === content.trimEnd();

  const outranked: OllamaRuntimePlan['outranked'] = [];
  for (const f of files) {
    if (f.name === RUNTIME_DROPIN || !f.name.endsWith('.conf') || systemdNameCompare(f.name, RUNTIME_DROPIN) <= 0) continue;
    for (const key of OLLAMA_RUNTIME_KEYS) {
      if (target[key] !== undefined && new RegExp(`^\\s*Environment=.*\\b${key}=`, 'm').test(f.content)) outranked.push({ key, by: f.name });
    }
  }

  // The file's bytes are not the daemon's environment. Both must agree before this is a no-op.
  const unresolved = OLLAMA_RUNTIME_KEYS.filter((key) => target[key] !== undefined && current[key] !== target[key]);
  const noop = unchanged && unresolved.length === 0;

  const summary: string[] = [];
  const keys = Object.keys(target);
  summary.push(
    noop
      ? `${RUNTIME_DROPIN} already carries ${keys.length ? keys.join(', ') : 'no keys'}; ollama not restarted`
      : unchanged
        ? `re-read ${RUNTIME_DROPIN} (already carries ${keys.join(', ')}) — systemd resolves ${unresolved.map((k) => `${k}=${current[k] ?? '<unset>'}`).join(' ')}: restart ollama if it never loaded the file, otherwise fail naming what overrides it`
        : `write ${RUNTIME_DROPIN} with ${
            keys.length
              ? ollamaRuntimeEnvironment(settings)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' ')
              : 'no keys (every managed key left out)'
          }, then daemon-reload and restart ollama`,
  );
  for (const o of outranked) summary.push(`CANNOT WIN ${o.key}: ${o.by} sorts after ${RUNTIME_DROPIN} and sets it too — move that line by hand`);

  return {
    file: { name: RUNTIME_DROPIN, path: `${dropinDir}/${RUNTIME_DROPIN}`, content, action: unchanged ? 'unchanged' : 'write' },
    restart: !unchanged,
    current,
    target,
    outranked,
    unresolved,
    noop,
    summary,
  };
}

// ─── The apply script ────────────────────────────────────────────────────────

export const RUNTIME_MARKERS = {
  before: 'ollama-runtime-before:',
  after: 'ollama-runtime-after:',
  written: 'ollama-runtime-written:',
  unchanged: 'ollama-runtime-unchanged:',
  complete: 'ollama-runtime-complete',
} as const;

/**
 * Apply the runtime settings on a node. Runs as root. Idempotent.
 *
 * In order: refuse if something other than the system unit owns the port (same guard as the bind —
 * a drop-in under `ollama.service.d/` configures nothing on beta-1 or core-2); read the merged
 * environment; render the file to a temp path and compare bytes with what is on disk; if identical
 * and systemd has loaded it, touch nothing and say so; if identical but systemd reports
 * `NeedDaemonReload=yes` and a managed key is not in effect — a previous run stopped between
 * `install` and `daemon-reload`, and the daemon runs the old environment — `daemon-reload` and
 * `restart` after all (a pending reload with every key already in effect is not worth unloading
 * the models over); otherwise install it,
 * `daemon-reload`, `restart`; then re-read the merged environment. Both readings are printed so the
 * caller can report `was → is` per key and check that every managed key resolved to the value
 * requested — which is the check that catches a later drop-in outranking the file.
 *
 * `CIHUB_BIND_DIR` is honoured for the same reason the bind shell honours it: so a sandbox can run
 * this for real. `sudo` resets the environment, so on a node the default always applies.
 */
export function ollamaRuntimeApplyShell(settings: OllamaRuntimeSettings): string {
  const content = ollamaRuntimeDropinContent(settings).trimEnd();
  const keys = ollamaRuntimeEnvironment(settings).map(([k, v]) => `${k}=${v}`);
  return [
    ollamaOwnershipGuardShell(),
    `cihub_rt_dir="\${CIHUB_BIND_DIR:-${OLLAMA_DROPIN_DIR}}"`,
    `cihub_rt_file='${RUNTIME_DROPIN}'`,
    "cihub_rt_show() { systemctl show ollama -p Environment 2>/dev/null | sed 's/^Environment=//'; }",
    // Every managed K=V is a word of the merged environment (no managed value carries a space).
    `cihub_rt_in_effect() { cihub_rt_env=" $(cihub_rt_show) "; for kv in ${keys.join(' ')}; do case "$cihub_rt_env" in *" $kv "*) ;; *) return 1 ;; esac; done; return 0; }`,
    `echo "${RUNTIME_MARKERS.before} $(cihub_rt_show)"`,
    'install -d -m 0755 "$cihub_rt_dir"',
    'cihub_rt_tmp="$(mktemp)"',
    'cat >"$cihub_rt_tmp" <<\'CIHUB_RUNTIME_EOF\'',
    content,
    'CIHUB_RUNTIME_EOF',
    'if [ -f "$cihub_rt_dir/$cihub_rt_file" ] && cmp -s "$cihub_rt_tmp" "$cihub_rt_dir/$cihub_rt_file"; then',
    '  rm -f "$cihub_rt_tmp"',
    '  if [ "$(systemctl show ollama -p NeedDaemonReload --value 2>/dev/null)" = yes ] && ! cihub_rt_in_effect; then',
    '    systemctl daemon-reload',
    '    systemctl restart ollama',
    `    echo "${RUNTIME_MARKERS.written} $cihub_rt_file already carried ${keys.length ? keys.join(' ') : 'no keys'} but systemd had not loaded it; ollama restarted"`,
    '  else',
    `    echo "${RUNTIME_MARKERS.unchanged} $cihub_rt_file already carries ${keys.length ? keys.join(' ') : 'no keys'}; ollama not restarted"`,
    '  fi',
    'else',
    '  install -m 0644 "$cihub_rt_tmp" "$cihub_rt_dir/$cihub_rt_file"',
    '  rm -f "$cihub_rt_tmp"',
    '  systemctl daemon-reload',
    '  systemctl restart ollama',
    `  echo "${RUNTIME_MARKERS.written} $cihub_rt_file now carries ${keys.length ? keys.join(' ') : 'no keys'}; ollama restarted"`,
    'fi',
    `echo "${RUNTIME_MARKERS.after} $(cihub_rt_show)"`,
    `echo "${RUNTIME_MARKERS.complete}"`,
  ].join('\n');
}

export interface RuntimeApplyOutcome {
  outcome: 'applied' | 'unchanged' | 'refused' | 'mismatch' | 'incomplete';
  why: string;
  before: Partial<Record<OllamaRuntimeKey, string>>;
  after: Partial<Record<OllamaRuntimeKey, string>>;
  /** `was → is` per managed key, for the report line. */
  transition: string;
}

/**
 * Classify the output of {@link ollamaRuntimeApplyShell}. Markers, not exit codes.
 *
 * The one check that matters is done here, not in the shell: every key this run manages must read
 * back from `systemctl show` with the value requested. A later drop-in that assigns the same key
 * would win silently otherwise — "the drop-in is there" while the daemon runs something else is the
 * state the bind module exists to make impossible, and the same applies here.
 */
export function classifyRuntimeApplyOutput(out: string, err: string, settings: OllamaRuntimeSettings): RuntimeApplyOutcome {
  const lines = `${out}\n${err}`.split('\n').map((l) => l.trim());
  const pick = (marker: string) =>
    lines
      .find((l) => l.startsWith(marker))
      ?.slice(marker.length)
      .trim();
  const before = readRuntimeEnvironment(pick(RUNTIME_MARKERS.before));
  const after = readRuntimeEnvironment(pick(RUNTIME_MARKERS.after));
  const transition = describeRuntimeTransition(before, after, settings);
  const refused = pick(BIND_MARKERS.refused);
  if (refused) return { outcome: 'refused', why: refused, before, after, transition };
  if (!lines.includes(RUNTIME_MARKERS.complete)) {
    return { outcome: 'incomplete', why: 'the runtime step produced no completion marker', before, after, transition };
  }
  const wrong = ollamaRuntimeEnvironment(settings).filter(([key, value]) => after[key] !== value);
  if (wrong.length) {
    return {
      outcome: 'mismatch',
      why: `requested ${wrong.map(([k, v]) => `${k}=${v}`).join(' ')} but systemd resolved ${wrong.map(([k]) => `${k}=${after[k] ?? '<unset>'}`).join(' ')} — a drop-in sorting after ${RUNTIME_DROPIN} is overriding it, or daemon-reload did not run`,
      before,
      after,
      transition,
    };
  }
  const unchanged = pick(RUNTIME_MARKERS.unchanged);
  if (unchanged) return { outcome: 'unchanged', why: unchanged, before, after, transition };
  return { outcome: 'applied', why: pick(RUNTIME_MARKERS.written) ?? 'runtime settings applied', before, after, transition };
}
