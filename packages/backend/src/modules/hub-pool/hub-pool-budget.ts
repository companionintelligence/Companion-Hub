/**
 * How long an inference request may wait on an engine: the header wait for a streamed request, the
 * whole completion for a non-streamed one, both sized from the prompt.
 *
 * Its own module, with no imports, because two callers need the same numbers and one of them cannot
 * import the other. `PoolProxyService` places requests across nodes; `InferenceRouterService` serves
 * the same `/v1` routes on a Hub with no connected peers, and the pool proxy already depends on the
 * router. A request must not get five minutes through the pool and two through the local path on the
 * very same node — beta-red, 2026-09-29, where the local path cut a streamed turn at 120 s that the
 * pool would have waited 300 s for.
 */

/**
 * Header-wait budget for a forwarded STREAMED request. Cleared as soon as the upstream responds, so
 * it never caps how long a streamed generation may run — but for an engine that streams, the first
 * byte comes only after the model is loaded AND the prompt is evaluated, and that is not "well under
 * a second" for an agent turn. Measured on beta-max, 2026-09-15: a 150 KB prompt (OpenClaw's first
 * turn is 162 KB — system prompt, every tool schema, history) into a cold `qwen3.6:27b` took
 * **131.8 s** to its first byte over the direct engine path, 0.97 s once the prompt was cached. At
 * the old 15 s every such turn was abandoned here, failed over to a peer that then needed the same
 * two minutes, and reported as "unreachable" — the routing log showed 15123 ms, 15129 ms, node
 * `null`. Five minutes by default, like the completion budget below, and env-overridable for the
 * same reason: the right number is a property of the operator's hardware. A dead peer is still
 * caught quickly — a refused TCP connect fails at once, and the health poll marks a silent one
 * unreachable after three misses — this only stops a *slow* engine reading as a dead one.
 */
export const CONNECT_TIMEOUT_MS = Math.max(15_000, Number(process.env.HUB_POOL_FIRST_BYTE_TIMEOUT_MS) || 300_000);

/**
 * The slowest prompt-evaluation rate a placed request is budgeted against, in tokens per second.
 *
 * A fixed first-byte budget is wrong for a streamed request whose prompt the engine has to READ
 * before it can say anything, because that cost scales with the prompt. On beta-max, Ollama's own
 * log for an OpenClaw turn: 47,104 prompt tokens at 192 → 157 tok/s (it slows as the context
 * grows), 98% evaluated at 296.8 s — and at 300 s the fixed budget cancelled it, five minutes of
 * GPU work were discarded, and the request moved to a peer that then started the same prefill from
 * zero, cold. So the budget is sized from the body: tokens ≈ bytes / 4, divided by this floor rate,
 * never below the fixed budget. 50 tok/s is below every GPU node measured on this fleet (157–312)
 * and above the CPU-bound ones (27–37), which is the point: a node that slow reads as failed and
 * the work moves, a node merely working through a big prompt does not.
 */
export const MIN_PREFILL_TOKENS_PER_SEC = Math.max(1, Number(process.env.HUB_POOL_MIN_PREFILL_TOKENS_PER_SEC) || 50);

/**
 * Budget for a NON-STREAMED completion, which is a different thing from a connect budget.
 *
 * `CONNECT_TIMEOUT_MS` guards the wait for response headers, and for a streamed request that is
 * the wait for the first frame (see its own note on how long that can be). For a
 * non-streamed request the upstream sends no headers at all until the entire completion is ready, so
 * the same timer silently becomes a cap on TOTAL GENERATION TIME. Fifteen seconds of generation is
 * a short prompt; every real coding task, long summary or agent turn is longer, and every one of
 * them was aborted and reported to the caller as an unreachable node.
 *
 * Proven on the fleet, same node, same model, back to back:
 *   direct  :11434  -> HTTP 200 in 33.9s
 *   pool    :5002   -> HTTP 502 in 15.03s, "All pool nodes serving model ... are unreachable"
 * A 12s generation through the pool succeeded, and a cold model load — the likelier suspect —
 * succeeded in 4.6s with nothing resident. It is specifically generations past the deadline.
 *
 * Five minutes by default because that is comfortably past the worst decode this fleet produces
 * (a 2600-token generation on its slowest node measured ~300s), and env-overridable because the
 * right number is a property of the operator's hardware, not of this file.
 */
export const COMPLETION_TIMEOUT_MS = Math.max(CONNECT_TIMEOUT_MS, Number(process.env.HUB_POOL_COMPLETION_TIMEOUT_MS) || 300_000);

/**
 * The prompt-size estimate every pool decision uses: tokens ≈ bytes / 4 of the forwarded payload.
 *
 * One function, because two decisions now hang on it — how long to wait for a first byte, and
 * whether a node's prompt ceiling excludes it — and if they estimated differently a request could be
 * sent to a node as "under its ceiling" and then budgeted as though it were far larger. Coarse on
 * purpose: it counts the JSON envelope and tool schemas along with the prose, which is what the
 * engine has to read too.
 */
export function estimatePromptTokens(bodyBytes: number): number {
  return Math.ceil(bodyBytes / 4);
}

/** Header-wait budget for a streamed request carrying `bodyBytes` of prompt. Exported for the doctor and tests. */
export function firstByteBudgetMs(bodyBytes: number): number {
  return Math.max(CONNECT_TIMEOUT_MS, Math.ceil(estimatePromptTokens(bodyBytes) / MIN_PREFILL_TOKENS_PER_SEC) * 1000);
}

/**
 * The deadline a forward is actually placed under: the header wait for a streamed request, the whole
 * completion for a non-streamed one. One function, because throughput placement predicts against the
 * same number `fetchWithConnectTimeout` enforces.
 */
export function forwardBudgetMs(streaming: boolean, bodyBytes: number): number {
  return streaming ? firstByteBudgetMs(bodyBytes) : Math.max(COMPLETION_TIMEOUT_MS, firstByteBudgetMs(bodyBytes));
}
