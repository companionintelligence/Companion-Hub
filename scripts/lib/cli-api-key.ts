/**
 * Operator API keys from the terminal.
 *
 * Writes the `api_key` row directly over `docker exec psql` because the CLI already holds
 * appliance-level privilege and headless setup has no browser. Several constants here mirror
 * ApiKeyService and the Drizzle schema; the comments below name each counterpart to keep them
 * in step.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { usageAndExit } from './cli-args.js';
import { BASE_COMMAND } from './cli-types.js';
import { bold, printMessageBox, sanitizeForBox } from './cli-ui.js';

const API_KEY_DB_CONTAINER = 'ci-hub-db';
const API_KEY_DB_PORT = '6543';
const API_KEY_DB_USER = 'companion';
const API_KEY_DB_NAME = 'companiondb';
const API_KEY_BYTES = 32; // 64 hex chars — mirrors KEY_BYTES in ApiKeyService
const API_KEY_PREFIX_LEN = 8; // mirrors PREFIX_LEN in ApiKeyService

/**
 * Scopes an *operator* key may carry — deliberately narrower than API_KEY_SCOPES in
 * packages/backend/src/modules/api-keys/api-key.scopes.ts, and the same line ApiKeyAdminService
 * takes for the UI (it pins operator keys to ['mcp']).
 *
 * 'app' is honoured only on a *managed* row: resolveManagedAppUrn requires `managed` and an owning
 * app URN, both of which only app provisioning sets. An operator key carrying 'app' would list as
 * correctly provisioned and authenticate nothing — the same "credential that isn't one" this
 * command exists to retire.
 */
const OPERATOR_API_KEY_SCOPES: readonly string[] = ['mcp'];

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
 * Unknown answers are treated as "present": that keeps the modern path first, and a
 * genuinely missing column still surfaces as the same insert error as before.
 */
export function apiKeyTableHasCapability(): boolean {
  const result = psql("SELECT 1 FROM information_schema.columns WHERE table_name='api_key' AND column_name='capability';");
  if (!result.ok) return true;
  return result.stdout.split('\n')[0]?.trim() === '1';
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
 */
function psql(sql: string): { stdout: string; stderr: string; ok: boolean } {
  const result = spawnSync(
    'docker',
    ['exec', API_KEY_DB_CONTAINER, 'psql', '-U', API_KEY_DB_USER, '-d', API_KEY_DB_NAME, '-p', API_KEY_DB_PORT, '-At', '-c', sql],
    { encoding: 'utf-8', stdio: 'pipe' },
  );

  return {
    stdout: (result.stdout || '').trim(),
    // result.error covers docker itself being absent, where there is no stderr to read.
    stderr: (result.stderr || '').trim() || (result.error ? String(result.error) : ''),
    ok: result.status === 0,
  };
}

/** psql's own diagnosis, as box lines. Capped so a stack of NOTICEs can't swamp the message. */
function psqlErrorLines(result: { stdout: string; stderr: string }): string[] {
  const detail = (result.stderr || result.stdout).split('\n').filter(Boolean).slice(0, 6);

  return detail.length > 0 ? detail : ['psql returned a non-zero exit code'];
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
        `Usage: ${BASE_COMMAND} api-key create --name <label> [--scopes ${OPERATOR_API_KEY_SCOPES.join(',')}] ` +
          `[--capability ${API_KEY_CAPABILITIES.join('|')}]`,
      );
    if (!isValidApiKeyName(name)) {
      usageAndExit(
        `Invalid key name. Use 1-64 chars of letters, digits, space, or . : @ _ - starting with anything but '-', and do not start with 'app:' (reserved for managed app keys).`,
      );
    }

    const { scopes, invalid, managedOnly } = parseApiKeyScopes(readApiKeyFlag(args, '--scopes') ?? 'mcp');
    if (scopes.length === 0) usageAndExit(`At least one scope is required. Valid: ${OPERATOR_API_KEY_SCOPES.join(', ')}`);
    if (managedOnly.length > 0) {
      usageAndExit(
        `The '${managedOnly.join("', '")}' scope is carried only by managed keys the Hub provisions to installed apps — the callback guard checks the key's owning app, so an operator key holding it would authenticate nothing. Use --scopes ${OPERATOR_API_KEY_SCOPES.join(',')}.`,
      );
    }
    if (invalid.length > 0) usageAndExit(`Unknown scope(s): ${invalid.join(', ')}. Valid: ${OPERATOR_API_KEY_SCOPES.join(', ')}`);

    const capability = readApiKeyFlag(args, '--capability') ?? DEFAULT_API_KEY_CAPABILITY;
    if (!API_KEY_CAPABILITIES.includes(capability)) {
      usageAndExit(
        `Unknown capability: ${capability || '(empty)'}. Valid: ${API_KEY_CAPABILITIES.join(', ')} — ` +
          "'read' calls read-only tools, 'write' also mutates (install/start/stop/reconfigure), 'full' also runs destructive tools (uninstall/reset/delete).",
      );
    }

    const rawKey = randomBytes(API_KEY_BYTES).toString('hex');
    const withCapability = apiKeyTableHasCapability();
    const sql = buildApiKeyInsertSql({
      name,
      scopes,
      capability,
      prefix: rawKey.slice(0, API_KEY_PREFIX_LEN),
      hashedKey: createHash('sha256').update(rawKey).digest('hex'),
      withCapability,
    });

    const result = psql(sql);
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
        // Reporting the requested capability on a Hub that cannot store it would be a
        // plain untruth about how much authority the key just gained.
        ...(withCapability
          ? [`${bold('can')}     ${capability}`]
          : [
              `${bold('can')}     everything its scopes allow`,
              '',
              'This Hub predates per-key capability, so there is no read/write/full',
              `distinction to apply and ${bold(`--capability ${capability}`)} was not stored.`,
              'Update the Hub if you need capability-limited keys.',
            ]),
        '',
        `${bold('key')}     ${rawKey}`,
        '',
        'This is the only time the key is shown. Store it now.',
        'Change what it can do, or revoke it, in Settings → Security.',
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
    const withCapability = apiKeyTableHasCapability();
    const fields = ["'id', id", "'name', name", "'scopes', scopes", ...(withCapability ? ["'capability', capability"] : []), "'prefix', prefix"].join(
      ', ',
    );
    const result = psql(`SELECT COALESCE(json_agg(json_build_object(${fields}) ORDER BY id)::text, '[]') FROM api_key;`);
    if (!result.ok) {
      printMessageBox('Could not read API keys', [...psqlErrorLines(result), '', `Is the Hub running? Try ${bold(`${BASE_COMMAND} up`)}.`], 'red');
      process.exit(1);
    }
    const rows = formatApiKeyRows(result.stdout, withCapability);
    printMessageBox('API keys', rows.length > 0 ? rows : ['(none — create one with `api-key create --name <label>`)'], 'cyan');
    return;
  }

  usageAndExit(`Unknown api-key subcommand: ${subcommand}. Use: create, list`);
}
