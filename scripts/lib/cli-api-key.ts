/**
 * Operator API keys from the terminal.
 *
 * Writes the `api_key` row directly over `docker exec psql` because the CLI already holds
 * appliance-level privilege and headless setup has no browser. Several constants here mirror
 * ApiKeyService and the Drizzle schema; the comments below name each counterpart to keep them
 * in step.
 */
import { createHash, randomBytes } from 'node:crypto';
import { usageAndExit } from './cli-args.js';
import { BASE_COMMAND } from './cli-types.js';
import { bold, printMessageBox, sanitizeForBox } from './cli-ui.js';
import { type ContainerReader, type ContainerReadOptions, containerReader, describeDockerEndpoint } from './docker-exec-output.js';

const API_KEY_DB_CONTAINER = 'ci-hub-db';
const API_KEY_DB_PORT = '6543';
const API_KEY_DB_USER = 'companion';
const API_KEY_DB_NAME = 'companiondb';
const API_KEY_BYTES = 32; // 64 hex chars — mirrors KEY_BYTES in ApiKeyService
const API_KEY_PREFIX_LEN = 8; // mirrors PREFIX_LEN in ApiKeyService

/**
 * Scopes an *operator* key may carry — deliberately narrower than API_KEY_SCOPES in
 * packages/backend/src/modules/api-keys/api-key.scopes.ts, in the same relative order so a row this
 * command writes sorts like one the service wrote. Wider than the UI by 'qa:read' and 'inference'
 * (ApiKeyAdminService pins operator keys to ['mcp']): a test key is minted over ssh on the node under
 * test, and an editor key on the Hub host where the operator is already at a terminal, which is
 * where this command runs and a browser usually is not.
 *
 * 'app' is honoured only on a *managed* row: resolveManagedAppUrn requires `managed` and an owning
 * app URN, both of which only app provisioning sets. An operator key carrying 'app' would list as
 * correctly provisioned and authenticate nothing — the same "credential that isn't one" this
 * command exists to retire.
 */
const OPERATOR_API_KEY_SCOPES: readonly string[] = ['mcp', 'qa:read', 'inference'];

/**
 * Scopes that must be the only scope on their key — mirrors QA_READ_SCOPE and INFERENCE_SCOPE in
 * api-key.scopes.ts.
 *
 * Each of these opens one narrow surface and no operator authority: `qa:read` is the credential a
 * test harness holds so that it does NOT hold operator authority, and `inference` is the credential
 * an editor or SDK holds in a config file that syncs to clouds and lives in dotfiles repos. One row
 * carrying 'mcp' as well would hand that harness, or whoever finds that config file, the whole MCP
 * tool surface under a name that says "read" or "inference" — the exact mistake each scope exists
 * to prevent. The backend does not refuse the combination; this command is where it is refused.
 */
const STANDALONE_API_KEY_SCOPES: readonly string[] = ['qa:read', 'inference'];

/**
 * What a `qa:read` key reaches — mirrors the handlers marked `@ObservabilityRead()` in the backend.
 * Printed at creation so the operator minting it sees the whole of its authority.
 */
const QA_READ_ROUTES: readonly string[] = [
  'GET /api/inference/pool/status',
  'GET /api/inference/pool/routing-log',
  'GET /api/apps/:urn (without the app config)',
  'GET /api/apps/install-queue',
];

/**
 * What an `inference` key reaches — the two base paths `InferenceAccessGuard` sits in front of, as
 * an editor's "base URL" field wants them rather than as a route list. Handler-level: every `/v1`
 * route on `InferenceController` and every app-facing route on `HubPoolController` and
 * `HubPoolOllamaCompatController`. Not `QA_READ_ROUTES` shape on purpose: the operator minting this
 * key is about to paste a base URL into Continue or Zed, and a route list would make them derive it.
 */
const INFERENCE_BASES: readonly { label: string; base: string }[] = [
  { label: 'OpenAI-compatible', base: 'http://<hub-host>:5002/api/inference/v1' },
  { label: 'Ollama-compatible', base: 'http://<hub-host>:5002/api/inference/pool' },
];

/** Scopes that exist but are only ever minted for an app, so the error can say why, not just "unknown". */
const MANAGED_ONLY_API_KEY_SCOPES: readonly string[] = ['app'];

/**
 * What a key may DO on the surfaces its scopes reach — mirrors API_KEY_CAPABILITIES in
 * packages/backend/src/modules/api-keys/api-key.capabilities.ts.
 *
 * 'read' is offered here, not just in the UI, because the headless case is where it matters most: a
 * key minted over ssh for a third-party MCP client should be mintable read-only in the same breath,
 * not created wide and tightened later in a browser.
 */
const API_KEY_CAPABILITIES: readonly string[] = ['read', 'write', 'full'];

/** Mirrors DEFAULT_API_KEY_CAPABILITY: what a key can do when nobody said. */
const DEFAULT_API_KEY_CAPABILITY = 'write';

/** Escape a value for single-quoted SQL. Names are also validated before they reach here. */
export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Key names are interpolated into SQL, so the character set is deliberately narrow — quoting alone
 * is not the only line of defence. `app:` is reserved for keys the Hub provisions to marketplace
 * apps; an operator key must not be able to impersonate one. A leading `-` is refused too: it is
 * never a sensible label, and it is what a flag whose value was forgotten looks like by the time it
 * reaches here — `--name=--scopes` arrives intact, the space-separated form having already been
 * refused by {@link readApiKeyFlag}.
 */
export function isValidApiKeyName(name: string): boolean {
  return /^[\w .:@][\w .:@-]{0,63}$/.test(name) && !name.startsWith('app:');
}

/**
 * Split a `--scopes` value into the scopes an operator key may hold, the app-only ones, and the
 * unrecognised ones — the caller refuses the last two with different explanations.
 *
 * Deduped and ordered by OPERATOR_API_KEY_SCOPES, mirroring ApiKeyService.normalizeScopes: a row
 * this command writes should be indistinguishable from one the service wrote for the same grant.
 */
export function parseApiKeyScopes(input: string): { scopes: string[]; invalid: string[]; managedOnly: string[] } {
  const requested = [
    ...new Set(
      input
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const allowed = OPERATOR_API_KEY_SCOPES.filter((scope) => requested.includes(scope));
  const rejected = requested.filter((scope) => !allowed.includes(scope));

  return {
    scopes: [...allowed, ...rejected],
    managedOnly: rejected.filter((scope) => MANAGED_ONLY_API_KEY_SCOPES.includes(scope)),
    invalid: rejected.filter((scope) => !MANAGED_ONLY_API_KEY_SCOPES.includes(scope)),
  };
}

/**
 * Why this scope set may not be minted as one key, or `null` when it may.
 *
 * Worded for whichever standalone scope was asked for, and for the reason that is the same in every
 * case — one credential, two blast radii. `qa:read,inference` names both, each needing its own key.
 */
function apiKeyScopeConflict(scopes: string[]): string | null {
  const standalone = scopes.filter((scope) => STANDALONE_API_KEY_SCOPES.includes(scope));
  if (standalone.length === 0 || scopes.length === 1) return null;
  const subject =
    standalone.length === 1
      ? `The '${standalone[0]}' scope must be the only scope on its key: it opens`
      : `Each of ${standalone.map((scope) => `'${scope}'`).join(' and ')} must be the only scope on its key: each opens`;
  return (
    `${subject} one narrow surface and no operator authority, and a key that also carried another scope would be ` +
    'one credential with two unrelated blast radii. Create a separate key for each scope.'
  );
}

/**
 * Build the INSERT for a new key. Split out from the command so the one string that actually reaches
 * the database is unit-testable — the validation above narrows what can get here, but the quoting is
 * the last line of defence and deserves its own assertions.
 */
export function buildApiKeyInsertSql(row: {
  name: string;
  scopes: string[];
  capability: string;
  prefix: string;
  hashedKey: string;
  /** False on a Hub released before per-key capability existed. */
  withCapability?: boolean;
}): string {
  const scopeArray = `ARRAY[${row.scopes.map(sqlQuote).join(',')}]::text[]`;

  if (row.withCapability === false) {
    return (
      `INSERT INTO api_key (name, scopes, prefix, hashed_key) VALUES (${sqlQuote(row.name)}, ${scopeArray}, ` +
      `${sqlQuote(row.prefix)}, ${sqlQuote(row.hashedKey)}) RETURNING id;`
    );
  }

  return (
    `INSERT INTO api_key (name, scopes, capability, prefix, hashed_key) VALUES (${sqlQuote(row.name)}, ${scopeArray}, ` +
    `${sqlQuote(row.capability)}, ${sqlQuote(row.prefix)}, ${sqlQuote(row.hashedKey)}) RETURNING id;`
  );
}

/**
 * Does this Hub's `api_key` table carry the `capability` column?
 *
 * Per-key capability arrived after several published Hub releases, and the CLI is run
 * against whatever appliance is in front of it — an older one than the checkout is the
 * normal case, not an edge case. Verified against a live 0.2.47: without this the insert
 * dies on `column "capability" of relation "api_key" does not exist`, so the documented
 * headless key-minting route fails outright on exactly the appliances that most need a
 * CLI, since minting in the browser is what it exists to avoid.
 *
 * A failed query is treated as "present": that keeps the modern path first, and a
 * genuinely missing column still surfaces as the same insert error as before.
 *
 * The query answers `t` or `f` and never nothing, so an answer that could not be read returns `null`
 * rather than passing for "no column". It did pass for that on a Windows Hub whose Docker engine runs
 * in WSL2, and `--capability read` then created a key that can read and write.
 */
export function apiKeyTableHasCapability(read: ContainerReader): boolean | null {
  const result = psql(read, "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_key' AND column_name='capability');");
  if (result.lost) return null;
  if (!result.ok) return true;
  const answer = result.stdout.split('\n')[0]?.trim();
  return answer === 't' ? true : answer === 'f' ? false : null;
}

/**
 * Render the `api-key list` JSON document as display rows.
 *
 * Tolerates a malformed/empty document by returning no rows rather than throwing: the caller has
 * already handled the psql failure case, and a parse error here should not crash the CLI.
 */
export function formatApiKeyRows(json: string, withCapability = true): string[] {
  let parsed: Array<{ id?: number; name?: string; scopes?: string[]; capability?: string; prefix?: string }>;

  try {
    parsed = JSON.parse(json || '[]');
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.map((row) => {
    const scopes = Array.isArray(row.scopes) && row.scopes.length > 0 ? row.scopes.join(',') : '-';
    // Shown for every key, including ones minted before the column existed (which read as 'write',
    // the column default) — a listing that omitted it would make a read-only key look unrestricted.
    //
    // But on a Hub with no capability column there is no per-key capability to report, and
    // defaulting to 'write' there would state a restriction the server does not enforce. Omit the
    // field entirely rather than invent one.
    const capability = withCapability
      ? ` ${typeof row.capability === 'string' && row.capability ? row.capability : DEFAULT_API_KEY_CAPABILITY} `
      : ' ';

    // Names reach this box unfiltered from the key store, and the store does not constrain them:
    // the UI's create body is `z.string().trim().min(1).max(100)`, so a name may hold ANSI escapes
    // or other control characters. Collapse whitespace first (so one key still cannot span rows),
    // then drop every remaining control character — unstripped they would be written straight to
    // the terminal, and they count toward string length, which also skews the box width.
    const name = sanitizeForBox(String(row.name ?? ''));

    return `${row.id}  ${name}  [${scopes}] ${capability} ${row.prefix ?? ''}…`;
  });
}

/**
 * Run one statement against the Hub database.
 *
 * Captures stderr as well as stdout — psql reports *every* failure there (container down, missing
 * relation, unique violation), so a stdout-only capture like {@link runCapture} would render a
 * duplicate-key error and a stopped Hub as the same blank "non-zero exit code".
 *
 * Every statement this module sends prints at least one row, which is what lets `read` tell output
 * that never arrived from an empty answer (see docker-exec-output.ts).
 */
function psql(read: ContainerReader, sql: string, options?: ContainerReadOptions): { stdout: string; stderr: string; ok: boolean; lost: boolean } {
  const result = read(['psql', '-U', API_KEY_DB_USER, '-d', API_KEY_DB_NAME, '-p', API_KEY_DB_PORT, '-At', '-c', sql], options);

  return { stdout: result.stdout, stderr: result.stderr, ok: result.status === 0, lost: result.lost === true };
}

/** psql's answer never reached this process: say through which Docker engine, and stop. */
function exitOnLostAnswer(title: string, advice: string[]): never {
  printMessageBox(
    title,
    ["psql's answer did not come back through", `${describeDockerEndpoint()}, from docker exec or from docker cp.`, ...advice],
    'red',
  );
  process.exit(1);
}

/** psql's own diagnosis, as box lines. Capped so a stack of NOTICEs can't swamp the message. */
function psqlErrorLines(result: { stdout: string; stderr: string }): string[] {
  const detail = (result.stderr || result.stdout).split('\n').filter(Boolean).slice(0, 6);

  return detail.length > 0 ? detail : ['psql returned a non-zero exit code'];
}

/** {@link INFERENCE_BASES} as aligned box lines, so the two URLs read as a column to copy from. */
function inferenceBaseLines(): string[] {
  const width = Math.max(...INFERENCE_BASES.map(({ label }) => label.length)) + 3;

  return INFERENCE_BASES.map(({ label, base }) => `  ${label.padEnd(width)}${base}`);
}

/**
 * Read `--flag value` or `--flag=value`, the two spellings being interchangeable — the same rule
 * `readValue` applies in cli-fleet.ts.
 *
 * Matching only the space-separated form made `--capability=full` *invisible*: the key was minted at
 * DEFAULT_API_KEY_CAPABILITY and the box reported that as the grant, so the operator was told a key
 * they had not asked for was the key they had. A flag that decides privilege must never be readable
 * as absent, which is why a missing value exits here rather than returning something the caller
 * would fall back on.
 */
function readApiKeyFlag(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index < 0) return undefined;

  const arg = args[index] as string;
  if (arg !== flag) return arg.slice(flag.length + 1);

  const next = args[index + 1];
  if (next === undefined || next.startsWith('-')) usageAndExit(`Missing value for ${flag}.`);
  return next;
}

/**
 * Operator API keys from the terminal.
 *
 * SEC-MCP-8 made the hashed store the sole auth authority and deliberately removed the guard's env
 * fallback, so `MCP_API_KEY` authenticates nothing. Until now the only way to obtain a real key was
 * the browser UI (Settings → Security), which blocks headless and remote setup. The CLI already
 * holds appliance-level privilege (it owns the env file and drives docker), so it writes the row.
 *
 * Columns mirror `api_key` in packages/backend/src/core/database/drizzle/schema.ts; the hash mirrors
 * ApiKeyService.hash() (sha256 hex). Keep all three in step if the schema moves.
 */
export function runApiKeyCommand(args: string[]) {
  const subcommand = args[0] || 'list';

  if (subcommand === 'create') {
    const name = readApiKeyFlag(args, '--name');
    if (!name)
      usageAndExit(
        `Usage: ${BASE_COMMAND} api-key create --name <label> [--scope ${OPERATOR_API_KEY_SCOPES.join('|')}] ` +
          `[--capability ${API_KEY_CAPABILITIES.join('|')}]`,
      );
    if (!isValidApiKeyName(name)) {
      usageAndExit(
        `Invalid key name. Use 1-64 chars of letters, digits, space, or . : @ _ - starting with anything but '-', and do not start with 'app:' (reserved for managed app keys).`,
      );
    }

    // `--scope` and `--scopes` are the same flag: a key usually has one scope, and the singular is what
    // the fleet QA plan and the refusal messages below spell. Both at once is refused rather than one
    // silently winning: `--scopes mcp --scope qa:read` would otherwise mint a write-capable MCP key for
    // someone who asked for the read-only one, and the box that says so scrolls past in a script.
    const scopesFlag = readApiKeyFlag(args, '--scopes');
    const scopeFlag = readApiKeyFlag(args, '--scope');
    if (scopesFlag !== undefined && scopeFlag !== undefined) usageAndExit('Give --scope or --scopes, not both: they are the same flag.');
    const { scopes, invalid, managedOnly } = parseApiKeyScopes(scopesFlag ?? scopeFlag ?? 'mcp');
    if (scopes.length === 0) usageAndExit(`At least one scope is required. Valid: ${OPERATOR_API_KEY_SCOPES.join(', ')}`);
    if (managedOnly.length > 0) {
      usageAndExit(
        `The '${managedOnly.join("', '")}' scope is carried only by managed keys the Hub provisions to installed apps — the callback guard checks the key's owning app, so an operator key holding it would authenticate nothing. Use --scopes ${OPERATOR_API_KEY_SCOPES.join(',')}.`,
      );
    }
    if (invalid.length > 0) usageAndExit(`Unknown scope(s): ${invalid.join(', ')}. Valid: ${OPERATOR_API_KEY_SCOPES.join(', ')}`);
    const conflict = apiKeyScopeConflict(scopes);
    if (conflict) usageAndExit(conflict);

    const isQaRead = scopes.includes('qa:read');
    const isInference = scopes.includes('inference');
    const requestedCapability = readApiKeyFlag(args, '--capability');
    // Capability decides what an MCP key may do among tools; a `qa:read` key has no tools, only its
    // route list. Stored as 'read' so `api-key list` does not show a test key as 'write', and an explicit
    // wider value is refused rather than stored as a grant the server would never apply.
    if (isQaRead && requestedCapability !== undefined && requestedCapability !== 'read') {
      usageAndExit(`A qa:read key reads a fixed list of routes; --capability ${requestedCapability || '(empty)'} would do nothing. Omit it.`);
    }
    // Same for an `inference` key: InferenceAccessGuard checks the scope and never reads capability,
    // so 'full' on this row would be a listing that claims the key can uninstall apps when it can
    // only spend GPU time. Stored as 'read' for the same reason qa:read is.
    if (isInference && requestedCapability !== undefined && requestedCapability !== 'read') {
      usageAndExit(
        `An inference key opens the inference routes and no MCP tools; capability gates MCP tools only, so --capability ${requestedCapability || '(empty)'} would do nothing. Omit it.`,
      );
    }
    const capability = requestedCapability ?? (isQaRead || isInference ? 'read' : DEFAULT_API_KEY_CAPABILITY);
    if (!API_KEY_CAPABILITIES.includes(capability)) {
      usageAndExit(
        `Unknown capability: ${capability || '(empty)'}. Valid: ${API_KEY_CAPABILITIES.join(', ')} — ` +
          "'read' calls read-only tools, 'write' also mutates (install/start/stop/reconfigure), 'full' also runs destructive tools (uninstall/reset/delete).",
      );
    }

    const rawKey = randomBytes(API_KEY_BYTES).toString('hex');
    const read = containerReader(API_KEY_DB_CONTAINER);
    const withCapability = apiKeyTableHasCapability(read);
    if (withCapability === null) {
      exitOnLostAnswer('API key not created', [
        'Without it there is no telling whether this Hub can store a capability.',
        '',
        'Create the key in Settings → Security instead.',
      ]);
    }
    // On a Hub with no capability column every key can do everything its scopes allow, so a key
    // created there for `--capability read` would be the opposite of what was asked for.
    if (!withCapability && requestedCapability !== undefined) {
      printMessageBox(
        'API key not created',
        [
          `This Hub predates per-key capability, so it cannot store --capability ${capability}.`,
          'Every key it holds can do everything its scopes allow.',
          '',
          'Update the Hub for capability-limited keys, or leave out --capability.',
        ],
        'red',
      );
      process.exit(1);
    }
    const sql = buildApiKeyInsertSql({
      name,
      scopes,
      capability,
      prefix: rawKey.slice(0, API_KEY_PREFIX_LEN),
      hashedKey: createHash('sha256').update(rawKey).digest('hex'),
      withCapability,
    });

    // Never run twice: the probe above has already found out whether output comes back.
    const result = psql(read, sql, { repeatable: false });
    if (result.lost) {
      exitOnLostAnswer('API key not confirmed', ['', `The key may have been created anyway. If Settings → Security lists "${name}", revoke it.`]);
    }
    const { stdout, ok } = result;
    if (!ok) {
      printMessageBox('API key creation failed', [...psqlErrorLines(result), '', `Is the Hub running? Try ${bold(`${BASE_COMMAND} up`)}.`], 'red');
      process.exit(1);
    }

    // Even with -At, psql appends its command tag ("INSERT 0 1") after the RETURNING row.
    const newId = stdout.split('\n')[0]?.trim() ?? '';

    printMessageBox(
      'API key created',
      [
        `${bold('id')}      ${newId}`,
        `${bold('name')}    ${name}`,
        `${bold('scopes')}  ${scopes.join(', ')}`,
        // Reporting a capability on a Hub that cannot store one would be a plain untruth about how
        // much authority the key just gained. A requested one was refused above.
        ...(withCapability
          ? [`${bold('can')}     ${capability}`]
          : [
              `${bold('can')}     everything its scopes allow`,
              '',
              'This Hub predates per-key capability, so there is no read/write/full',
              'distinction to apply. Update the Hub if you need capability-limited keys.',
            ]),
        ...(isQaRead ? ['', 'Accepted only on:', ...QA_READ_ROUTES.map((route) => `  ${route}`), 'Every other route refuses it.'] : []),
        // Printed as base URLs because that is the field the operator is about to fill in. As with
        // qa:read, this command cannot tell whether the Hub in front of it knows the scope: a Hub built
        // before `inference` existed accepts the row (scopes is an unchecked text[]) but authenticates
        // nothing with it, and answers the editor 403 "only available on the local appliance network".
        ...(isInference ? ['', 'Accepted only on the inference routes:', ...inferenceBaseLines(), 'Every other route refuses it.'] : []),
        '',
        `${bold('key')}     ${rawKey}`,
        '',
        'This is the only time the key is shown. Store it now.',
        // Capability is inert on both standalone scopes, so "change what it can do" would send the
        // operator to a control that does nothing to this key.
        isQaRead || isInference ? 'Revoke it in Settings → Security.' : 'Change what it can do, or revoke it, in Settings → Security.',
      ],
      'green',
    );
    return;
  }

  if (subcommand === 'list') {
    // Aggregate to a single JSON document rather than concatenating columns: key names predate this
    // command's validation (the UI accepts any string), so a name containing a newline or the
    // separator would otherwise split into bogus rows.
    // Same schema split as `create`: selecting a column an older Hub does not have fails the whole
    // query, so `api-key list` was unusable on every published release rather than degrading.
    const read = containerReader(API_KEY_DB_CONTAINER);
    const withCapability = apiKeyTableHasCapability(read);
    if (withCapability === null) exitOnLostAnswer('Could not read API keys', ['', 'Settings → Security lists them.']);
    const fields = ["'id', id", "'name', name", "'scopes', scopes", ...(withCapability ? ["'capability', capability"] : []), "'prefix', prefix"].join(
      ', ',
    );
    const result = psql(read, `SELECT COALESCE(json_agg(json_build_object(${fields}) ORDER BY id)::text, '[]') FROM api_key;`);
    if (result.lost) exitOnLostAnswer('Could not read API keys', ['', 'Settings → Security lists them.']);
    if (!result.ok) {
      printMessageBox('Could not read API keys', [...psqlErrorLines(result), '', `Is the Hub running? Try ${bold(`${BASE_COMMAND} up`)}.`], 'red');
      process.exit(1);
    }
    // The query prints `[]` when there are no keys, so no answer at all is one that was lost. Read as
    // "no keys", it told the operator of a Hub holding eight that it had none.
    if (!result.stdout) exitOnLostAnswer('Could not read API keys', ['', 'Settings → Security lists them.']);
    const rows = formatApiKeyRows(result.stdout, withCapability);
    printMessageBox('API keys', rows.length > 0 ? rows : ['(none — create one with `api-key create --name <label>`)'], 'cyan');
    return;
  }

  usageAndExit(`Unknown api-key subcommand: ${subcommand}. Use: create, list`);
}
