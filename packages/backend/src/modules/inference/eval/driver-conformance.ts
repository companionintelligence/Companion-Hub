/**
 * Per-driver conformance: what each of the six backends is asked, and — the part that is easy to
 * leave out — what it is NOT asked, and why.
 *
 * A prompt bank can express coverage but not ABSENCE. Prompts name the backends they apply to, so a
 * driver left off that list produces no row at all: not a pass, not a fail, not a skip — nothing.
 * Reading a results file, a driver that was never asked about tool calling is indistinguishable from
 * one that was asked and had nothing to say.
 *
 * This module closes that. It is a MATRIX, not a test runner: every (driver × dimension) cell is
 * either
 *
 *   · covered  — by named bank entries that really do target that driver, and/or by a named probe
 *                this file defines, or
 *   · skipped  — with a reason that says what the driver cannot do and where that was established.
 *
 * There is no third state. {@link matrixGaps} returns the cells that are neither, and the test
 * asserts it is empty — so adding a dimension, or dropping a backend from a bank entry's `backends`
 * array, fails the suite instead of quietly deleting coverage.
 *
 * WHY IT DOES NO I/O. Nothing here opens a socket. The claim "this engine is not asked about tool
 * calling because X" is a factual assertion that should be readable, diffable and unit-testable
 * without booting a runner; the half that talks to endpoints is a separate concern that consumes
 * this matrix.
 *
 * SPECULATIVE DECODING is the dimension this file exists for most. Each engine toggles it
 * differently, three of the six cannot be toggled at all from a read-only request, and two of the
 * obvious "off" switches do not turn it off. Those are recorded as data in {@link SPEC_DECODE}
 * rather than as prose, because each of them has already been got wrong once from vendor docs, and a
 * constant with a test on it cannot be re-derived wrongly.
 */

import { INFERENCE_BACKEND_TYPES, type InferenceBackendType } from '@ci-hub/common/types';

/**
 * The only thing this module needs to know about a prompt bank entry.
 *
 * Structural on purpose: the matrix is a claim about which prompts target which driver, and it must
 * be checkable against ANY bank — the shipped one, a narrowed preset, or a fixture in a test — without
 * this file depending on a particular bank module. Passing the prompts in is also what keeps
 * {@link staleSkips} honest: a skip is only stale relative to the bank actually being run.
 */
export interface ConformancePrompt {
  id: string;
  backends: readonly InferenceBackendType[];
}

// ─── The dimensions ───────────────────────────────────────────────────────────

export type ConformanceDimensionId =
  // OpenAI-compatible surface
  | 'openai-chat'
  | 'openai-completions'
  | 'openai-models'
  | 'openai-embeddings'
  // Ollama-native surface
  | 'native-chat'
  | 'native-generate'
  | 'native-tags'
  | 'native-ps'
  // Streaming
  | 'stream-sse'
  | 'stream-ndjson'
  | 'stream-completeness'
  | 'nonstream-parity'
  // Budget and decoding controls
  | 'stop-sequence'
  | 'max-tokens'
  | 'unicode-chunk-boundary'
  // Tools and structure
  | 'tool-call'
  | 'no-spurious-tool-call'
  | 'json-mode'
  | 'malformed-json-input'
  // Error shapes
  | 'error-bad-model'
  | 'error-bad-param-type'
  | 'error-oversized-context'
  // Capability
  | 'spec-decode-capability';

export interface ConformanceDimension {
  id: ConformanceDimensionId;
  label: string;
  /** WHY this dimension exists — what breaks downstream when a driver gets it wrong. */
  why: string;
}

export const CONFORMANCE_DIMENSIONS: ConformanceDimension[] = [
  {
    id: 'openai-chat',
    label: 'POST /v1/chat/completions',
    why: 'The one route all six engines share. If a driver diverges here every app that speaks OpenAI breaks against it, so it is the only dimension with no legitimate skip.',
  },
  {
    id: 'openai-completions',
    label: 'POST /v1/completions (legacy)',
    why: 'A different handler from chat on every engine that has it. Ollama emits one frame per thinking token here with `text: ""` and no usage frame at all — same node, same model, same budget as a chat request that grades fine. Routes are not interchangeable.',
  },
  {
    id: 'openai-models',
    label: 'GET /v1/models',
    why: "Every discovery path reads it and nothing grades it. It is also where a whole class of catalog defect lives: the route answers with the engine's own sanitised slug while a catalog holds the upstream repo id, so an exact-string comparison between the two reports every such row as never-loaded, forever, with no error.",
  },
  {
    id: 'openai-embeddings',
    label: 'POST /v1/embeddings',
    why: 'The highest-consequence silent failure an appliance has: a zero, NaN or duplicated vector answers 200 with the right count and destroys vector-store ranking downstream with no error anywhere.',
  },
  {
    id: 'native-chat',
    label: 'POST /api/chat (Ollama-native)',
    why: "Ollama's own handler, not the OpenAI shim. It spells thinking `message.thinking`, stop `options.stop` and finish `done_reason` — different keys, different code path, different bugs.",
  },
  {
    id: 'native-generate',
    label: 'POST /api/generate (Ollama-native)',
    why: 'A third handler again, with `system` as a top-level field rather than a message. It is reachable through any pool controller that forwards native routes, so an app can hit it.',
  },
  {
    id: 'native-tags',
    label: 'GET /api/tags',
    why: 'The route Ollama discovery is built on. If its shape drifts, every ollama node reads as absent rather than broken.',
  },
  {
    id: 'native-ps',
    label: 'GET /api/ps',
    why: 'Read-only and almost never called. It is the only read-only route that reports `size_vram` against `size` — the silent-CPU-fallback check, without which a node quietly running on CPU is benchmarked as if it were on the GPU.',
  },
  {
    id: 'stream-sse',
    label: 'SSE streaming (data: frames)',
    why: 'Time-to-first-token only means anything on a stream that is read frame by frame. A buffered read makes every TTFT equal the total duration.',
  },
  {
    id: 'stream-ndjson',
    label: 'NDJSON streaming (bare JSON lines)',
    why: 'Ollama-native framing has no `data:` prefix and no [DONE] sentinel. An SSE reader pointed at it returns zero characters from a healthy server, which then reads as the empty-200 failure signature — a mis-diagnosis, not a measurement.',
  },
  {
    id: 'stream-completeness',
    label: 'No truncated final chunk',
    why: 'A stream that stops one frame early loses the finish reason and the usage frame, and the loss is invisible: the text still looks like an answer.',
  },
  {
    id: 'nonstream-parity',
    label: 'Streamed and non-streamed agree on FRAMING',
    why: 'Same route, same budget, both framings must yield text and a finish reason. Deliberately NOT an output-equality gate: speculative decoding is not output-lossless on some builds, and a plain autoregressive path can be nondeterministic against itself at temperature 0, so a hash comparison would fail on healthy nodes.',
  },
  {
    id: 'stop-sequence',
    label: 'Stop sequences honoured',
    why: 'A backend that ignores `stop` serves plausible text that every delimiter-parsing app then mis-reads. The failure is downstream and silent.',
  },
  {
    id: 'max-tokens',
    label: 'max_tokens honoured',
    why: 'The budget is the only bound on what a request costs a shared appliance. An engine that runs past it turns a trivial row into a slot held for minutes.',
  },
  {
    id: 'unicode-chunk-boundary',
    label: 'Unicode integrity across chunk boundaries',
    why: 'A per-chunk decode without a stateful decoder splits a multi-byte character across two frames and emits U+FFFD. No model answers a question with U+FFFD, so its presence is always plumbing. THIS DIMENSION HAS CAUGHT ONE: on a gfx1151 node one llama.cpp-derived build turned every non-BMP character in its SSE stream into four U+FFFD — astral emoji and mathematical letterforms mangled, while Japanese, Arabic and Latin-1 accented text survived — and a gfx1100 node running the same engine streamed the identical prompt with zero U+FFFD, in the same minute. Astral characters are the 4-byte UTF-8 case, which is exactly what a non-stateful decoder loses first, and the defect is a property of the build, not of the engine.',
  },
  {
    id: 'tool-call',
    label: 'Tool / function calling',
    why: 'Requires launch flags on vLLM and model labels on lemonade, so "returns no tool call" and "cannot accept a tools array" are different facts about a build and must not collapse into one row.',
  },
  {
    id: 'no-spurious-tool-call',
    label: 'No tool call when none was offered',
    why: 'The false-positive half. A model that emits a tool call against a request with no `tools` array hands every plain chat client a 200 whose `content` is null. This one applies to all six because it needs no tool support to answer correctly.',
  },
  {
    id: 'json-mode',
    label: 'JSON mode / structured output',
    why: 'A constrained decoder that emits invalid JSON is a server fault, not a model quirk — it is the one structured-output failure that is worth a hard red.',
  },
  {
    id: 'malformed-json-input',
    label: 'Malformed content in the prompt',
    why: 'Distinct from a malformed envelope: broken JSON inside the user turn exercises the tokenizer and the model, not the request validator.',
  },
  {
    id: 'error-bad-model',
    label: 'Error shape: model that does not exist',
    why: 'The single most common client mistake, and the one least often asserted. A backend that answers 200 by silently substituting a resident model is far worse than one that 404s: every downstream measurement then describes a model nobody asked for.',
  },
  {
    id: 'error-bad-param-type',
    label: 'Error shape: parameter of the wrong type',
    why: 'Exercises the request validator rather than the tokenizer. A 500 here means an unvalidated field reached the engine.',
  },
  {
    id: 'error-oversized-context',
    label: 'Error shape: prompt past the advertised context window',
    why: "Refusing cleanly is correct behaviour and only a hang is a failure. The window is read from the engine's own /v1/models rather than assumed, because across these six it ranges from 8,192 to 262,144 on hardware of the same class.",
  },
  {
    id: 'spec-decode-capability',
    label: 'Speculative decoding: is it on, and what turns it off',
    why: 'Every engine answers this differently and two of the obvious "off" switches do not turn it off. See SPEC_DECODE — this dimension reports the engine\'s own account of its speculative state over the read-only surface, and skips with a reason wherever that surface says nothing.',
  },
];

export const CONFORMANCE_DIMENSION_IDS: ConformanceDimensionId[] = CONFORMANCE_DIMENSIONS.map((d) => d.id);

// ─── Speculative decoding, per engine ────────────────────────────────────────

/** How close a caller can get to the speculative switch without leaving the read-only surface. */
export type SpecToggleReach =
  /** A parameter in an ordinary inference request body. Read-only, per request, no restart. */
  | 'request-param'
  /** Not togglable, but a read-only route reports the current state. */
  | 'read-only-report'
  /** Togglable only through a write endpoint a read-only harness refuses to call. */
  | 'write-endpoint'
  /** Fixed at process/container launch — a restart, not a request. */
  | 'launch-flag';

export interface SpecDecodeCapability {
  backend: InferenceBackendType;
  /**
   * `true` where it has been measured working; 'version-gated' where the build decides;
   * 'unmeasured' where this fleet has never run the engine and nothing here may be asserted.
   *
   * 'unmeasured' is a third state rather than a missing row on purpose. A backend absent from this
   * table would read as "nothing to say about speculation", which is a claim; an explicit
   * 'unmeasured' says the engine exists and nobody has looked. The invariants every other row must
   * satisfy — a named toggle, sourced evidence — do not apply to it, and the tests exempt it by
   * name so that filling the row in is what removes the exemption.
   */
  capable: true | 'version-gated' | 'unmeasured';
  reach: SpecToggleReach;
  /** The exact spelling that turns speculation ON, or null where nothing in the API does. */
  toggleOn: string | null;
  /** The CORRECT control arm. Null where the only control is a differently-launched server. */
  offArm: string | null;
  /**
   * A switch that LOOKS like the off arm and is not. Both entries here cost a withdrawn result:
   * used as the control they compare speculation against speculation and report a bogus ~1.0x.
   */
  falseOffArm: string | null;
  /** What a read-only response says about the current state, or null if nothing does. */
  observable: string | null;
  /** Where each claim above was established. Required — an unsourced capability claim is a guess. */
  evidence: string;
}

/**
 * The table. Every row was measured against a live engine or read out of the engine's own binary;
 * none of it is from a vendor's documentation, which is how the two false-off-arms below got in.
 *
 * The shape of the answer, across six engines. TOGGLING and OBSERVING are different questions and
 * the table keeps them apart:
 *
 *   · toggle from an ordinary inference request — ollama, mtplx (2 of 6)
 *   · toggle only through a write endpoint a read-only harness refuses to call — dspark, lemonade
 *   · toggle only by relaunching the server — vllm, lucebox
 *
 * Observing is wider: five of the six say something read-only. Only vLLM says nothing at all. That
 * asymmetry is why `reach` and `observable` are separate fields — lucebox cannot be toggled by a
 * request and nevertheless reports, on every completion, whether the drafter ran.
 */
export const SPEC_DECODE: Record<InferenceBackendType, SpecDecodeCapability> = {
  ollama: {
    backend: 'ollama',
    capable: 'version-gated',
    reach: 'request-param',
    toggleOn: 'options.draft_num_predict — undocumented, maps to llama-server --spec-draft-n-max',
    offArm: 'omit draft_num_predict entirely',
    falseOffArm: null,
    observable:
      'GET /api/version only, and only as a GATE: 0.30.8+ ships a llama-server supporting --spec-type draft-mtp. No read-only route reports whether a given runner was launched with it; that is in the runner argv, which needs host access rather than an HTTP read.',
    evidence:
      "Confirmed from runner argv on four nodes spanning 0.30.8 through 0.33.3. draft_num_predict verified behaviourally (six requested depths appear one-for-one in the runner argv) and against a negative control (a bogus option name logs `invalid option provided`; draft_num_predict does not). The mechanism is the model's own MTP/NextN head, not a paired drafter. On 0.33.3 all 11 option syntaxes were silently discarded — the version gate is necessary, not sufficient.",
  },
  lemonade: {
    backend: 'lemonade',
    capable: true,
    reach: 'write-endpoint',
    toggleOn: '--spec-type draft-simple, passed through llamacpp_args on POST /api/v1/load',
    offArm: 'a load without --spec-type (the shipped default, which is `none`)',
    falseOffArm:
      'the registry `checkpoints: {main, draft}` pair is a false ON, not a false off: it loads the drafter into VRAM and never drafts a token. Symptom is `speculative: False` and a 1.02x no-op.',
    observable:
      "GET /v1/models reports each model's `checkpoints` object, so a configured draft checkpoint IS visible read-only — but its presence does NOT mean speculation is active, which is the whole of the false-ON above.",
    evidence:
      'A registry entry shipped as a speculative pair performed no speculation at all, verified three ways on one node. /api/v1/load is also an UNAUTHENTICATED write endpoint on a default install; that is a second, independent reason a read-only harness must not call it.',
  },
  vllm: {
    backend: 'vllm',
    capable: true,
    reach: 'launch-flag',
    toggleOn: '--speculative-config at server launch',
    offArm: 'a server launched without it (logs `speculative_config=None`)',
    falseOffArm: null,
    observable: null,
    evidence:
      'Measured at k=3 with a draft model: 42.8% acceptance, ~1.4x, both arms byte-identical in parsed flags except speculative_config. No read-only route reports it — /v1/models carries the model id, max_model_len and permissions, and nothing about drafting.',
  },
  omlx: {
    backend: 'omlx',
    capable: 'unmeasured',
    reach: 'launch-flag',
    toggleOn: null,
    offArm: null,
    falseOffArm: null,
    observable: null,
    evidence: 'Hub does not offer speculative decoding on oMLX. Chat and embeddings are the supported surface.',
  },
};

// ─── Hidden reasoning: the per-driver spelling of "stop thinking" ────────────

/**
 * How each engine is told not to spend the token budget on hidden reasoning — and, where it matters
 * more, WHICH SPELLING IS A SILENT NO-OP.
 *
 * This is a conformance fact, not a tuning preference. A hybrid-reasoning model bills its chain of
 * thought to the same budget as the answer and returns it under a different key (`reasoning_content`
 * on llama.cpp/vLLM/mtplx, `reasoning` on Ollama's shim, `message.thinking` on Ollama-native), so a
 * terse question on a small budget comes back `content: ""` with `finish_reason: length` from a
 * perfectly healthy node.
 *
 * The trap this table exists for: **`reasoning_effort` is accepted with HTTP 200 by mtplx and
 * changes nothing.** Measured against a hybrid-reasoning model — with `reasoning_effort: "none"` and
 * max_tokens 64, `content` was empty, `finish_reason` was `length` and
 * `completion_tokens_details.reasoning_tokens` was 64: the entire budget went to thinking, and
 * nothing in the response said the parameter had been ignored. That is a system reporting success
 * for work it never did, and copying the ollama override to mtplx reproduces it.
 * `chat_template_kwargs: {enable_thinking: false}` DOES work there — the same request returned a
 * one-word answer with `finish_reason: "stop"` and no reasoning at all.
 */
export interface ThinkingSuppression {
  backend: InferenceBackendType;
  /** The spelling that actually works, or null where none has been verified. */
  works: string | null;
  /** A spelling that answers 200 and does nothing. Naming it is the point of this table. */
  silentNoOp: string | null;
  evidence: string;
}

export const THINKING_SUPPRESSION: Record<InferenceBackendType, ThinkingSuppression> = {
  ollama: {
    backend: 'ollama',
    works: "reasoning_effort: 'none' on the OpenAI shim; think: false on /api/chat and /api/generate",
    silentNoOp: null,
    evidence: 'Verified against both a thinking and a non-thinking model on the same node, on the shim and the native routes.',
  },
  lemonade: {
    backend: 'lemonade',
    works: "reasoning_effort: 'none' (llama.cpp accepts it natively); chat_template_kwargs: {enable_thinking: false} also works",
    silentNoOp: null,
    evidence:
      'Verified on three nodes running llama-server b10707 behind lemonade, serving a 0.6B hybrid-reasoning GGUF. As shipped, a short chat at max_tokens 16 returned content:"" with finish_reason:length while reasoning_content held the chain of thought; with the override, HTTP 200 and a two-token answer.',
  },
  vllm: {
    backend: 'vllm',
    works: null,
    silentNoOp: null,
    evidence:
      'Not established. The model measured was an Instruct build that does not think, so nothing has exercised the question. vLLM does emit reasoning_content when a reasoning parser is configured at launch, which is a launch-time property rather than a request one.',
  },
  omlx: {
    backend: 'omlx',
    works: null,
    silentNoOp: null,
    evidence: 'Not measured on this fleet. oMLX is the Apple Silicon server; thinking suppression is not asserted here.',
  },
};

// ─── The matrix ───────────────────────────────────────────────────────────────

/**
 * Bank entries that back each dimension. Listed by id rather than filtered by category because the
 * mapping is a claim ("`stop-sequence` is what proves stop sequences are honoured") and a claim
 * should be written down. Which of these actually apply to a given driver is decided by the entry's
 * own `backends` array at read time, so this list can never over-claim: naming an entry here that
 * does not target a backend contributes nothing to that backend's cell.
 */
export const DIMENSION_BANK_IDS: Record<ConformanceDimensionId, string[]> = {
  'openai-chat': ['short-chat', 'medium-chat'],
  'openai-completions': ['legacy-completions', 'stream-legacy-completions'],
  'openai-models': [],
  'openai-embeddings': ['embed-single', 'embed-batch', 'embed-long-doc'],
  'native-chat': ['ollama-native-chat'],
  'native-generate': ['ollama-native-generate'],
  'native-tags': [],
  'native-ps': [],
  'stream-sse': ['stream-ttft'],
  'stream-ndjson': ['stream-native-ndjson'],
  'stream-completeness': ['stream-completeness'],
  'nonstream-parity': [],
  'stop-sequence': ['stop-sequence', 'stop-sequence-native'],
  'max-tokens': ['max-tokens-honoured', 'max-tokens-native'],
  'unicode-chunk-boundary': ['stream-unicode-sse', 'stream-unicode-ndjson'],
  'tool-call': ['tool-call-openai', 'tool-call-native'],
  'no-spurious-tool-call': ['no-spurious-tool-call'],
  'json-mode': ['json-mode-object', 'json-mode-native', 'vllm-guided-json'],
  'malformed-json-input': ['json-repair-malformed', 'empty-prompt', 'whitespace-prompt'],
  'error-bad-model': [],
  'error-bad-param-type': ['protocol-bad-param-type', 'protocol-negative-budget'],
  'error-oversized-context': ['oversized-context'],
  'spec-decode-capability': [],
};

/**
 * Probes this module declares for the dimensions a prompt bank cannot reach: GETs it has no dialect
 * for (/v1/models, /api/tags, /api/ps), checks that need a model name the bank never supplies
 * (error-bad-model), and checks that must be sized against the endpoint's own advertised window
 * (error-oversized-context). The strings are the contract a runner implements — they say what a pass
 * means, so the runner cannot quietly grade something weaker.
 */
export const DIMENSION_PROBES: Partial<Record<ConformanceDimensionId, Partial<Record<InferenceBackendType, string>>>> = {
  'openai-models': all('GET /v1/models — 200, data[] non-empty, every entry carries a string id'),
  'native-tags': { ollama: 'GET /api/tags — 200, models[] non-empty, every entry carries a name' },
  'native-ps': {
    ollama: 'GET /api/ps — 200; reports size_vram against size, which is the silent-CPU-fallback check',
  },
  'nonstream-parity': all(
    'the same chat request sent streamed and non-streamed — both must yield text and a finish reason (FRAMING parity, never output equality)',
  ),
  'error-bad-model': all(
    'POST /v1/chat/completions with a model id that cannot exist — must be a 4xx, never a 200 that silently substitutes a resident model',
  ),
  'error-oversized-context': all(
    "POST /v1/chat/completions with a prompt sized past the window the endpoint's own /v1/models advertises — a clean rejection is a pass, only a hang is a failure",
  ),
  'spec-decode-capability': {
    ollama: 'GET /api/version — the 0.30.8 build gate from SPEC_DECODE.ollama, reported as a gate and never as an activation proof',
    lemonade: 'GET /v1/models — whether a draft checkpoint is configured, reported WITH the false-ON caveat attached (configured is not active)',
  },
};

function all(check: string): Partial<Record<InferenceBackendType, string>> {
  return Object.fromEntries(INFERENCE_BACKEND_TYPES.map((b) => [b, check])) as Partial<Record<InferenceBackendType, string>>;
}

/**
 * Declared skips. A reason here is a claim that the driver CANNOT do the thing, and it must say
 * where that was established — these are the rows that replace silence, so a vague one is worse than
 * none. Asserting a skip for a cell the bank actually covers is a lie about the driver, and
 * {@link staleSkips} fails the suite on it.
 */
export const DIMENSION_SKIPS: Partial<Record<ConformanceDimensionId, Partial<Record<InferenceBackendType, string>>>> = {
  'openai-completions': chatOnly(
    'no verified /v1/completions route — this engine is chat-shaped. Only ollama/vllm/lemonade have been seen answering it, and asserting a route nobody has seen answer would print a guess as a verdict.',
  ),
  'openai-embeddings': {},
  'native-chat': nonOllama(),
  'native-generate': nonOllama(),
  'native-tags': nonOllama(),
  'native-ps': nonOllama(),
  'stream-ndjson': nonOllama(),
  'tool-call': chatOnly(
    'unverified — only ollama/vllm/lemonade have been seen accepting a tools array, and even vLLM needs --enable-auto-tool-choice --tool-call-parser at launch and 400s otherwise. Sending a tools array here would grade a launch configuration as a model defect.',
  ),
  'json-mode': chatOnly(
    'response_format is unverified on this engine — only ollama/vllm/lemonade have been seen implementing it. Ollama maps the field onto its native `format`, vLLM implements guided decoding and lemonade is model/runtime dependent; for these three nobody has seen it accepted or refused, and a guessed red row means nothing.',
  ),
  'spec-decode-capability': {
    vllm: 'speculative decoding is configured with --speculative-config at server launch and no read-only route reports it — /v1/models carries the model id, max_model_len and permissions and nothing about drafting. Reading the state needs the launch argv from the host, which is outside a read-only HTTP surface.',
    omlx: 'not measured. Hub does not offer speculative decoding as an oMLX feature.',
  },
};

function nonOllama(): Partial<Record<InferenceBackendType, string>> {
  const reason =
    "/api/* is Ollama's own surface and nothing else implements it — the five other engines were each probed on their live port and answered only their /v1/* surface. This is a route that does not exist on this engine, not a route that failed.";
  return Object.fromEntries(INFERENCE_BACKEND_TYPES.filter((b) => b !== 'ollama').map((b) => [b, reason])) as Partial<
    Record<InferenceBackendType, string>
  >;
}

/**
 * The engines excused from a dimension that only the verified-capable ones are asked.
 *
 * `mtplx`, `dspark` and `lucebox` are here because they were driven and found to be chat-shaped.
 * `llamacpp` and `lmstudio` are here for a weaker reason — neither has been driven on this fleet at
 * all — and the reason strings passed in say "no verified route", which is true of both kinds. The
 * two are not the same finding, and a run that establishes either capability should take that engine
 * out of this list rather than widen the prose.
 */
function chatOnly(reason: string): Partial<Record<InferenceBackendType, string>> {
  const unverified: InferenceBackendType[] = ['omlx'];
  return Object.fromEntries(unverified.map((b) => [b, reason])) as Partial<Record<InferenceBackendType, string>>;
}

export interface ConformanceCell {
  backend: InferenceBackendType;
  dimension: ConformanceDimensionId;
  status: 'covered' | 'skipped' | 'gap';
  /** Bank entries that target this backend and back this dimension. */
  bankPromptIds: string[];
  /** The probe this module declares for the cell, if any. */
  probe: string | null;
  /** Set only when status is 'skipped'. */
  reason: string | null;
}

/**
 * Resolve one cell. The order matters: a declared skip wins only if the bank really does not cover
 * the cell, so a skip left behind by a widened `backends` array surfaces as a CONFLICT rather than
 * silently suppressing coverage that now exists.
 */
export function conformanceCell(
  backend: InferenceBackendType,
  dimension: ConformanceDimensionId,
  prompts: readonly ConformancePrompt[],
): ConformanceCell {
  const wanted = new Set(DIMENSION_BANK_IDS[dimension] ?? []);
  const bankPromptIds = prompts.filter((p) => wanted.has(p.id) && p.backends.includes(backend)).map((p) => p.id);
  const probe = DIMENSION_PROBES[dimension]?.[backend] ?? null;
  const reason = DIMENSION_SKIPS[dimension]?.[backend] ?? null;
  if (bankPromptIds.length || probe) return { backend, dimension, status: 'covered', bankPromptIds, probe, reason: null };
  if (reason) return { backend, dimension, status: 'skipped', bankPromptIds: [], probe: null, reason };
  return { backend, dimension, status: 'gap', bankPromptIds: [], probe: null, reason: null };
}

export function driverMatrix(backend: InferenceBackendType, prompts: readonly ConformancePrompt[]): ConformanceCell[] {
  return CONFORMANCE_DIMENSION_IDS.map((d) => conformanceCell(backend, d, prompts));
}

export function conformanceMatrix(prompts: readonly ConformancePrompt[]): ConformanceCell[] {
  return INFERENCE_BACKEND_TYPES.flatMap((b) => driverMatrix(b, prompts));
}

/** Cells that are neither covered nor skipped — the state this module exists to make impossible. */
export function matrixGaps(prompts: readonly ConformancePrompt[]): ConformanceCell[] {
  return conformanceMatrix(prompts).filter((c) => c.status === 'gap');
}

export interface StaleSkip {
  backend: InferenceBackendType;
  dimension: ConformanceDimensionId;
  bankPromptIds: string[];
}

/**
 * Cells claimed as skipped that the bank in fact covers. A stale skip is worse than a gap: a gap is
 * loud, a stale skip prints a confident "this engine cannot do X" over a row that ran and passed.
 */
export function staleSkips(prompts: readonly ConformancePrompt[]): StaleSkip[] {
  const out: StaleSkip[] = [];
  const entries = Object.entries(DIMENSION_SKIPS) as [ConformanceDimensionId, Partial<Record<InferenceBackendType, string>>][];
  for (const [dimension, byBackend] of entries) {
    for (const backend of Object.keys(byBackend) as InferenceBackendType[]) {
      const cell = conformanceCell(backend, dimension, prompts);
      if (cell.status === 'covered') out.push({ backend, dimension, bankPromptIds: cell.bankPromptIds });
    }
  }
  return out;
}

export interface DriverCoverage {
  covered: number;
  skipped: number;
  gap: number;
}

/** One line per driver: how many of the dimensions it is asked, and how many it is excused from. */
export function coverageSummary(prompts: readonly ConformancePrompt[]): Record<InferenceBackendType, DriverCoverage> {
  return Object.fromEntries(
    INFERENCE_BACKEND_TYPES.map((b) => {
      const cells = driverMatrix(b, prompts);
      return [
        b,
        {
          covered: cells.filter((c) => c.status === 'covered').length,
          skipped: cells.filter((c) => c.status === 'skipped').length,
          gap: cells.filter((c) => c.status === 'gap').length,
        },
      ];
    }),
  ) as Record<InferenceBackendType, DriverCoverage>;
}

// ─── Reading a version gate ───────────────────────────────────────────────────

/** The ollama build from which the shipped llama-server supports --spec-type draft-mtp. */
export const OLLAMA_SPEC_MIN_VERSION = '0.30.8';

/** Numeric compare of two dotted versions, ignoring any pre-release suffix. -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    String(v)
      .replace(/^v/, '')
      .split(/[.+-]/)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface SpecGateVerdict {
  /** Whether the BUILD can speculate. Never whether it currently is — see `caveat`. */
  gate: 'capable' | 'too-old' | 'unknown';
  version: string | null;
  caveat: string;
}

/**
 * Turn an ollama version string into the build gate, with the caveat welded on.
 *
 * The caveat is not decoration. A build well past this gate was measured discarding all 11
 * drafter-option syntaxes silently — load times of 2-3 ms and no runner rebuild. A gate that
 * reported "capable" without saying what it does not prove would report success for work the engine
 * never did, which is the exact failure this whole module exists to make impossible.
 */
export function ollamaSpecGate(version: string | null | undefined): SpecGateVerdict {
  const caveat =
    'BUILD GATE ONLY. It says the shipped llama-server supports --spec-type draft-mtp; it does not say this runner was launched with it, and it does not say the loaded model carries an MTP head. Confirming either needs the runner argv from the host, not an HTTP read. Measured counter-example: a build two minor versions past this gate clears it and silently discards every drafter option.';
  if (!version) return { gate: 'unknown', version: null, caveat };
  return {
    gate: compareVersions(version, OLLAMA_SPEC_MIN_VERSION) >= 0 ? 'capable' : 'too-old',
    version,
    caveat,
  };
}
