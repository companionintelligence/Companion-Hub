/**
 * The checker's output: a table with one line per row, the findings grouped by kind, and the exit code. Nothing here
 * reads the clock or the network, so the same results always print the same text and two runs can be compared with diff.
 */
import type { Finding, FindingCode, RowResult, RowStatus } from './row-checks';

export interface ReportContext {
  /** The Ollama version the `requires` findings are measured against. */
  pin: string;
}

const LABEL: Record<RowStatus, string> = { ok: 'ok', warn: 'WARN', unverified: 'UNREAD', fail: 'FAIL', skip: 'skip' };

/** The order findings are listed in: what stops a row first, what only drifted last. */
const CODE_ORDER: readonly FindingCode[] = [
  'missing',
  'unpullable',
  'gated',
  'cloud',
  'unverified',
  'requires',
  'quant',
  'size-drift',
  'no-geometry',
  'size-gb',
  'ctx',
  'no-ctx',
  'no-weights',
];

export function countByStatus(results: readonly RowResult[]): Record<RowStatus, number> {
  const counts: Record<RowStatus, number> = { ok: 0, warn: 0, unverified: 0, fail: 0, skip: 0 };
  for (const result of results) counts[result.status]++;
  return counts;
}

/** Nonzero when a row failed or could not be read, and under `strict` when one only warns. */
export function exitCodeFor(results: readonly RowResult[], strict: boolean): 0 | 1 {
  return results.some((r) => r.status === 'fail' || r.status === 'unverified' || (strict && r.status === 'warn')) ? 1 : 0;
}

/** A row's findings, or what was read when it has none. */
function detailOf(result: RowResult): string {
  if (result.findings.length > 0) return result.findings.map((finding: Finding) => `${finding.code}: ${finding.message}`).join('; ');
  return result.facts.join(' · ');
}

function summaryLine(results: readonly RowResult[]): string {
  const counts = countByStatus(results);
  return `${results.length} LLM rows: ${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail, ${counts.unverified} unread, ${counts.skip} skipped`;
}

/** Row ids per kind of finding, worst first: failures, then unread rows, then warnings, each in the order of CODE_ORDER. */
function findingsByKind(results: readonly RowResult[]): { level: string; code: FindingCode; ids: string[] }[] {
  const out: { level: string; code: FindingCode; ids: string[] }[] = [];
  for (const level of ['fail', 'unverified', 'warn'] as const) {
    for (const code of CODE_ORDER) {
      const hits = results.filter((r) => r.findings.some((f) => f.level === level && f.code === code));
      if (hits.length > 0) out.push({ level: level === 'unverified' ? 'UNREAD' : level.toUpperCase(), code, ids: hits.map((r) => r.id) });
    }
  }
  return out;
}

function header(results: readonly RowResult[], context: ReportContext): string[] {
  const backends = new Map<string, number>();
  for (const result of results) backends.set(result.backend, (backends.get(result.backend) ?? 0) + 1);
  const mix = [...backends].map(([backend, n]) => `${backend} ${n}`).join(', ');
  return [
    `Catalog row check: ${results.length} LLM rows (${mix}), Ollama pin ${context.pin}.`,
    'Read-only: GETs of registry manifests, config blobs and Hugging Face metadata; no weights are downloaded.',
  ];
}

export function renderTable(results: readonly RowResult[], context: ReportContext): string {
  const rows = results.map((r) => [r.id, r.backend, r.target, LABEL[r.status], detailOf(r)]);
  const heading = ['ID', 'BACKEND', 'TARGET', 'RESULT', 'DETAIL'];
  const widths = heading.map((title, col) => Math.max(title.length, ...rows.map((row) => (row[col] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, col) => (col === cells.length - 1 ? cell : cell.padEnd(widths[col] ?? 0)))
      .join('  ')
      .trimEnd();
  const kinds = findingsByKind(results).map((k) => `  ${k.level.padEnd(6)} ${k.code.padEnd(11)} (${k.ids.length}) ${k.ids.join(', ')}`);
  return [
    ...header(results, context),
    '',
    line(heading),
    ...rows.map(line),
    '',
    summaryLine(results),
    ...(kinds.length > 0 ? ['', 'Findings by kind:', ...kinds] : []),
    '',
  ].join('\n');
}

const cell = (text: string): string => text.replaceAll('|', '\\|');

/** The same report as GitHub Markdown, for a pull request description. */
export function renderMarkdown(results: readonly RowResult[], context: ReportContext): string {
  const kinds = findingsByKind(results).map((k) => `- **${k.level}** \`${k.code}\` (${k.ids.length}): ${k.ids.map((id) => `\`${id}\``).join(', ')}`);
  return [
    ...header(results, context),
    '',
    `**${summaryLine(results)}**`,
    '',
    ...(kinds.length > 0 ? ['Findings by kind:', '', ...kinds, ''] : []),
    '| Row | Backend | Target | Result | Detail |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| \`${r.id}\` | ${r.backend} | \`${cell(r.target)}\` | ${LABEL[r.status]} | ${cell(detailOf(r))} |`),
    '',
  ].join('\n');
}

export function renderJson(results: readonly RowResult[], context: ReportContext): string {
  return `${JSON.stringify({ pin: context.pin, summary: countByStatus(results), rows: results }, null, 2)}\n`;
}
