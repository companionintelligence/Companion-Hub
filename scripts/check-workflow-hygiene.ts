/**
 * Guard for the GitHub workflows in this repository.
 *
 * Every workflow here runs only when someone dispatches it, so a check that lives in a workflow never
 * runs on a push. This guard runs from `pnpm run check:workflows` (part of `check:pr`), from the `Hub CI`
 * workflow, and from `scripts/__tests__/check-workflow-hygiene.test.ts`, which `pnpm test` runs.
 *
 * It reads the files that git tracks as text, line by line, and never loads YAML: root `scripts/` cannot
 * import the `yaml` package, and a text reader cannot be made to run anything. The price is that it reads
 * the shapes these workflows use (block mappings, one-line flow collections). A shape it cannot read, such
 * as an alias in the triggers or a job built with a merge key, is reported, never passed. It is a check
 * against mistakes, not a barrier against someone who edits the guard.
 *
 * Rules (the first five share their ids with the guards of the sibling repositories):
 *   dangerous-trigger    `pull_request_target` or `workflow_run` in the triggers, or in the commented original
 *                        triggers that `ci-local restore` puts back.
 *   secrets-inherit      a job that hands every secret to the workflow it calls.
 *   unpinned-uses        an action reference that can move. Report only, until the references are pinned.
 *   private-key          a private-key block in a tracked text file.
 *   missing-permissions  no `permissions` at the top of the workflow and not on every job.
 *   secret-map           a call passes other secrets than the called workflow reads and declares.
 *   allow-list           `.github/workflow-hygiene.allow.json` is malformed, or lists something that no
 *                        longer matches anything (the list can only shrink).
 *
 * Comment lines are ignored by every rule except `dangerous-trigger`, which also reads the commented
 * original triggers. Text inside block scalars (`run: |`) is script text, not workflow structure.
 *
 * Usage:
 *   pnpm run check:workflows               # exit 1 on any finding that is not report-only
 *   pnpm run check:workflows --report      # also list the report-only findings
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectScriptRun } from './lib/is-direct-run';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type RuleId = 'dangerous-trigger' | 'secrets-inherit' | 'unpinned-uses' | 'private-key' | 'missing-permissions' | 'secret-map' | 'allow-list';

export interface Finding {
  rule: RuleId;
  /** Path relative to the repository root, with forward slashes. */
  file: string;
  /** 1-based, or 0 when the finding is about the whole file. */
  line: number;
  /** The job the finding is about, when there is one. */
  job?: string;
  message: string;
}

export interface AllowEntry {
  file: string;
  /** Limits the entry to one job. Without it the entry covers the whole file. */
  job?: string;
  reason: string;
}

export interface AllowList {
  secretsInherit: AllowEntry[];
  pem: AllowEntry[];
  missingPermissions: AllowEntry[];
}

export interface RepoScan {
  /** Workflow and composite-action files that were read. */
  workflowFiles: string[];
  /** Tracked files that were read as text for the private-key rule. */
  textFiles: number;
  /** What the guard reports after the allow-list, sorted. Includes report-only findings: see `isReportOnly`. */
  findings: Finding[];
  /** The findings that an allow-list entry covers. */
  allowed: Finding[];
}

export const ALLOW_LIST_PATH = '.github/workflow-hygiene.allow.json';

/** Rules that are listed but do not fail the run. */
export const REPORT_ONLY_RULES: ReadonlySet<RuleId> = new Set<RuleId>(['unpinned-uses']);

export function isReportOnly(finding: Finding): boolean {
  return REPORT_ONLY_RULES.has(finding.rule);
}

/** The allow-list key that can cover each rule. A rule without a key cannot be allowed. */
const ALLOW_KEY_FOR_RULE: Partial<Record<RuleId, keyof AllowList>> = {
  'secrets-inherit': 'secretsInherit',
  'private-key': 'pem',
  'missing-permissions': 'missingPermissions',
};

const ALLOW_KEYS: ReadonlyArray<keyof AllowList> = ['secretsInherit', 'pem', 'missingPermissions'];
const MIN_REASON_LENGTH = 8;
const MAX_TEXT_BYTES = 1024 * 1024;
const BYTE_ORDER_MARK = 0xfeff;

function finding(rule: RuleId, file: string, line: number, message: string, job?: string): Finding {
  return job === undefined ? { rule, file, line, message } : { rule, file, line, job, message };
}

// ---------------------------------------------------------------------------------------------------
// Reading lines
// ---------------------------------------------------------------------------------------------------

interface Line {
  /** 1-based line number. */
  n: number;
  indent: number;
  /**
   * `code`: workflow structure. `scalar`: the body of a block scalar. `comment` and `blank` are what they say.
   */
  kind: 'blank' | 'comment' | 'code' | 'scalar';
  /** For `code`: the line without indentation and without its trailing comment. Empty otherwise. */
  code: string;
  /** For `comment`: the text after `#`. For `code`: its trailing comment, or empty. */
  comment: string;
  /** The line without indentation. Kept for block scalars, where secrets can still be read. */
  text: string;
  /** A comment line between the `ci-local:gated` markers. */
  gated: boolean;
}

const GATE_BEGIN = /^#\s*>>>\s*ci-local:gated\b/;
const GATE_END = /^#\s*<<<\s*ci-local:gated\b/;

/**
 * A line whose value opens a block scalar: `key: |`, `- run: >-`, `- |`, optionally after an anchor or tag.
 * Group 1 holds the list markers and group 2 the key, when there is one.
 */
const BLOCK_SCALAR = /^((?:-\s+)*)(?:("[^"]*"|'[^']*'|[^\s"'#:][^:]*?)\s*:\s+)?(?:[&!]\S*\s+)*[|>][0-9+-]{0,2}$/;

/** Splits a trailing ` # comment` off a line, leaving `#` inside quotes and inside words alone. */
function splitComment(source: string): { code: string; comment: string } {
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i);
    const before = i === 0 ? ' ' : source.charAt(i - 1);
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if ((c === '"' || c === "'") && /[\s[{,]/.test(before)) {
      quote = c;
    } else if (c === '#' && /\s/.test(before)) {
      return { code: source.slice(0, i).trimEnd(), comment: source.slice(i + 1).trim() };
    }
  }
  return { code: source, comment: '' };
}

function readLines(source: string): Line[] {
  const lines: Line[] = [];
  let scalarOwner = -1;
  let gated = false;
  // A byte-order mark in front of the first key would otherwise count as one column of indentation.
  const content = source.charCodeAt(0) === BYTE_ORDER_MARK ? source.slice(1) : source;
  for (const [i, raw] of content.split(/\r?\n/).entries()) {
    const body = raw.trimStart();
    const text = body.trimEnd();
    const base = { n: i + 1, indent: raw.length - body.length, text, gated: false };
    if (scalarOwner >= 0) {
      if (text === '') {
        lines.push({ ...base, kind: 'blank', code: '', comment: '' });
        continue;
      }
      if (base.indent > scalarOwner) {
        lines.push({ ...base, kind: 'scalar', code: '', comment: '' });
        continue;
      }
      scalarOwner = -1;
    }
    if (text === '') {
      lines.push({ ...base, kind: 'blank', code: '', comment: '' });
    } else if (text.startsWith('#')) {
      if (GATE_BEGIN.test(text)) gated = true;
      lines.push({ ...base, kind: 'comment', code: '', comment: text.slice(1).trim(), gated });
      if (GATE_END.test(text)) gated = false;
    } else {
      const { code, comment } = splitComment(text);
      const opens = BLOCK_SCALAR.exec(code);
      if (opens) {
        const markers = opens[1] ?? '';
        // A bare `- |` belongs to the list entry, so its body only has to be deeper than the dash.
        scalarOwner = base.indent + (opens[2] === undefined ? markers.replace(/-\s+$/, '').length : markers.length);
      }
      lines.push({ ...base, kind: 'code', code, comment });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------
// Reading structure: keys, sections, jobs
// ---------------------------------------------------------------------------------------------------

/** The text of a line that can hold structure or script, without its comment. */
function bodyOf(l: Line): string {
  if (l.kind === 'code') return l.code;
  return l.kind === 'scalar' ? l.text : '';
}

interface KeyEntry {
  key: string;
  /** What follows the colon on the same line, as written. */
  value: string;
  line: number;
  /** Position in the line list, to look at what follows. */
  index: number;
  indent: number;
}

/** An anchor or a tag in front of a value (`&base`, `!!str`). */
const PROPS = /^(?:[&!]\S*\s*)+/;
const KEY = /^(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_][\w.-]*|<<))\s*:(?:\s+(.*))?$/;

function parseKey(code: string): { key: string; value: string } | null {
  const m = KEY.exec(code);
  if (!m) return null;
  return { key: m[1] ?? m[2] ?? m[3] ?? '', value: (m[4] ?? '').trim() };
}

function unquote(value: string): string {
  const m = /^"(.*)"$|^'(.*)'$/.exec(value);
  return m ? (m[1] ?? m[2] ?? '') : value;
}

/** The keys one level below the key at `lines[index]`: the keys at the indent of its first deeper line. */
function children(lines: Line[], index: number): KeyEntry[] {
  const parent = lines[index];
  const found: KeyEntry[] = [];
  if (!parent) return found;
  let childIndent = -1;
  for (const [offset, l] of lines.slice(index + 1).entries()) {
    if (l.kind !== 'code') continue;
    if (l.indent <= parent.indent) break;
    if (childIndent < 0) childIndent = l.indent;
    const key = l.indent === childIndent ? parseKey(l.code) : null;
    if (key) found.push({ ...key, line: l.n, index: index + 1 + offset, indent: l.indent });
  }
  return found;
}

function topKeyIndex(lines: Line[], name: string): number {
  return lines.findIndex((l) => l.kind === 'code' && l.indent === 0 && parseKey(l.code)?.key === name);
}

/** The key at `lines[index]` (top level) and everything up to the next top-level key. */
function section(lines: Line[], index: number): Line[] {
  const owned: Line[] = [];
  for (const l of lines.slice(index)) {
    if (owned.length > 0 && l.kind === 'code' && l.indent === 0 && parseKey(l.code)) break;
    owned.push(l);
  }
  return owned;
}

interface Job {
  id: string;
  line: number;
  keys: Map<string, KeyEntry>;
  /** False when the job is not a plain block mapping (flow style, an alias, a merge key), so its keys cannot be seen. */
  readable: boolean;
}

/** The jobs of a workflow, or null when it has no `jobs` key. */
function readJobs(lines: Line[]): Job[] | null {
  const at = topKeyIndex(lines, 'jobs');
  const jobsLine = lines[at];
  if (!jobsLine) return null;
  if (parseKey(jobsLine.code)?.value) return [{ id: 'jobs', line: jobsLine.n, keys: new Map(), readable: false }];
  return children(lines, at).map((entry) => {
    const keys = new Map<string, KeyEntry>();
    for (const key of children(lines, entry.index)) if (!keys.has(key.key)) keys.set(key.key, key);
    // A merge key (`<<: *base`) brings in keys that this reader cannot see.
    return { id: entry.key, line: entry.line, keys, readable: entry.value.replace(PROPS, '') === '' && !keys.has('<<') };
  });
}

// ---------------------------------------------------------------------------------------------------
// Rules for one workflow or composite action
// ---------------------------------------------------------------------------------------------------

const TRIGGER = /(?<![\w-])(pull_request_target|workflow_run)(?![\w-])/gi;
/** An alias (`*name`) that is not inside quotes. */
const ALIAS = /(?:^|[:\s[{,])\*[A-Za-z_]/;

function checkTriggers(file: string, lines: Line[]): Finding[] {
  const found: Finding[] = [];
  const refuse = (line: number, text: string, where: string) => {
    for (const m of text.matchAll(TRIGGER)) {
      found.push(
        finding(
          'dangerous-trigger',
          file,
          line,
          `${(m[1] ?? '').toLowerCase()} is refused as a trigger (${where}): a run it starts has this repository's token and secrets even when the change behind it comes from outside the repository`,
        ),
      );
    }
  };
  for (const l of lines) if (l.kind === 'comment' && l.gated) refuse(l.n, l.comment, 'found in the commented original triggers');
  const onAt = topKeyIndex(lines, 'on');
  if (onAt < 0) return found;
  for (const l of section(lines, onAt)) {
    const text = bodyOf(l);
    // An escape sequence, a folded line, or an alias could name an event without its letters being in this section.
    if (text.includes('\\'))
      found.push(finding('dangerous-trigger', file, l.n, 'a backslash inside the triggers can hide an event name; write the names plainly'));
    else if (ALIAS.test(text.replace(/"[^"]*"|'[^']*'/g, '""')))
      found.push(finding('dangerous-trigger', file, l.n, 'an alias inside the triggers can hide an event name; write the triggers out'));
    else refuse(l.n, text, 'found in the triggers');
  }
  return found;
}

/** True when `secrets:` is anything but an explicit map of names: `inherit` in any spelling, a scalar, an alias. */
function handsOverEverything(lines: Line[], entry: KeyEntry): boolean {
  const value = entry.value.replace(PROPS, '');
  if (value.startsWith('{')) return false;
  if (value !== '') return true;
  const next = lines.slice(entry.index + 1).find((l) => l.kind === 'code');
  return next !== undefined && next.indent > entry.indent && parseKey(next.code) === null;
}

function checkSecretsInherit(file: string, lines: Line[], jobs: Job[]): Finding[] {
  const found: Finding[] = [];
  for (const job of jobs) {
    if (!job.readable) {
      found.push(
        finding(
          'secrets-inherit',
          file,
          job.line,
          `${job.id} is not written as a block mapping, so a hand-over of every secret cannot be ruled out`,
          job.id,
        ),
      );
      continue;
    }
    const entry = job.keys.get('secrets');
    if (entry && handsOverEverything(lines, entry)) {
      found.push(
        finding(
          'secrets-inherit',
          file,
          entry.line,
          `job ${job.id} hands every secret to the workflow it calls; list the secret names instead`,
          job.id,
        ),
      );
    }
  }
  return found;
}

function checkPermissions(file: string, lines: Line[], jobs: Job[] | null): Finding[] {
  if (topKeyIndex(lines, 'permissions') >= 0) return [];
  if (!jobs || jobs.length === 0) return [finding('missing-permissions', file, 0, 'no permissions at the top and no jobs that could be read')];
  const found: Finding[] = [];
  for (const job of jobs) {
    if (job.readable && job.keys.has('permissions')) continue;
    const message = job.readable
      ? `job ${job.id} sets no permissions and the workflow sets none at the top, so it gets the repository's default token`
      : `job ${job.id} cannot be read and the workflow sets no permissions at the top, so it may get the repository's default token`;
    found.push(finding('missing-permissions', file, job.line, message, job.id));
  }
  return found;
}

const USES_BLOCK = /^(?:-\s+)*(?:"uses"|'uses'|uses)\s*:(?:\s+(.*))?$/;
const USES_FLOW = /[{,]\s*(?:"uses"|'uses'|uses)\s*:\s*("[^"]*"|'[^']*'|[^,}]*)/;
const COMMIT_PIN = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const DOCKER_PIN = /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/;

/** The value of a `uses:` key on this line, as written, or null when the line has none. */
function usesValue(code: string): string | null {
  const block = USES_BLOCK.exec(code);
  if (block) return (block[1] ?? '').trim();
  const flow = code.replace(/^(?:-\s+)+/, '');
  return flow.startsWith('{') ? (USES_FLOW.exec(flow)?.[1]?.trim() ?? null) : null;
}

function referenceProblem(ref: string, comment: string): string | null {
  if (ref.startsWith('./') || DOCKER_PIN.test(ref)) return null;
  if (COMMIT_PIN.test(ref)) return comment === '' ? `${ref} is pinned to a commit but names no release in a trailing comment` : null;
  return `${ref} can move; pin it to a full commit and name the release in a trailing comment`;
}

function checkUses(file: string, lines: Line[]): Finding[] {
  const found: Finding[] = [];
  for (const l of lines) {
    const raw = l.kind === 'code' ? usesValue(l.code) : null;
    if (raw === null) continue;
    const ref = unquote(raw);
    const unreadable = ref === '' || /^[|>*&!]|\$\{\{/.test(ref);
    const problem = unreadable ? 'the `uses` value is not a plain reference on this line, so it cannot be checked' : referenceProblem(ref, l.comment);
    if (problem) found.push(finding('unpinned-uses', file, l.n, problem));
  }
  return found;
}

/** Scans one workflow, or one composite action when the file is named `action.yml`. Pure: nothing is read from disk. */
export function scanWorkflow(file: string, source: string): Finding[] {
  const lines = readLines(source);
  if (/(?:^|\/)action\.ya?ml$/.test(file)) return sortFindings(checkUses(file, lines));
  const jobs = readJobs(lines);
  return sortFindings([
    ...checkTriggers(file, lines),
    ...checkSecretsInherit(file, lines, jobs ?? []),
    ...checkUses(file, lines),
    ...checkPermissions(file, lines, jobs),
  ]);
}

// ---------------------------------------------------------------------------------------------------
// Private keys
// ---------------------------------------------------------------------------------------------------

const DASHES = '-'.repeat(5);

/**
 * The header of an RSA, EC, OPENSSH, encrypted, plain, or PGP private key; public keys and certificates have
 * other headers. Built from pieces so this file and its tests do not match themselves.
 */
const PRIVATE_KEY = new RegExp(`${DASHES}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?${DASHES}`);

export function scanPrivateKeys(file: string, source: string): Finding[] {
  const found: Finding[] = [];
  for (const [i, line] of source.split(/\r?\n/).entries()) {
    if (PRIVATE_KEY.test(line)) found.push(finding('private-key', file, i + 1, 'a private-key block is committed in this file'));
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------
// Secret maps between a caller and the workflow it calls
// ---------------------------------------------------------------------------------------------------

/** `secrets.NAME` and `secrets['NAME']`, but not `steps.secrets.outputs.NAME`. */
const SECRET_READ = /(?<![\w.-])secrets(?:\.([A-Za-z_][\w-]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;

function secretsRead(lines: Line[]): Set<string> {
  const names = new Set<string>();
  for (const l of lines) {
    for (const m of bodyOf(l).matchAll(SECRET_READ)) {
      const name = m[1] ?? m[2] ?? '';
      // Every called workflow has the repository token, whatever the caller passes.
      if (name !== '' && name !== 'GITHUB_TOKEN') names.add(name);
    }
  }
  return names;
}

function secretsDeclared(lines: Line[]): Set<string> {
  const onAt = topKeyIndex(lines, 'on');
  const call = onAt < 0 ? undefined : children(lines, onAt).find((k) => k.key === 'workflow_call');
  const secrets = call ? children(lines, call.index).find((k) => k.key === 'secrets') : undefined;
  return new Set(secrets ? children(lines, secrets.index).map((k) => k.key) : []);
}

/**
 * Checks every job that calls a workflow of this repository. `workflows` maps each workflow path to its
 * text. A call must pass exactly the secrets the called workflow reads, and the called workflow must
 * declare them: it accepts no others, so a name that is passed but not declared stops the whole run from
 * starting, and a name that is read but not passed reaches the job as an empty value.
 */
export function scanSecretMaps(workflows: ReadonlyMap<string, string>): Finding[] {
  const parsed = new Map([...workflows].map(([file, source]) => [file, readLines(source)] as const));
  const found: Finding[] = [];
  for (const [file, lines] of parsed) {
    for (const job of readJobs(lines) ?? []) {
      const uses = unquote(job.keys.get('uses')?.value ?? '');
      if (!job.readable || !uses.startsWith('./.github/workflows/')) continue;
      const target = uses.slice(2);
      const entry = job.keys.get('secrets');
      if (entry && handsOverEverything(lines, entry)) continue;
      const report = (message: string) => found.push(finding('secret-map', file, entry?.line ?? job.line, `job ${job.id}: ${message}`, job.id));
      const callee = parsed.get(target);
      if (!callee) {
        report(`calls ${target}, which is not in the tree`);
        continue;
      }
      if (entry?.value.startsWith('{')) {
        report('the secrets map is written in flow style and cannot be read; write it as a block');
        continue;
      }
      const passed = new Set(entry ? children(lines, entry.index).map((k) => k.key) : []);
      const declared = secretsDeclared(callee);
      const read = secretsRead(callee);
      for (const name of passed) {
        if (!declared.has(name)) report(`passes ${name}, which ${target} does not declare under on.workflow_call.secrets`);
        if (!read.has(name)) report(`passes ${name}, which ${target} never reads`);
      }
      for (const name of read) if (!passed.has(name)) report(`${target} reads ${name} but the call does not pass it`);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------------------------------

function describeEntry(key: string, file: string, job?: string): string {
  return `${key} entry for ${file}${job === undefined ? '' : ` (job ${job})`}`;
}

function readEntry(key: string, raw: unknown, seen: Set<string>): AllowEntry | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `${key} holds an entry that is not an object`;
  const { file, job, reason, ...unknown } = raw as Record<string, unknown>;
  if (typeof file !== 'string' || file === '') return `${key} holds an entry without a file`;
  if (job !== undefined && (typeof job !== 'string' || job === '')) return `${key} entry for ${file} has a job that is not a name`;
  const name = describeEntry(key, file, job);
  if (Object.keys(unknown).length > 0) return `${name} has the unknown field ${Object.keys(unknown).join(', ')}`;
  if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LENGTH)
    return `${name} needs a reason of at least ${MIN_REASON_LENGTH} characters`;
  const identity = `${key}\u0000${file}\u0000${job ?? ''}`;
  if (seen.has(identity)) return `${name} is listed twice`;
  seen.add(identity);
  return job === undefined ? { file, reason } : { file, job, reason };
}

/** Parses the allow-list text. `null` means the file is absent, which is the same as an empty list. */
export function parseAllowList(source: string | null): { list: AllowList; problems: string[] } {
  const list: AllowList = { secretsInherit: [], pem: [], missingPermissions: [] };
  if (source === null) return { list, problems: [] };
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return { list, problems: ['is not valid JSON'] };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { list, problems: ['must be a JSON object'] };
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(data)) {
    const known = ALLOW_KEYS.find((candidate) => candidate === key);
    if (known === undefined) {
      problems.push(`has an unknown key ${key}`);
      continue;
    }
    if (!Array.isArray(value)) {
      problems.push(`${key} must be an array`);
      continue;
    }
    for (const raw of value) {
      const entry = readEntry(key, raw, seen);
      if (typeof entry === 'string') problems.push(entry);
      else list[known].push(entry);
    }
  }
  return { list, problems };
}

/** Moves the findings an entry covers to `allowed`, and reports each entry that covered nothing. */
export function applyAllowList(findings: Finding[], list: AllowList): { kept: Finding[]; allowed: Finding[]; stale: Finding[] } {
  const used = new Set<AllowEntry>();
  const kept: Finding[] = [];
  const allowed: Finding[] = [];
  for (const f of findings) {
    const key = ALLOW_KEY_FOR_RULE[f.rule];
    const matches = key ? list[key].filter((e) => e.file === f.file && (e.job === undefined || e.job === f.job)) : [];
    for (const entry of matches) used.add(entry);
    (matches.length > 0 ? allowed : kept).push(f);
  }
  const stale: Finding[] = [];
  for (const key of ALLOW_KEYS) {
    for (const entry of list[key]) {
      if (!used.has(entry))
        stale.push(finding('allow-list', ALLOW_LIST_PATH, 0, `${describeEntry(key, entry.file, entry.job)} matches nothing any more; remove it`));
    }
  }
  return { kept, allowed, stale };
}

// ---------------------------------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------------------------------

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION_FILE = /^\.github\/actions\/.+\/action\.ya?ml$/;

/** Variables that point git at another repository or index, as a hook sets them. */
const GIT_LOCATION_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
];

function trackedFiles(root: string): string[] {
  const env = { ...process.env };
  for (const name of GIT_LOCATION_VARIABLES) delete env[name];
  const listing = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return listing.split('\0').filter((name) => name !== '');
}

function statOrNull(target: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

function readIfPresent(target: string): string | null {
  return statOrNull(target) ? readFileSync(target, 'utf8') : null;
}

function cmp(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.rule, b.rule) || cmp(a.message, b.message));
}

/** Scans the files git tracks under `root`. Throws when git cannot list them: a guard that read nothing must not pass. */
export function scanRepo(root: string): RepoScan {
  const raw: Finding[] = [];
  const workflows = new Map<string, string>();
  const workflowFiles: string[] = [];
  let textFiles = 0;
  for (const file of trackedFiles(root)) {
    const onDisk = path.join(root, file);
    const isWorkflow = WORKFLOW_FILE.test(file) || ACTION_FILE.test(file);
    const stat = statOrNull(onDisk);
    // A file that is tracked but gone from the working tree cannot run, and cannot be read.
    if (!stat) continue;
    // Workflows are always read and always text. Other files are skipped when they are not plain text under 1 MB.
    if (!isWorkflow && (!stat.isFile() || stat.size > MAX_TEXT_BYTES)) continue;
    const bytes = readFileSync(onDisk);
    if (!isWorkflow && bytes.includes(0)) continue;
    const source = bytes.toString('utf8');
    textFiles++;
    raw.push(...scanPrivateKeys(file, source));
    if (isWorkflow) {
      workflowFiles.push(file);
      raw.push(...scanWorkflow(file, source));
      if (WORKFLOW_FILE.test(file)) workflows.set(file, source);
    }
  }
  raw.push(...scanSecretMaps(workflows));
  const { list, problems } = parseAllowList(readIfPresent(path.join(root, ALLOW_LIST_PATH)));
  const { kept, allowed, stale } = applyAllowList(raw, list);
  const malformed = problems.map((message) => finding('allow-list', ALLOW_LIST_PATH, 0, message));
  return { workflowFiles, textFiles, findings: sortFindings([...kept, ...malformed, ...stale]), allowed: sortFindings(allowed) };
}

// ---------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------

export function formatFinding(f: Finding): string {
  return `${f.file}${f.line > 0 ? `:${f.line}` : ''}: [${f.rule}] ${f.message}`;
}

const USAGE = 'usage: pnpm run check:workflows [--root <dir>] [--report]';

interface Output {
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Runs the guard and returns the exit code: 0 clean, 1 findings, 2 the guard could not run. */
export function main(rawArgv: string[], out: Output = console): number {
  // pnpm forwards the separator of `pnpm run check:workflows -- --report` to the script.
  const argv = rawArgv.filter((arg) => arg !== '--');
  let root = REPO_ROOT;
  let listReportOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--report') {
      listReportOnly = true;
    } else if (arg === '--root' && next !== undefined) {
      root = path.resolve(next);
      i++;
    } else if (arg === '--help' || arg === '-h') {
      out.log(USAGE);
      return 0;
    } else {
      out.error(`unknown argument ${arg ?? ''}\n${USAGE}`);
      return 2;
    }
  }
  let scan: RepoScan;
  try {
    scan = scanRepo(root);
  } catch (error) {
    out.error(`check-workflow-hygiene: cannot scan ${root}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    return 2;
  }
  const errors = scan.findings.filter((f) => !isReportOnly(f));
  const reportOnly = scan.findings.filter(isReportOnly);
  for (const f of errors) out.error(formatFinding(f));
  if (listReportOnly) for (const f of reportOnly) out.log(`${formatFinding(f)} (report only)`);
  out.log(
    `check-workflow-hygiene: ${scan.workflowFiles.length} workflow file(s) and ${scan.textFiles} text file(s) read, ` +
      `${errors.length} finding(s), ${scan.allowed.length} allow-listed, ${reportOnly.length} report-only`,
  );
  if (reportOnly.length > 0 && !listReportOnly)
    out.log('report-only findings are not errors while actions are referenced by tag; list them with --report');
  return errors.length > 0 ? 1 : 0;
}

if (isDirectScriptRun(import.meta.url, import.meta.main)) {
  process.exitCode = main(process.argv.slice(2));
}
