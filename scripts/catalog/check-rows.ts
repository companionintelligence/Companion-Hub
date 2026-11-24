/**
 * Checks every LLM row of the curated catalog against the primary data of the registry that serves it, and prints a table.
 *
 * WHY: a row is a claim that a model can be pulled, that it is the size and quantisation the row says, and that it fits
 * what the fleet runs. The 2026-11-15 refresh verified 33 new rows with about ninety agents over several hours, and two
 * review rounds still found 38 problems: rows Ollama cannot pull (a sharded Hugging Face GGUF answers HTTP 400), a vision
 * projector missing from a size, builds that need a newer Ollama than the fleet runs. All of it is in public manifests,
 * so this reads the same data for every row in about a minute, and an existing row that has rotted shows up as well.
 *
 * Usage (needs network; run from the repo root):
 *   pnpm exec tsx scripts/catalog/check-rows.ts [--only <id,id,...>] [--strict] [--format table|md|json] [--concurrency <n>]
 * Exits 1 when a row fails (cannot be pulled, repo missing or gated, a cloud proxy) or could not be read, and under
 * `--strict` when a row only warns. Warnings are drift: a size, a quant label, a context window, an Ollama version above the pin.
 *
 * Per backend:
 *  - Ollama rows (library, `openbmb/`, `frob/`, any namespace): the registry manifest answers 200; its layers add up to the
 *    row's `fileBytes` in kv-geometry.generated.ts and to its `gb` within 10 %; the config blob's `file_type` is the row's
 *    quant label (or the known exception); its `requires` is not above the fleet's Ollama pin; no `remote_host` or cloud tag.
 *  - `hf.co/<repo>:<quant>` rows: Hugging Face's registry endpoint, asked as Ollama asks it, answers 200 (HTTP 400 for a
 *    sharded repo means no pull), and its layers, a vision projector among them, add up as above.
 *  - oMLX and vLLM rows: the Hugging Face repo exists and is not gated, its root `.safetensors` add up to `gb` (decimal GB),
 *    and `config.json`'s `max_position_embeddings` reaches the row's context window.
 *  - Lemonade rows are listed and skipped: they name a key in the server's own registry, which this script does not read.
 * Network use is read-only: GETs of small JSON, no pull and no weights. See row-reads.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDirectScriptRun } from '../lib/is-direct-run';
import { OLLAMA_PINNED_VERSION } from '../lib/fleet-ollama-version';
import { hfGgufRef, isHfGguf, ollamaRef } from './registry-endpoints';
import { type CheckRow, judgeHfGgufRow, judgeHfRepoRow, judgeOllamaRow, type RowResult, statusOf, unverified, type Verdict } from './row-checks';
import { exitCodeFor, type ReportContext, renderJson, renderMarkdown, renderTable } from './row-report';
import { type ReadDeps, ReadFailed, readHfGgufManifest, readHfRepo, readOllamaRegistry } from './row-reads';
import { loadRows } from './row-source';

const CATALOG_SOURCE = fileURLToPath(new URL('../../packages/backend/src/modules/inference/catalog/curated-models.ts', import.meta.url));

const USAGE = 'usage: check-rows.ts [--only <id,id,...>] [--strict] [--format table|md|json] [--concurrency <n>]';

export class UsageError extends Error {}

export interface Options {
  only?: string[];
  strict: boolean;
  format: 'table' | 'md' | 'json';
  concurrency: number;
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = { strict: false, format: 'table', concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value\n${USAGE}`);
      return next;
    };
    switch (flag) {
      case '--only': {
        const ids = [
          ...new Set(
            value()
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        ];
        if (ids.length === 0) throw new UsageError(`--only needs comma-separated catalog row ids\n${USAGE}`);
        options.only = ids;
        break;
      }
      case '--strict':
        options.strict = true;
        break;
      case '--format': {
        const format = value();
        if (format !== 'table' && format !== 'md' && format !== 'json')
          throw new UsageError(`--format is table, md or json, not ${JSON.stringify(format)}\n${USAGE}`);
        options.format = format;
        break;
      }
      case '--concurrency': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 16) throw new UsageError(`--concurrency is a whole number from 1 to 16\n${USAGE}`);
        options.concurrency = n;
        break;
      }
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(flag)}\n${USAGE}`);
    }
  }
  return options;
}

export type Route = 'ollama' | 'hf-gguf' | 'hf-repo';

/** Which registry holds a row's model, or undefined when this script reads none for its backend. */
export function routeOf(row: Pick<CheckRow, 'backend' | 'backendModelId'>): Route | undefined {
  if (row.backend === 'ollama') return isHfGguf(row.backendModelId) ? 'hf-gguf' : 'ollama';
  if (row.backend === 'vllm' || row.backend === 'omlx') return 'hf-repo';
  return undefined;
}

export interface CheckDeps extends ReadDeps {
  /** The Ollama version a row's `requires` is measured against. */
  pin: string;
}

async function verdictFor(row: CheckRow, route: Route, deps: CheckDeps): Promise<Verdict> {
  switch (route) {
    case 'ollama':
      return judgeOllamaRow(row, await readOllamaRegistry(ollamaRef(row.backendModelId), deps), deps.pin);
    case 'hf-gguf':
      return judgeHfGgufRow(row, await readHfGgufManifest(hfGgufRef(row.backendModelId), deps));
    case 'hf-repo':
      return judgeHfRepoRow(row, await readHfRepo(row.backendModelId, deps));
  }
}

export async function checkRow(row: CheckRow, deps: CheckDeps): Promise<RowResult> {
  const base = { id: row.id, backend: row.backend, target: row.backendModelId };
  const route = routeOf(row);
  if (!route) {
    const why =
      row.backend === 'lemonade'
        ? "Lemonade rows name a key in the server's own registry (server_models.json), which this script does not read"
        : `no registry is read for ${row.backend} rows`;
    return { ...base, status: 'skip', findings: [], facts: [why] };
  }
  let verdict: Verdict;
  try {
    verdict = await verdictFor(row, route, deps);
  } catch (err) {
    // An answer the rules cannot make sense of costs that row's verdict, never the whole report: the row is unread, with the reason.
    const reason =
      err instanceof ReadFailed ? err.message : `unexpected error while checking the row: ${err instanceof Error ? err.message : String(err)}`;
    verdict = { findings: [unverified(reason)], facts: [] };
  }
  return { ...base, status: statusOf(verdict.findings), findings: verdict.findings, facts: verdict.facts };
}

/** Checks rows `concurrency` at a time. The results are in the order of `rows`, whichever read finishes first. */
export async function checkRows(
  rows: readonly CheckRow[],
  deps: CheckDeps,
  concurrency: number,
  onDone?: (done: number, total: number) => void,
): Promise<RowResult[]> {
  const results = new Array<RowResult>(rows.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const at = next++;
      const row = rows[at];
      if (!row) return;
      results[at] = await checkRow(row, deps);
      onDone?.(++done, rows.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return results;
}

export interface RunDeps extends CheckDeps {
  /** The rows to check; the catalog's own when absent. */
  rows?: readonly CheckRow[];
  onDone?: (done: number, total: number) => void;
}

/** The whole run: pick the rows, check them, and render the report. Returns the text to print and the exit code. */
export async function run(options: Options, deps: RunDeps): Promise<{ output: string; code: 0 | 1 }> {
  const all = deps.rows ?? loadRows(readFileSync(CATALOG_SOURCE, 'utf8'));
  if (options.only) {
    const known = new Set(all.map((row) => row.id));
    const unknown = options.only.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new UsageError(`--only names no LLM row: ${unknown.join(', ')}`);
  }
  const rows = options.only ? all.filter((row) => options.only?.includes(row.id)) : all;
  const results = await checkRows(rows, deps, options.concurrency, deps.onDone);
  const context: ReportContext = { pin: deps.pin };
  const render = options.format === 'md' ? renderMarkdown : options.format === 'json' ? renderJson : renderTable;
  return { output: render(results, context), code: exitCodeFor(results, options.strict) };
}

async function main(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(err.message);
    return 2;
  }
  const progress = process.stderr.isTTY ? (done: number, total: number) => process.stderr.write(`\rchecked ${done}/${total}`) : undefined;
  try {
    const { output, code } = await run(options, {
      fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      pin: OLLAMA_PINNED_VERSION,
      onDone: progress,
    });
    if (progress) process.stderr.write('\r\x1b[K');
    process.stdout.write(output);
    return code;
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(err.message);
    return 2;
  }
}

if (isDirectScriptRun(import.meta.url, import.meta.main)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
