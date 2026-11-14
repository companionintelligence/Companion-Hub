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
] as const;

/**
 * Names the trainer reads its settings from: CI-Memory's `hbpe` config.py. A name passes by rule when it
 * has one of these prefixes or is one of these exact names, and it does not look like a credential.
 */
const RULE_PREFIXES: readonly string[] = ['HBPE_', 'QWEN_'];
const RULE_NAMES: readonly string[] = ['API_URL', 'LLM_API_BASE', 'LLM_DEFAULT_CHAT_MODEL'];

/** A name matching this looks like a credential. No rule passes it, whatever its prefix. */
const SECRET_LIKE = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PASS/i;

/**
 * True when the Hub variable `name` passes to a training child by rule. A credential-looking name never
 * passes. Names on the exact allowlist are not tested here.
 */
export function passesByRule(name: string): boolean {
  const named = RULE_NAMES.includes(name);
  const prefixed = RULE_PREFIXES.some((prefix) => name.startsWith(prefix));
  return (named || prefixed) && !SECRET_LIKE.test(name);
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
 * The environment for a training child, built from `source` (the Hub's own environment by default).
 *
 * It holds the allowlisted names that are defined, the names that pass by rule, and no other name from
 * the Hub. `DATABASE_` names are passed only when the operator sets {@link DATABASE_OPT_IN} to `true`,
 * for hosts whose trainer builds its vocabulary from the database. `PYTHONUNBUFFERED` is set so progress lines
 * reach the runner as they are written, and `CI_HUB_TRAINING_CHILD` marks the child as one the Hub started.
 */
export function trainingChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of TRAINING_CHILD_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }

  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && passesByRule(name)) env[name] = value;
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
