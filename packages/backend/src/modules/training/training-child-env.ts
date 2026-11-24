import { Logger } from '@nestjs/common';

/**
 * The only names a training child inherits from the Hub, matched exactly. A name reaches the child when the Hub
 * defines it, its value is not withheld and its name is not denied. No prefix or pattern admits a name.
 *
 * Each name added from CI-Memory carries the line that reads it. Paths are relative to CI-Memory's `backend/`:
 * `config.py` is `apps/hbpe/src/ci/hbpe/config.py`, `llm_host.py` is `packages/sidecar-core/src/ci/sidecar/llm_host.py`
 * and `train_io.py` is `apps/hbpe/src/ci/hbpe/model/train_io.py`. The base names are read by Python, the dynamic
 * loader, libc, curl, and the CUDA, ROCm, OpenMP, MKL, requests and Hugging Face libraries.
 */
export const TRAINING_CHILD_ENV_ALLOWLIST = [
  // Interpreter, loader, locale and temporary-directory names.
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
  // CUDA toolchain, device and allocator names.
  'CUDA_HOME',
  'CUDA_PATH',
  'HBPE_TRAIN_SEED', // apps/hbpe/src/ci/hbpe/model/train_io.py:189
  'CUDA_VISIBLE_DEVICES',
  'PYTORCH_CUDA_ALLOC_CONF',
  'PYTORCH_ENABLE_MPS_FALLBACK',
  // Thread counts, the tokenizer switch and cache directories.
  'OMP_NUM_THREADS',
  'MKL_NUM_THREADS',
  'TOKENIZERS_PARALLELISM',
  'XDG_CACHE_HOME',
  'HF_HOME',
  'HF_HUB_CACHE',
  'TORCH_HOME',
  // ROCm accelerator names.
  'HSA_OVERRIDE_GFX_VERSION',
  'HIP_VISIBLE_DEVICES',
  'ROCR_VISIBLE_DEVICES',
  'ROCM_PATH',
  'HIP_PATH',
  'MODELS_DIR', // apps/hbpe/src/ci/hbpe/config.py:82
  // Endpoint correction switches.
  'CI_LLM_HOST_REWRITE', // packages/sidecar-core/src/ci/sidecar/llm_host.py:73
  'CI_LLM_HOST_GATEWAY', // packages/sidecar-core/src/ci/sidecar/llm_host.py:79
  // Endpoints.
  'API_URL', // apps/hbpe/src/ci/hbpe/config.py:271
  'LLM_API_BASE', // apps/hbpe/src/ci/hbpe/config.py:103, packages/sidecar-core/src/ci/sidecar/llm_host.py:58
  'HBPE_LABEL_API_BASE', // apps/hbpe/src/ci/hbpe/config.py:103, packages/sidecar-core/src/ci/sidecar/llm_host.py:59
  // Settings read by config.py.
  'HBPE_LABEL_HTTP_TIMEOUT', // apps/hbpe/src/ci/hbpe/config.py:66
  'TOKEN_CORPUS_DIR', // apps/hbpe/src/ci/hbpe/config.py:91
  'HBPE_LABEL_MODEL', // apps/hbpe/src/ci/hbpe/config.py:116
  'LLM_DEFAULT_CHAT_MODEL', // apps/hbpe/src/ci/hbpe/config.py:116
  'QWEN_GGUF_PATH', // apps/hbpe/src/ci/hbpe/config.py:119
  'QWEN_GGUF_REPO', // apps/hbpe/src/ci/hbpe/config.py:121
  'QWEN_GGUF_FILE', // apps/hbpe/src/ci/hbpe/config.py:124
  'QWEN_DISABLE_THINKING', // apps/hbpe/src/ci/hbpe/config.py:133
  'QWEN_MAX_TOKENS_NO_THINK', // apps/hbpe/src/ci/hbpe/config.py:139
  'HBPE_LABEL_REPROBE_SECONDS', // apps/hbpe/src/ci/hbpe/config.py:150
  'QWEN_GGUF_BATCH', // apps/hbpe/src/ci/hbpe/config.py:157
  'QWEN_GGUF_RECYCLE_CALLS', // apps/hbpe/src/ci/hbpe/config.py:162
  'HBPE_LABEL_YIELD_TO_CHAT', // apps/hbpe/src/ci/hbpe/config.py:172
  'HBPE_LABEL_YIELD_MAX_SECONDS', // apps/hbpe/src/ci/hbpe/config.py:180
  'HBPE_LABEL_YIELD_POLL_SECONDS', // apps/hbpe/src/ci/hbpe/config.py:183
  'HBPE_LABEL_MAX_REQUESTS_PER_MINUTE', // apps/hbpe/src/ci/hbpe/config.py:194
  'HBPE_ENABLE_DECISION_MODELS', // apps/hbpe/src/ci/hbpe/config.py:205
  'HBPE_DECISION_MODEL_ENDPOINT', // apps/hbpe/src/ci/hbpe/config.py:210
  'HBPE_DECISION_CONFIDENCE_THRESHOLD', // apps/hbpe/src/ci/hbpe/config.py:214
  'CLUSTER_STALENESS_DAYS', // apps/hbpe/src/ci/hbpe/config.py:220
  'HBPE_LABEL_BUDGET_SECONDS', // apps/hbpe/src/ci/hbpe/config.py:223
  'HBPE_LABEL_RECENCY_DAYS', // apps/hbpe/src/ci/hbpe/config.py:253
  'HBPE_LABEL_RECENCY_SHARE', // apps/hbpe/src/ci/hbpe/config.py:262
  'FUNCTION_RUNNER_CONCURRENCY', // apps/hbpe/src/ci/hbpe/config.py:310
  'HBPE_API_PORT', // apps/hbpe/src/ci/hbpe/config.py:315
  'HBPE_LOG_LEVEL', // apps/hbpe/src/ci/hbpe/config.py:317
  // Endpoints that llm_host.py resolve_env corrects at import.
  'EMBEDDING_API_BASE', // packages/sidecar-core/src/ci/sidecar/llm_host.py:60
  'LLM_EMBEDDING_API_BASE', // packages/sidecar-core/src/ci/sidecar/llm_host.py:61
  'CI_EMBEDDING_BASE_URL', // packages/sidecar-core/src/ci/sidecar/llm_host.py:62
  'OLLAMA_HOST', // packages/sidecar-core/src/ci/sidecar/llm_host.py:63
  'OLLAMA_EMBED_HOST', // packages/sidecar-core/src/ci/sidecar/llm_host.py:64
  'CI_OLLAMA_EMBED_HOST', // packages/sidecar-core/src/ci/sidecar/llm_host.py:65
  // Proxy settings, read by requests, urllib and huggingface_hub.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  // CA bundle paths, read by Python ssl, requests and curl.
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // Hugging Face and transformers switches, read by huggingface_hub and transformers.
  'HF_ENDPOINT',
  'HF_HUB_OFFLINE',
  'HF_HUB_DISABLE_TELEMETRY',
  'TRANSFORMERS_OFFLINE',
] as const;

/**
 * Listed names that contain a denied substring and are still copied. Each is a setting that happens to contain the
 * substring. None is a credential.
 */
export const DENYLIST_EXEMPT_NAMES: ReadonlySet<string> = new Set([
  // The tokenizers library's switch. `TOKEN` is part of the library's own name.
  'TOKENIZERS_PARALLELISM',
  // A count of tokens generated with thinking off. `TOKEN` names the unit.
  'QWEN_MAX_TOKENS_NO_THINK',
  // A directory of token-corpus files. `TOKEN` names the corpus.
  'TOKEN_CORPUS_DIR',
]);

/**
 * Substrings that mark a name as a credential or a database handle, compared case-insensitively. This is a guard
 * for future additions to the allowlist: a listed name that contains one of them, and is not exempt, is dropped.
 * `PASS` also covers `PASSWORD`.
 */
const DENIED_SUBSTRINGS: readonly string[] = ['KEY', 'SECRET', 'TOKEN', 'PASS', 'CREDENTIAL', 'CREDS', 'AUTH', 'COOKIE', 'DSN', 'DATABASE'];

/**
 * Names whose value may contain an at sign: local paths and locales. A path can hold one (the Homebrew OpenJDK
 * directory is `openjdk@21`), and so can a locale (`de_DE@euro`). Every other name is withheld for an at sign. The
 * question-mark check applies to every name, including these.
 */
export const AT_SIGN_EXEMPT_NAMES: ReadonlySet<string> = new Set([
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
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Other allowlisted paths: a corpus directory and a local GGUF file.
  'TOKEN_CORPUS_DIR',
  'QWEN_GGUF_PATH',
]);

/**
 * Read from the Hub's own environment, which only the operator sets. A peer's job manifest never writes to it, so
 * the opt-in cannot be set from a job.
 */
const DATABASE_OPT_IN = 'CI_HUB_TRAIN_CHILD_INHERIT_DATABASE';
const DATABASE_PREFIX = 'DATABASE_';

const logger = new Logger('TrainingChildEnv');

/** Why a Hub value is not copied to a training child. */
type WithholdReason = 'denied name' | 'question mark' | 'at sign';

const REASON_TEXT: Record<WithholdReason, string> = {
  'denied name': 'its name contains a denied substring',
  'question mark': 'its value contains a question mark',
  'at sign': 'its value contains an at sign',
};

/** The names whose withheld value has been warned about. One warning per variable per process. */
const withheldWarned = new Set<string>();
/** One warning per process. The governor starts several children on every job, so not one per child. */
let databaseWarningLogged = false;

function isDeniedName(name: string): boolean {
  if (DENYLIST_EXEMPT_NAMES.has(name)) return false;
  const upper = name.toUpperCase();
  return DENIED_SUBSTRINGS.some((substring) => upper.includes(substring));
}

/**
 * The reason a name's value is withheld, or undefined when it may be copied. The name is checked first, then the value
 * for a question mark, then for an at sign. The value itself is never logged.
 */
function withholdReason(name: string, value: string): WithholdReason | undefined {
  if (isDeniedName(name)) return 'denied name';
  if (value.includes('?')) return 'question mark';
  if (value.includes('@') && !AT_SIGN_EXEMPT_NAMES.has(name)) return 'at sign';
  return undefined;
}

function warnWithheld(name: string, reason: WithholdReason): void {
  if (withheldWarned.has(name)) return;
  withheldWarned.add(name);
  logger.warn(`${name} is not passed to child processes: ${REASON_TEXT[reason]}, so it was withheld.`);
}

/**
 * The environment for a training child, built from `source` (the Hub's own environment by default) and the names in
 * `allowlist` (the trainer's list by default). A listed name is copied when the Hub defines it and it is not withheld.
 * The `DATABASE_` names are copied, unchanged, only when the operator sets the opt-in to exactly `true`, for hosts whose
 * trainer builds its vocabulary from the database. `PYTHONUNBUFFERED` is set so progress lines reach the runner as they
 * are written, and `CI_HUB_TRAINING_CHILD` marks the child as one the Hub started.
 */
export function trainingChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  allowlist: readonly string[] = TRAINING_CHILD_ENV_ALLOWLIST,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of allowlist) {
    const value = source[name];
    if (value === undefined) continue;
    const reason = withholdReason(name, value);
    if (reason === undefined) {
      env[name] = value;
    } else {
      warnWithheld(name, reason);
    }
  }

  const databaseEntries = Object.entries(source).filter(
    (entry): entry is [string, string] => entry[0].startsWith(DATABASE_PREFIX) && entry[1] !== undefined,
  );
  if (source[DATABASE_OPT_IN] === 'true') {
    for (const [name, value] of databaseEntries) env[name] = value;
  } else if (databaseEntries.length > 0 && !databaseWarningLogged) {
    databaseWarningLogged = true;
    logger.warn(
      `DATABASE_ variables are set but not passed to training children. Set ${DATABASE_OPT_IN}=true in this Hub's environment to pass them to training children.`,
    );
  }

  env.PYTHONUNBUFFERED = '1';
  env.CI_HUB_TRAINING_CHILD = '1';
  return env;
}
