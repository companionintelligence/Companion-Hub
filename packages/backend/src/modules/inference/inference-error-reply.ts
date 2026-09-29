import axios from 'axios';
import type { Response } from 'express';
import {
  REQUEST_ERROR_MAX_BYTES,
  REQUEST_ERROR_READ_TIMEOUT_MS,
  classifyRequestError,
  engineErrorMessage,
} from '@/modules/hub-pool/hub-pool-request-error';

/**
 * What the local (no-peer) `/v1` routes answer when a request fails, in OpenAI's error shape.
 *
 * Every catch in those routes used to answer `502 { type: 'server_error' }` with the thrown message,
 * whatever the cause. For an engine that refused the request, that message is axios's own summary,
 * not the engine's: beta-red, 2026-09-29, with the pool off, a chat request carrying `tools` for
 * `gemma3:4b` came back `502 "Request failed with status code 400"` where Ollama had said
 * `400 "registry.ollama.ai/library/gemma3:4b does not support tools"`. The OpenAI SDKs retry a 502
 * twice on their own, so the app waited for three identical refusals and then showed a reason that
 * named nothing. The pool path has relayed an engine's 4xx verbatim all along; this brings the
 * local path level with it.
 *
 * So there are three kinds of failure here, and they answer differently:
 *   - the engine (or cloud provider) answered: its status and its body reach the client, the body
 *     wrapped in OpenAI's envelope only when it is not already in it;
 *   - the router refused the request itself (an unknown model, a route a provider does not have):
 *     the status and code it chose, via {@link InferenceRouteError};
 *   - nothing answered — refused connection, timeout, a deadline of our own: 502, as before, because
 *     that is the one case where the Hub really is a gateway that got no answer.
 */

/** OpenAI's error envelope. Engines add their own fields (`param`, `code`, …), which pass through. */
export interface OpenAiErrorBody {
  error: { message: string; type: string; code?: string | null } & Record<string, unknown>;
}

/**
 * A refusal the router makes itself, carrying the status it should reach the client under.
 *
 * Typed rather than matched on message text, so a reworded message cannot silently turn a 404 back
 * into a 502.
 */
export class InferenceRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'InferenceRouteError';
  }
}

/**
 * The router has no local or cloud route for this model. OpenAI answers an unknown model with
 * exactly this — 404, `invalid_request_error`, `model_not_found` — and SDKs map it to a
 * NotFoundError they do not retry, where a 502 is retried as a server fault.
 */
export function modelNotFound(message: string): InferenceRouteError {
  return new InferenceRouteError(404, message, 'invalid_request_error', 'model_not_found');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOpenAiErrorBody(value: unknown): value is OpenAiErrorBody {
  return isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string';
}

function isReadable(value: unknown): value is NodeJS.ReadableStream & AsyncIterable<Buffer | string> {
  return (
    isRecord(value) && typeof value.pipe === 'function' && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/**
 * An error body that arrived as a stream, read up to `maxBytes` or until `timeoutMs`, whichever
 * comes first, and the stream released either way.
 *
 * A request sent with `responseType: 'stream'` gets its ERROR body as a stream too — axios does not
 * buffer it — so without this a streamed request's refusal has no message at all. Bounded for the
 * same reason the pool bounds its own error reads (see `REQUEST_ERROR_MAX_BYTES`): an engine's error
 * is a sentence, and a body still arriving after five seconds is not one.
 */
async function readBoundedText(stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>, maxBytes: number, timeoutMs: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const collected = (async () => {
    for await (const chunk of stream) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      chunks.push(bytes);
      size += bytes.length;
      if (size >= maxBytes) break;
    }
  })().catch(() => undefined);
  try {
    await Promise.race([collected, timedOut]);
  } finally {
    clearTimeout(timer);
    // Frees the upstream socket whether the body ended, overflowed or stalled.
    (stream as { destroy?: () => void }).destroy?.();
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

/** An upstream error body as text, plus its parsed JSON when it is JSON. */
async function readUpstreamBody(data: unknown): Promise<{ text: string; parsed: unknown }> {
  let text: string;
  if (data == null) {
    text = '';
  } else if (typeof data === 'string') {
    text = data;
  } else if (Buffer.isBuffer(data)) {
    text = data.toString('utf8');
  } else if (data instanceof ArrayBuffer) {
    text = Buffer.from(data).toString('utf8');
  } else if (isReadable(data)) {
    text = await readBoundedText(data, REQUEST_ERROR_MAX_BYTES, REQUEST_ERROR_READ_TIMEOUT_MS);
  } else {
    // Already parsed by axios (the default `responseType: 'json'`).
    return { text: JSON.stringify(data) ?? '', parsed: data };
  }
  try {
    return { text, parsed: JSON.parse(text) };
  } catch {
    return { text, parsed: undefined };
  }
}

/** The status and OpenAI-shaped body a failed local `/v1` request answers with. Never throws. */
export async function describeRouteError(err: unknown): Promise<{ status: number; body: OpenAiErrorBody }> {
  if (err instanceof InferenceRouteError) {
    return { status: err.status, body: { error: { message: err.message, type: err.type, ...(err.code ? { code: err.code } : {}) } } };
  }
  if (axios.isAxiosError(err) && err.response && err.response.status >= 400) {
    const upstreamStatus = err.response.status;
    const { text, parsed } = await readUpstreamBody(err.response.data).catch(() => ({ text: '', parsed: undefined }));
    // An engine 500 that the pool already knows to be the request's own fault ("no user query found
    // in messages", …) goes out as a 400, as it does through the pool (`relayedRequestErrorStatus`),
    // so an SDK does not retry a request that will fail identically every time. Only the definitive
    // ones: the pool asks a second node before believing the others, and here there is no second node.
    const verdict = classifyRequestError(upstreamStatus, text);
    const status = verdict?.definitive && !verdict.strikesModel ? 400 : upstreamStatus;
    if (isOpenAiErrorBody(parsed)) {
      return { status, body: parsed };
    }
    // Ollama's native `{"error": "..."}`, vLLM's `{"object": "error", …}`, or plain text.
    const message = engineErrorMessage(parsed) ?? (text.trim() || `Upstream returned HTTP ${upstreamStatus}`);
    return { status, body: { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error' } } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 502, body: { error: { message, type: 'server_error' } } };
}

/**
 * Answer a failed local `/v1` request. A response already committed (a stream that failed after its
 * headers went out) cannot take a status any more, so it is cut instead — the same rule as the pool's
 * `respondUncommitted`.
 */
export async function sendRouteError(res: Response, err: unknown): Promise<void> {
  const { status, body } = await describeRouteError(err);
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  res.status(status).json(body);
}
