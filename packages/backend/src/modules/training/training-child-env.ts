import { Logger } from '@nestjs/common';

/**
 * The names a training child process may inherit from the Hub: the python3 trainer, and the probes the
 * governor runs. Matched exactly. A prefix such as `HF_` would also pass `HF_TOKEN`. Any other name
 * passes only by {@link passesByRule}.
 */
export const TRAINING_CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'PYTHONPATH',
  'PYTHONHOME',
  'VIRTUAL_ENV',
  'LD_LIBRARY_PATH',
  'CUDA_HOME',
  'CUDA_PATH',
  'HBPE_TRAIN_SEED',
  'CUDA_VISIBLE_DEVICES',
  'PYTORCH_CUDA_ALLOC_CONF',
  'PYTORCH_ENABLE_MPS_FALLBACK',
  'OMP_NUM_THREADS',
  'MKL_NUM_THREADS',
  'TOKENIZERS_PARALLELISM',
  'XDG_CACHE_HOME',
  'HF_HOME',
  'HF_HUB_CACHE',
  'TORCH_HOME',
  'MODELS_DIR',
  'HSA_OVERRIDE_GFX_VERSION',
  'HIP_VISIBLE_DEVICES',
  'ROCR_VISIBLE_DEVICES',
  'ROCM_PATH',
  'HIP_PATH',
] as const;

/**
 * Names the trainer reads its settings from: CI-Memory's `hbpe` config.py. A name passes by rule when it
 * has one of these prefixes or is one of these exact names, and it contains no denied substring.
 */
const RULE_PREFIXES: readonly string[] = ['HBPE_', 'QWEN_'];
const RULE_NAMES: readonly string[] = ['API_URL', 'LLM_API_BASE', 'LLM_DEFAULT_CHAT_MODEL'];

/**
 * A rule-path name containing one of these substrings, compared case-insensitively, is never copied. Each
 * looks like a credential, a session cookie, a DSN or a database URL. `DATABASE` stops `HBPE_DATABASE_URL`
 * and `QWEN_DATABASE_URL`. The `DATABASE_` opt-in is separate, and unchanged.
 */
const DENIED_SUBSTRINGS: readonly string[] = [
  'KEY',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASS',
  'CREDENTIAL',
  'CREDS',
  'AUTH',
  'COOKIE',
  'DSN',
  'DATABASE',
];

/**
 * True when the Hub variable `name` passes to a training child by rule. A name containing a denied
 * substring never passes. Names on the exact allowlist are not tested here.
 */
export function passesByRule(name: string): boolean {
  const upper = name.toUpperCase();
  const named = RULE_NAMES.includes(name);
  const prefixed = RULE_PREFIXES.some((prefix) => name.startsWith(prefix));
  const denied = DENIED_SUBSTRINGS.some((substring) => upper.includes(substring));
  return (named || prefixed) && !denied;
}

/**
 * Read from the Hub's own environment, which only the operator sets. A peer cannot set it: a peer's job
 * manifest never writes to this process's environment.
 */
const DATABASE_OPT_IN = 'CI_HUB_TRAIN_CHILD_INHERIT_DATABASE';
const DATABASE_PREFIX = 'DATABASE_';

const logger = new Logger('TrainingChildEnv');
/** One warning per process. The governor starts several children on every job, so not one per child. */
let databaseWarningLogged = false;

/** A value that starts with a URL scheme, such as `https://`. Only these are tested for credentials or a query. */
const URL_VALUED = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The names whose withheld URL has been warned about. One warning per variable per process. */
const urlWarningsLogged = new Set<string>();

/**
 * True when `value` is a URL that must not reach a child: one with credentials (`scheme://user[:password]@host`),
 * one with a query string, or one that does not parse. A value that does not start with a URL scheme is never
 * withheld.
 */
function isWithheldUrl(value: string): boolean {
  if (!URL_VALUED.test(value)) return false;
  try {
    const url = new URL(value);
    return url.username !== '' || url.password !== '' || value.includes('?');
  } catch {
    return true;
  }
}

/** Copies `value` into `env`, unless it is a withheld URL. The warning names the variable, and never the value. */
function copyUnlessWithheld(env: Record<string, string>, name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (!isWithheldUrl(value)) {
    env[name] = value;
    return;
  }
  if (!urlWarningsLogged.has(name)) {
    urlWarningsLogged.add(name);
    logger.warn(`${name} is not passed to training children: its URL-valued setting has credentials or a query string, or does not parse.`);
  }
}

/**
 * The environment for a training child, built from `source` (the Hub's own environment by default).
 *
 * It holds the allowlisted names that are defined and the names that pass by rule, and no other name from
 * the Hub. A URL-valued setting from the allowlist or the rule path is withheld when it has credentials or a
 * query string. `DATABASE_` names are passed only when the operator sets {@link DATABASE_OPT_IN} to `true`,
 * for hosts whose trainer builds its vocabulary from the database. `PYTHONUNBUFFERED` is set so progress
 * lines reach the runner as they are written, and `CI_HUB_TRAINING_CHILD` marks the child as one the Hub started.
 */
export function trainingChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of TRAINING_CHILD_ENV_ALLOWLIST) {
    copyUnlessWithheld(env, name, source[name]);
  }

  for (const [name, value] of Object.entries(source)) {
    if (passesByRule(name)) copyUnlessWithheld(env, name, value);
  }

  const databaseEntries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith(DATABASE_PREFIX) && value !== undefined) databaseEntries.push([name, value]);
  }

  if (source[DATABASE_OPT_IN] === 'true') {
    for (const [name, value] of databaseEntries) env[name] = value;
  } else if (databaseEntries.length > 0 && !databaseWarningLogged) {
    databaseWarningLogged = true;
    logger.warn(
      `DATABASE_ variables are set but not passed to peer training jobs. Set ${DATABASE_OPT_IN}=true in this Hub's environment to pass them to training children.`,
    );
  }

  env.PYTHONUNBUFFERED = '1';
  env.CI_HUB_TRAINING_CHILD = '1';
  return env;
}
