import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CURATED_MODELS } from '../../packages/backend/src/modules/inference/catalog/curated-models';
import { GGUF_KV_GEOMETRY } from '../../packages/backend/src/modules/inference/catalog/kv-geometry.generated';
import { checkRow, checkRows, type Options, parseArgs, routeOf, run, UsageError } from '../catalog/check-rows';
import { hfManifestUrl } from '../catalog/registry-endpoints';
import { type CheckRow, FILE_TYPE_EXCEPTIONS, type RowResult } from '../catalog/row-checks';
import { countByStatus, exitCodeFor, renderJson, renderMarkdown, renderTable } from '../catalog/row-report';
import { loadRows, readAuthoredRows } from '../catalog/row-source';
import { answer, fixture, fixtureJson, ollama, replay } from './fixtures/catalog-rows/replay';

/** The command line, the run over several rows, the report, and the guards that keep the checker in step with the real catalog. */

const PIN = '0.34.0';
const noSleep = async () => {};
const options = (over: Partial<Options> = {}): Options => ({ strict: false, format: 'table', concurrency: 4, ...over });

const row = (over: Partial<CheckRow>): CheckRow => ({
  id: 'row',
  backend: 'ollama',
  backendModelId: 'row:1b',
  quant: 'q4_K_M',
  gb: 1,
  contextWindow: 131072,
  gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'],
  ...over,
});

const result = (over: Partial<RowResult>): RowResult => ({
  id: 'row',
  backend: 'ollama',
  target: 'row:1b',
  status: 'ok',
  findings: [],
  facts: [],
  ...over,
});

describe('parseArgs', () => {
  it('takes no arguments for the whole catalog, four reads at a time', () => {
    expect(parseArgs([])).toEqual({ strict: false, format: 'table', concurrency: 4 });
  });

  it('reads every flag, trimming and de-duplicating the ids', () => {
    expect(parseArgs(['--only', 'a, b,a,', '--strict', '--format', 'md', '--concurrency', '8'])).toEqual({
      only: ['a', 'b'],
      strict: true,
      format: 'md',
      concurrency: 8,
    });
  });

  it.each([
    [['--only'], '--only needs a value'],
    [['--only', '--strict'], '--only needs a value'],
    [['--only', ' , '], 'comma-separated catalog row ids'],
    [['--format', 'xml'], '--format is table, md or json'],
    [['--concurrency', '0'], '--concurrency is a whole number from 1 to 16'],
    [['--concurrency', '17'], '--concurrency is a whole number from 1 to 16'],
    [['--concurrency', 'two'], '--concurrency is a whole number from 1 to 16'],
    [['--bogus'], 'unknown argument "--bogus"'],
  ])('refuses %j, and prints the usage', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
    expect(() => parseArgs(argv)).toThrow('usage: check-rows.ts');
  });
});

describe('routeOf', () => {
  it('sends each backend to the registry that holds its models', () => {
    expect(routeOf({ backend: 'ollama', backendModelId: 'qwen3.6:27b' })).toBe('ollama');
    expect(routeOf({ backend: 'ollama', backendModelId: 'openbmb/minicpm-v4.7:1b' })).toBe('ollama');
    expect(routeOf({ backend: 'ollama', backendModelId: 'frob/mistral-small-4:119b' })).toBe('ollama');
    expect(routeOf({ backend: 'ollama', backendModelId: 'hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q4_K_M' })).toBe('hf-gguf');
    expect(routeOf({ backend: 'vllm', backendModelId: 'Qwen/Qwen3-8B' })).toBe('hf-repo');
    expect(routeOf({ backend: 'omlx', backendModelId: 'mlx-community/Qwen3-8B-4bit' })).toBe('hf-repo');
    expect(routeOf({ backend: 'lemonade', backendModelId: 'Qwen3-8B-GGUF' })).toBeUndefined();
  });
});

describe('checkRow', () => {
  it('lists a Lemonade row as skipped, with the reason, and asks the network for nothing', async () => {
    const asked: string[] = [];
    const checked = await checkRow(row({ id: 'gpt-oss-20b-lemonade', backend: 'lemonade', backendModelId: 'gpt-oss-20b-mxfp4-GGUF' }), {
      fetch: async (url) => {
        asked.push(url);
        throw new Error('must not be asked');
      },
      sleep: noSleep,
      pin: PIN,
    });
    expect(checked.status).toBe('skip');
    expect(checked.facts[0]).toContain('server_models.json');
    expect(asked).toEqual([]);
  });

  it('reports a row whose registry could not be read as unread, which is neither a pass nor a failure of the row', async () => {
    const checked = await checkRow(row({ id: 'qwen3-8b-vllm', backend: 'vllm', backendModelId: 'Qwen/Qwen3-8B' }), {
      fetch: async () => {
        throw new Error('getaddrinfo ENOTFOUND huggingface.co');
      },
      sleep: noSleep,
      pin: PIN,
    });
    expect(checked.status).toBe('unverified');
    expect(checked.findings.map((f) => f.level)).toEqual(['unverified']);
    expect(checked.findings[0]?.message).toContain('ENOTFOUND');
  });

  it('checks a row against what its registry answers', async () => {
    const { fetch } = replay({
      [hfManifestUrl({ repo: 'unsloth/GLM-5.2-GGUF', quant: 'UD-Q4_K_XL' })]: answer(400, fixture('hf-gguf/glm-5.2-sharded.400.json')),
    });
    const checked = await checkRow(row({ id: 'glm-5-2', backendModelId: 'hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL', gb: 467 }), {
      fetch,
      sleep: noSleep,
      pin: PIN,
    });
    expect(checked).toMatchObject({ id: 'glm-5-2', backend: 'ollama', target: 'hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL', status: 'fail' });
    expect(checked.findings[0]?.code).toBe('unpullable');
  });
});

describe('an answer the rules cannot make sense of', () => {
  const sharded = hfManifestUrl({ repo: 'owner/odd-GGUF', quant: 'Q4_K_M' });
  const odd = row({ id: 'odd', backendModelId: 'hf.co/owner/odd-GGUF:Q4_K_M', gb: 1 });
  // A manifest whose `layers` is an object: valid JSON of the right outer shape, and not a list.
  const oddAnswer = () => replay({ [sharded]: answer(200, '{"layers": {"model": 1}}') });

  it('makes that row unread, with the reason, instead of ending the run', async () => {
    const checked = await checkRow(odd, { fetch: oddAnswer().fetch, sleep: noSleep, pin: PIN });
    expect(checked.status).toBe('unverified');
    expect(checked.findings[0]?.message).toContain('unexpected error while checking the row');
  });

  it('still prints every other row, and exits 1', async () => {
    const fine = row({ id: 'arete-27b', backendModelId: 'hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q4_K_M', gb: 18.1, fileBytes: 18_131_023_168 });
    const { fetch } = replay({
      [sharded]: answer(200, '{"layers": {"model": 1}}'),
      [hfManifestUrl({ repo: 'bartowski/NousResearch_Arete-27B-GGUF', quant: 'Q4_K_M' })]: answer(200, fixture('hf-gguf/arete-27b.manifest.json')),
    });
    const { output, code } = await run(options({ format: 'json' }), { fetch, sleep: noSleep, pin: PIN, rows: [odd, fine] });
    expect(JSON.parse(output).rows.map((r: RowResult) => [r.id, r.status])).toEqual([
      ['odd', 'unverified'],
      ['arete-27b', 'ok'],
    ]);
    expect(code).toBe(1);
  });
});

describe('checkRows', () => {
  const arete = fixture('hf-gguf/arete-27b.manifest.json');
  const rows = Array.from({ length: 9 }, (_, i) =>
    row({ id: `row-${i}`, backendModelId: `hf.co/owner/repo-${i}-GGUF:Q4_K_M`, gb: 18.1, fileBytes: 18_131_023_168 }),
  );

  it('runs the reads side by side, no more than asked, and returns the results in the order of the rows', async () => {
    let inFlight = 0;
    let busiest = 0;
    const answerWith = async (url: string) => {
      inFlight++;
      busiest = Math.max(busiest, inFlight);
      // The first row's read is the slowest, so the results only come back in order if the rows are kept in order.
      await new Promise((resolve) => setTimeout(resolve, url.includes('repo-0-') ? 30 : 2));
      inFlight--;
      return answer(200, arete);
    };
    const results = await checkRows(rows, { fetch: answerWith, sleep: noSleep, pin: PIN }, 3);
    expect(results.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(busiest).toBe(3);
  });

  it('counts the rows as they finish', async () => {
    const seen: number[] = [];
    await checkRows(rows, { fetch: async () => answer(200, arete), sleep: noSleep, pin: PIN }, 2, (done, total) => seen.push(done * 100 + total));
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => n * 100 + 9));
  });
});

describe('run', () => {
  // An Ollama row that passes, a sharded Hugging Face row that fails, and an Ollama row that warns.
  const qwenRow = row({ id: 'qwen3-6-27b', backendModelId: 'qwen3.6:27b', gb: 17, fileBytes: 17_769_076_719 });
  const glmRow = row({ id: 'glm-5-2', backendModelId: 'hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL', gb: 467 });
  const flintRow = row({ id: 'flint-40b', backendModelId: 'flint:40b', gb: 23, fileBytes: 22_863_095_573 });
  const lemonadeRow = row({ id: 'gpt-oss-20b-lemonade', backend: 'lemonade', backendModelId: 'gpt-oss-20b-mxfp4-GGUF' });
  const routes = () => {
    const digest = (slug: string) => fixtureJson<{ config: { digest: string } }>(`ollama/${slug}.manifest.json`).config.digest;
    return replay({
      [ollama.manifest('library/qwen3.6', '27b')]: answer(200, fixture('ollama/qwen3.6-27b.manifest.json')),
      [ollama.blob('library/qwen3.6', digest('qwen3.6-27b'))]: answer(200, fixture('ollama/qwen3.6-27b.config.json')),
      [ollama.manifest('library/flint', '40b')]: answer(200, fixture('ollama/flint-40b.manifest.json')),
      [ollama.blob('library/flint', digest('flint-40b'))]: answer(200, fixture('ollama/flint-40b.config.json')),
      [hfManifestUrl({ repo: 'unsloth/GLM-5.2-GGUF', quant: 'UD-Q4_K_XL' })]: answer(400, fixture('hf-gguf/glm-5.2-sharded.400.json')),
    });
  };
  const all = [qwenRow, glmRow, flintRow, lemonadeRow];

  it('prints a table of every row, the findings grouped by kind, and exits 1 because a row cannot be pulled', async () => {
    const { fetch } = routes();
    const { output, code } = await run(options(), { fetch, sleep: noSleep, pin: PIN, rows: all });
    expect(code).toBe(1);
    expect(output).toBe(
      [
        'Catalog row check: 4 LLM rows (ollama 3, lemonade 1), Ollama pin 0.34.0.',
        'Read-only: GETs of registry manifests, config blobs and Hugging Face metadata; no weights are downloaded.',
        '',
        'ID                    BACKEND   TARGET                                 RESULT  DETAIL',
        'qwen3-6-27b           ollama    qwen3.6:27b                            ok      Q4_K_M · 17.77 GB · requires 0.30.0',
        'glm-5-2               ollama    hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL  FAIL    unpullable: Hugging Face answers HTTP 400: the repo holds only sharded GGUF files, which Ollama cannot pull',
        "flint-40b             ollama    flint:40b                              WARN    quant: config file_type NVFP4, the row says q4_K_M, and the row's gpuVendors (nvidia, amd, apple, cpu) does not gate it to NVIDIA; requires: needs Ollama 0.40.9, above the pin 0.34.0: a 0.34.0 client gets HTTP 412 from the registry",
        "gpt-oss-20b-lemonade  lemonade  gpt-oss-20b-mxfp4-GGUF                 skip    Lemonade rows name a key in the server's own registry (server_models.json), which this script does not read",
        '',
        '4 LLM rows: 1 ok, 1 warn, 1 fail, 0 unread, 1 skipped',
        '',
        'Findings by kind:',
        '  FAIL   unpullable  (1) glm-5-2',
        '  WARN   requires    (1) flint-40b',
        '  WARN   quant       (1) flint-40b',
        '',
      ].join('\n'),
    );
  });

  it('exits 0 when rows only warn, and 1 under --strict', async () => {
    const warnOnly = [qwenRow, flintRow, lemonadeRow];
    expect((await run(options(), { ...routes(), sleep: noSleep, pin: PIN, rows: warnOnly })).code).toBe(0);
    expect((await run(options({ strict: true }), { ...routes(), sleep: noSleep, pin: PIN, rows: warnOnly })).code).toBe(1);
    expect((await run(options({ strict: true }), { ...routes(), sleep: noSleep, pin: PIN, rows: [qwenRow, lemonadeRow] })).code).toBe(0);
  });

  it('exits 1 for a row it could not read, because nothing was checked', async () => {
    const { code } = await run(options(), {
      fetch: async () => {
        throw new Error('offline');
      },
      sleep: noSleep,
      pin: PIN,
      rows: [qwenRow],
    });
    expect(code).toBe(1);
  });

  it('checks only the rows named by --only, in catalog order, and asks the network about no other', async () => {
    const { fetch, calls } = routes();
    const { output } = await run(options({ only: ['flint-40b', 'qwen3-6-27b'] }), { fetch, sleep: noSleep, pin: PIN, rows: all });
    expect(output).toContain('2 LLM rows');
    expect(output.indexOf('qwen3-6-27b')).toBeLessThan(output.indexOf('flint-40b'));
    expect(calls.every((c) => !c.url.includes('GLM'))).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('refuses an --only id the catalog does not have, naming it, before reading anything', async () => {
    const { fetch, calls } = routes();
    await expect(run(options({ only: ['qwen3-6-27b', 'no-such-row'] }), { fetch, sleep: noSleep, pin: PIN, rows: all })).rejects.toThrow(
      '--only names no LLM row: no-such-row',
    );
    expect(calls).toEqual([]);
  });

  it('prints GitHub Markdown or JSON when asked', async () => {
    const md = await run(options({ format: 'md' }), { ...routes(), sleep: noSleep, pin: PIN, rows: all });
    expect(md.output).toContain('| Row | Backend | Target | Result | Detail |');
    expect(md.output).toContain('| `glm-5-2` | ollama | `hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL` | FAIL |');
    const json = JSON.parse((await run(options({ format: 'json' }), { ...routes(), sleep: noSleep, pin: PIN, rows: all })).output);
    expect(json.pin).toBe(PIN);
    expect(json.summary).toEqual({ ok: 1, warn: 1, unverified: 0, fail: 1, skip: 1 });
    expect(json.rows.map((r: RowResult) => r.id)).toEqual(['qwen3-6-27b', 'glm-5-2', 'flint-40b', 'gpt-oss-20b-lemonade']);
  });
});

describe('report', () => {
  const rows: RowResult[] = [
    result({ id: 'a', status: 'ok' }),
    result({ id: 'b', status: 'warn', findings: [{ level: 'warn', code: 'ctx', message: 'a | b' }] }),
    result({ id: 'c', status: 'unverified', findings: [{ level: 'unverified', code: 'unverified', message: 'offline' }] }),
    result({ id: 'd', status: 'fail', findings: [{ level: 'fail', code: 'gated', message: 'gated' }] }),
    result({ id: 'e', status: 'skip' }),
  ];

  it('exits nonzero for a failed or unread row, and for a warning only under strict', () => {
    const only = (status: RowResult['status']) => [result({ status }), result({ status: 'ok' }), result({ status: 'skip' })];
    expect(exitCodeFor(only('ok'), false)).toBe(0);
    expect(exitCodeFor(only('skip'), true)).toBe(0);
    expect(exitCodeFor(only('warn'), false)).toBe(0);
    expect(exitCodeFor(only('warn'), true)).toBe(1);
    expect(exitCodeFor(only('fail'), false)).toBe(1);
    expect(exitCodeFor(only('unverified'), false)).toBe(1);
    expect(exitCodeFor([], true)).toBe(0);
  });

  it('counts each status', () => {
    expect(countByStatus(rows)).toEqual({ ok: 1, warn: 1, unverified: 1, fail: 1, skip: 1 });
  });

  it('escapes a pipe in a Markdown cell, which would end it', () => {
    expect(renderMarkdown(rows, { pin: PIN })).toContain('| `b` | ollama | `row:1b` | WARN | ctx: a \\| b |');
  });

  it('lists the worst kinds of finding first, whatever order the rows came in', () => {
    const table = renderTable(rows, { pin: PIN });
    expect(table.slice(table.indexOf('Findings by kind:'))).toBe(
      ['Findings by kind:', '  FAIL   gated       (1) d', '  UNREAD unverified  (1) c', '  WARN   ctx         (1) b', ''].join('\n'),
    );
  });

  it('lists failures before warnings whatever the order of the codes, and a code at two levels as two kinds', () => {
    const level = (id: string, status: RowResult['status'], code: 'requires' | 'no-weights', findingLevel: 'fail' | 'warn') =>
      result({ id, status, findings: [{ level: findingLevel, code, message: code }] });
    const mixed = [level('w', 'warn', 'requires', 'warn'), level('x', 'warn', 'no-weights', 'warn'), level('y', 'fail', 'no-weights', 'fail')];
    const table = renderTable(mixed, { pin: PIN });
    expect(table.slice(table.indexOf('Findings by kind:'))).toBe(
      ['Findings by kind:', '  FAIL   no-weights  (1) y', '  WARN   requires    (1) w', '  WARN   no-weights  (1) x', ''].join('\n'),
    );
  });

  it('prints the same text for the same results', () => {
    expect(renderTable(rows, { pin: PIN })).toBe(renderTable([...rows], { pin: PIN }));
    expect(renderJson(rows, { pin: PIN })).toBe(renderJson([...rows], { pin: PIN }));
  });
});

describe('the catalog source', () => {
  const SOURCE = readFileSync(new URL('../../packages/backend/src/modules/inference/catalog/curated-models.ts', import.meta.url), 'utf8');

  describe('readAuthoredRows', () => {
    const toon = [
      '// llms[2|]{id,gb}: a comment that names a table is not a table',
      'const A = `',
      'llms[2|]{id,backendModelId,gb,ctxK}:',
      '  one|one:1b|1.5|128',
      '',
      '  two|two:2b|23|',
      '`;',
      'const B = `',
      'llms[1|]{id,gb,quant}:',
      '  three|8.1|bf16',
      '`;',
    ].join('\n');

    it('reads the gb of every row of every table, whatever the column order', () => {
      expect([...readAuthoredRows(toon)]).toEqual([
        ['one', 1.5],
        ['two', 23],
        ['three', 8.1],
      ]);
    });

    it('refuses an id that two tables both author, because one gb would silently replace the other', () => {
      expect(() => readAuthoredRows('llms[1|]{id,gb}:\n  a|1\nllms[1|]{id,gb}:\n  a|2\n')).toThrow('the row id a appears twice');
    });

    it('refuses a table whose declared count is not what follows it, because rows would be missing', () => {
      expect(() => readAuthoredRows('llms[3|]{id,gb}:\n  a|1\n  b|2\n')).toThrow('declares 3 rows but 2 follow it');
    });

    it('refuses a table with no gb column', () => {
      expect(() => readAuthoredRows('llms[1|]{id,name}:\n  a|b\n')).toThrow('has no id and gb columns');
    });
  });

  describe('against the real catalog', () => {
    const rows = loadRows(SOURCE);
    const llms = CURATED_MODELS.filter((m) => m.modality === 'llm');

    it('has the authored gb of every LLM row, in catalog order', () => {
      expect(rows.map((r) => r.id)).toEqual(llms.map((m) => m.id));
      expect(rows.every((r) => r.gb > 0)).toBe(true);
    });

    it('reads gb the way the module does: an oMLX or vLLM row keeps diskMb = gb x 1024, so a table the reader misread would not match', () => {
      const checked = llms.filter((m) => m.backend === 'omlx' || m.backend === 'vllm');
      expect(checked.length).toBeGreaterThan(10);
      for (const m of checked) {
        expect(Math.round((rows.find((r) => r.id === m.id)?.gb ?? 0) * 1024), m.id).toBe(m.requirements.diskMb);
      }
    });

    it('refuses a row with no authored gb, or one of zero, because a ratio against it means nothing', () => {
      const authored = readAuthoredRows(SOURCE);
      const table = (gbOf: (id: string) => string) =>
        `llms[${authored.size}|]{id,gb}:\n${[...authored.keys()].map((id) => `  ${id}|${gbOf(id)}`).join('\n')}\n`;
      const first = rows[0]?.id ?? '';
      expect(() => loadRows(table((id) => (id === first ? '0' : '1')))).toThrow(`no authored gb for the row ${first}`);
      expect(() => loadRows(table((id) => (id === first ? '' : '1')))).toThrow(`no authored gb for the row ${first}`);
      expect(() => loadRows('')).toThrow('no authored gb for the row');
      expect(loadRows(table(() => '1')).map((r) => r.gb)).toEqual(rows.map(() => 1));
    });

    it('takes fileBytes from the generated table, and never invents one', () => {
      for (const r of rows) expect(r.fileBytes, r.id).toBe(GGUF_KV_GEOMETRY[r.id]?.fileBytes);
    });

    it('covers every LLM row or skips it as Lemonade, so a new backend is a decision and not a silent omission', () => {
      const uncovered = rows.filter((r) => routeOf(r) === undefined && r.backend !== 'lemonade');
      expect(uncovered.map((r) => `${r.id} (${r.backend})`)).toEqual([]);
    });

    it('lists known file_type exceptions only for Ollama rows that are in the catalog', () => {
      for (const id of Object.keys(FILE_TYPE_EXCEPTIONS)) {
        expect(rows.find((r) => r.id === id)?.backend, id).toBe('ollama');
      }
    });
  });
});
