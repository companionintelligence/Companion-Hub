/**
 * Which engine 500s are a verdict on the REQUEST rather than on the node that answered it.
 *
 * The pool fails over on every 5xx, because a 5xx usually means "this node cannot serve you right
 * now" and the next node usually can. Some engines also answer 500 when the request itself is bad,
 * and then every node gives the same answer. core-2, 2026-09-26 23:51:12Z: one `qwen3.8:27b` turn
 * with no user message was answered `500 {"error":"no user query found in messages"}` by core-14
 * (128 ms), core-17 (134 ms), core-7 (after 4m29s queued behind another turn) and beta-max, and the
 * proxy walked all nine candidates for 307 s before handing the app a 502 that named neither the
 * cause nor the request. Each of those 500s was also a strike against the model on the node that
 * sent it, and two strikes inside five minutes withhold a model from routing.
 *
 * So a 500 is read, and it is taken as the request's fault only when its body is one of the engine
 * messages below, in one of the error shapes the engines actually send. Anything else — a 5xx
 * without a match, a 503, a 429, a timeout, a refused connection — still fails over exactly as
 * before. The list is short on purpose: a false match hands an app an error another node would
 * have served, and that is worse than a slow failure.
 */

import type { PoolRoutingRequestError } from './hub-pool-routing-log.service';

/** A label for the engine message a response matched. The routing log records this, never the message: engines quote the prompt in some of theirs. */
export type PoolRequestErrorSignature = 'no-user-query' | 'missing-messages' | 'invalid-message' | 'context-length' | 'chat-template';

export interface PoolRequestErrorVerdict {
  signature: PoolRequestErrorSignature;
  /**
   * `true`: no node could have answered this request otherwise, so the first node that says so is
   * believed. `false`: another node might serve it — an engine that validates differently, a larger
   * window, a node whose own copy of the model is broken — so one more node has to agree first.
   */
  definitive: boolean;
  /** Whether the answer might still be the node's own fault, and so still counts against the model's serving record there. */
  strikesModel: boolean;
}

interface SignatureRule extends PoolRequestErrorVerdict {
  pattern: RegExp;
}

/** First match wins, so a Jinja error quoting the Qwen message reads as `no-user-query`, not as a template failure. */
const SIGNATURES: readonly SignatureRule[] = [
  {
    // Qwen3-family chat templates refuse a conversation with no user turn: Ollama's Go renderer,
    // and the template's own `raise_exception` under llama-server and vLLM. The template ships with
    // the model, so every node holding the model refuses the same body.
    signature: 'no-user-query',
    pattern: /\bno user query found in messages\b/i,
    definitive: true,
    strikesModel: false,
  },
  {
    // A chat body with no usable `messages` at all, which no engine can run.
    signature: 'missing-messages',
    pattern: /'messages' is required|\bmessages (?:field )?is required\b|expected 'messages' to be an array/i,
    definitive: true,
    strikesModel: false,
  },
  {
    // llama-server's per-message shape checks, which older builds answer with 500. Another engine
    // holding the same model may accept the message, so it takes a second candidate to agree.
    signature: 'invalid-message',
    pattern: /missing '(?:role|content)' in message|expected 'message' to be an object|expected 'content' or 'tool_calls'/i,
    definitive: false,
    strikesModel: false,
  },
  {
    // The prompt did not fit the window this node runs, which a node with a larger one may have.
    // The proxy only counts a second candidate as agreeing when it runs the same window.
    signature: 'context-length',
    pattern:
      /exceeds? the available context size|maximum context length|context[_ ]length[_ ]exceeded|exceeds (?:the )?(?:model's )?context (?:length|window)/i,
    definitive: false,
    strikesModel: false,
  },
  {
    // A chat template that failed to render: Go `text/template` in Ollama, Jinja elsewhere. Usually
    // the request, but a node's own copy of the model can carry a broken template, so it takes a
    // second candidate to agree and it still counts against the model where it happened.
    signature: 'chat-template',
    pattern: /\btemplate: .*\bexecuting\b|\bjinja\b|\bchat template\b|\braise_exception\b|\bprompt error\b/i,
    definitive: false,
    strikesModel: true,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The message from an engine's error body, or `null` when the body is not one of the shapes an
 * engine sends. The Hub's own 500 (`{ statusCode, message }`, Nest's shape — a peer whose forward
 * threw) is deliberately not one of them: it says nothing about the request.
 */
export function engineErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  // Ollama's native routes: `{"error": "..."}`.
  if (typeof body.error === 'string') return body.error;
  // OpenAI's shape, which llama-server, Lemonade and Ollama's own `/v1` routes send too.
  if (isRecord(body.error) && typeof body.error.message === 'string') return body.error.message;
  // vLLM: `{"object": "error", "message": "..."}`.
  if (body.object === 'error' && typeof body.message === 'string') return body.message;
  return null;
}

/**
 * The verdict a response carries, from its status and body text, or `null` when it carries none.
 *
 * Only a 500. A 4xx is already passed to the caller, and every other 5xx — 502, 503, 504 — is a
 * gateway or a node talking about its own availability, which is exactly what failover is for,
 * whatever words it happens to use.
 */
export function classifyRequestError(status: number, bodyText: string): PoolRequestErrorVerdict | null {
  if (status !== 500) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const message = engineErrorMessage(parsed);
  if (message === null) return null;
  const rule = SIGNATURES.find((entry) => entry.pattern.test(message));
  return rule ? { signature: rule.signature, definitive: rule.definitive, strikesModel: rule.strikesModel } : null;
}

/** Largest error body read for a verdict. An engine's error is a sentence; anything bigger is not one of the messages above. */
export const REQUEST_ERROR_MAX_BYTES = 64 * 1024;

/**
 * How long reading an error body may hold up the failover walk. An engine writes its error with the
 * headers; a 500 whose body is still arriving after this is not answering the request, and the walk
 * moves on as it always did.
 */
export const REQUEST_ERROR_READ_TIMEOUT_MS = 5_000;

/**
 * {@link classifyRequestError} for a live response, read from a clone so the response itself can
 * still be relayed whole. `null` — the old reading, a node failure — for anything that is not a 500,
 * a body over {@link REQUEST_ERROR_MAX_BYTES}, one that has not finished within
 * {@link REQUEST_ERROR_READ_TIMEOUT_MS}, or a read that fails. Never throws.
 */
export async function readRequestErrorVerdict(
  response: globalThis.Response,
  limits: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<PoolRequestErrorVerdict | null> {
  if (response.status !== 500 || !response.body) return null;
  const maxBytes = limits.maxBytes ?? REQUEST_ERROR_MAX_BYTES;
  const timeoutMs = limits.timeoutMs ?? REQUEST_ERROR_READ_TIMEOUT_MS;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = (response.clone().body as ReadableStream<Uint8Array>).getReader();
  } catch {
    return null;
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timedOut]);
      if (next === 'timeout') return null;
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // Only the clone's half of the tee: the response the caller may still be handed is untouched.
    reader.cancel().catch(() => undefined);
  }
  return classifyRequestError(response.status, Buffer.concat(chunks).toString('utf8'));
}

/** A verdict the walk is carrying forward until another candidate agrees with it or serves the request. */
export interface UnconfirmedRequestError<C> {
  verdict: PoolRequestErrorVerdict;
  candidate: C;
  node: string;
}

/**
 * Whether `verdict`, from `candidate`, ends the walk — and if so the routing log's account of why —
 * given the verdict an earlier candidate left unconfirmed, if any.
 *
 * Confirmation is by signature: two candidates refusing the same body for the same reason. A
 * different reason is new evidence rather than agreement, and becomes the verdict the next
 * candidate is asked to confirm. A candidate that failed without answering confirms nothing, and
 * the walk keeps the verdict it had. For `context-length` the two candidates must also run the same
 * window, which only the caller knows how to judge.
 */
export function judgeRequestError<C>(
  verdict: PoolRequestErrorVerdict,
  candidate: C,
  unconfirmed: UnconfirmedRequestError<C> | null,
  sameContextWindow: (a: C, b: C) => boolean,
): PoolRoutingRequestError | null {
  if (verdict.definitive) {
    return { signature: verdict.signature, basis: 'definitive', confirms: null };
  }
  if (!unconfirmed || unconfirmed.verdict.signature !== verdict.signature) {
    return null;
  }
  if (verdict.signature === 'context-length' && !sameContextWindow(unconfirmed.candidate, candidate)) {
    return null;
  }
  return { signature: verdict.signature, basis: 'confirmed', confirms: unconfirmed.node };
}
