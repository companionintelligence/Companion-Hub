import { Logger } from '@nestjs/common';

/**
 * The names a training child process may inherit from the Hub: the python3 trainer, and the probes the
 * governor runs. Matched exactly. A prefix such as `HF_` would also pass `HF_TOKEN`. A name here is copied even
 * when it contains a denied substring, as `TOKEN` does in `QWEN_MAX_TOKENS_NO_THINK`, `TOKEN_CORPUS_DIR` and
 * `TOKENIZERS_PARALLELISM`: the denylist is applied on the rule path only. Any other name passes only by
 * {@link passesByRule}.
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
  'QWEN_MAX_TOKENS_NO_THINK',
  'TOKEN_CORPUS_DIR',
  'CLUSTER_STALENESS_DAYS',
  'FUNCTION_RUNNER_CONCURRENCY',
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

/**
 * The URL rule. A value is URL-valued when its trimmed form matches this pattern: a letter, then letters, digits,
 * plus, dot or hyphen, then a colon, then a slash or a backslash, at the start of the value; or an at sign anywhere;
 * or a question mark anywhere. The scheme is anchored to the start of the value. Unanchored, `/usr/bin:/bin` would
 * match, and PATH would never reach a child. A model tag such as `qwen3:8b` has no slash after its colon, so it is
 * copied. A path-valued name is not checked against this rule (see {@link isPathValued}).
 */
const URL_VALUED = /^[a-z][a-z0-9+.-]*:[\\/]|@|\?/i;

/**
 * Names whose value is a path: a directory, a cache, a tool home or a search path. A path can hold an at sign, as the
 * Homebrew PATH does with its `openjdk@21` directory, so these values are copied as the Hub has them and are never
 * URL-checked.
 */
const PATH_VALUED: ReadonlySet<string> = new Set([
  'PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'LD_LIBRARY_PATH',
  'VIRTUAL_ENV',
  'CUDA_HOME',
  'CUDA_PATH',
  'HOME',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'HF_HOME',
  'HF_HUB_CACHE',
  'TORCH_HOME',
  'MODELS_DIR',
  'ROCM_PATH',
  'HIP_PATH',
  'TOKEN_CORPUS_DIR',
]);

/** A rule-path name ending in one of these is path-valued too. */
const PATH_SUFFIXES: readonly string[] = ['_PATH', '_DIR', '_HOME'];

/** True for a name whose value is a path, so the URL rule is not applied to its value. */
function isPathValued(name: string): boolean {
  if (PATH_VALUED.has(name)) return true;
  return passesByRule(name) && PATH_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** The names whose withheld URL has been warned about. One warning per variable per process. */
const urlWarningsLogged = new Set<string>();

/** True for a character that is trimmed from either end of a value: an ASCII control, DEL, a space, or other whitespace. */
function isEdgePadding(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x20 || code === 0x7f || char.trim() === '';
}

/** The value without its leading and trailing padding. {@link copyUnlessWithheld} computes it once per value. */
function trimmedOf(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isEdgePadding(value.charAt(start))) start += 1;
  while (end > start && isEdgePadding(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

/**
 * Copies `value` into `env`, unless it is URL-valued and its name is not path-valued. The rule reads the trimmed value,
 * and the copy is the value as the Hub has it. A withheld value is never logged: the warning names only the variable,
 * once per process, and says the setting looks like a URL or carries a credential or query separator. An at sign or a
 * question mark alone can trigger the rule, so the warning does not say that the value looks like a URL.
 */
function copyUnlessWithheld(env: Record<string, string>, name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (isPathValued(name) || !URL_VALUED.test(trimmedOf(value))) {
    env[name] = value;
    return;
  }
  if (!urlWarningsLogged.has(name)) {
    urlWarningsLogged.add(name);
    logger.warn(
      `${name} is not passed to training children: the setting looks like a URL or carries a credential or query separator, so it was withheld.`,
    );
  }
}

/**
 * The environment for a training child, built from `source` (the Hub's own environment by default).
 *
 * It holds the allowlisted names that are defined and the names that pass by rule, and no other name from
 * the Hub. A value from either source is withheld when it is URL-valued (see {@link URL_VALUED}), unless its name is
 * path-valued (see {@link isPathValued}). Every other URL-valued setting is withheld, whatever its scheme, because the
 * training path does not use URL-valued settings. That covers the rule path and the exact list. `DATABASE_` names are
 * the exception: they are passed only when the operator sets {@link DATABASE_OPT_IN} to `true`, for hosts whose trainer
 * builds its vocabulary from the database, and the URL rule does not apply to them. `PYTHONUNBUFFERED` is set so
 * progress lines reach the runner as they are written, and `CI_HUB_TRAINING_CHILD` marks the child as one the Hub
 * started.
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
