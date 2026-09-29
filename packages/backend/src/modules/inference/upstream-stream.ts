import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import axios, { type AxiosResponse } from 'axios';

/** The settings that size a first-byte budget (`hub-pool-budget.ts`), for a deadline's error message. */
export const BUDGET_SETTINGS_HINT = '(HUB_POOL_FIRST_BYTE_TIMEOUT_MS / HUB_POOL_MIN_PREFILL_TOKENS_PER_SEC size this budget)';

/** Why an upstream request was abandoned: the client it was for went away first. */
export const CLIENT_CLOSED_MESSAGE = 'The client closed the connection before the response finished';

/** How long a streamed request may wait for its response headers, and how to name it if it runs out. */
export interface HeaderDeadline {
  /** Milliseconds to wait for the response headers; nothing is timed once they arrive. */
  budgetMs: number;
  /** Who was asked, for the error message: `ollama`, `cloud provider openai`. */
  upstream: string;
  /** Appended to the error message: why this upstream may be slow, and which settings size the budget. */
  hint?: string;
}

/**
 * An `AbortSignal` that fires when `res`'s connection closes before the response finished, for
 * handing to the upstream request made on that client's behalf, so the upstream is abandoned with it.
 *
 * Without it nothing tied a local (no-peer) `/v1` request to its client. `pipe()` unpipes from a
 * destination that closed but never destroys its source, so a client that hung up mid-stream left
 * the Hub holding the engine's or the cloud provider's connection for as long as the upstream kept
 * it open: a cloud generation still being billed, or a local engine's sequence slot held for nobody.
 * The streamed cloud path used to be bounded by accident, because axios's `timeout: 120000` was also
 * a socket idle timeout and destroyed the paused upstream two minutes later. It lost that when the
 * idle timeout came out so a long pause mid-generation stops cutting live streams (see
 * {@link postStreamUnderHeaderDeadline}). Measured against a real socket before this: an upstream
 * whose client left after one frame was still connected seconds later, where the old timeout shape
 * had closed it.
 *
 * Keyed on `writableFinished`, because a response that completed normally closes too. Create it
 * before the request is routed, so a client that leaves while a model is chosen or loaded is not
 * missed; a response already closed by then aborts at once. The pool's pooled path has its own.
 */
export function abortWhenClientCloses(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort(new Error(CLIENT_CLOSED_MESSAGE));
  };
  if (res.destroyed) {
    onClose();
  } else {
    // `once`, and never removed: every response closes exactly once, finished or not, so the
    // listener is gone by the time the response is, and after a normal finish it is a no-op.
    res.once('close', onClose);
  }
  return controller.signal;
}

/**
 * Send an upstream stream to the client, each torn down with the other.
 *
 * `pipeline`, not `pipe`, for both directions. `pipe` leaves its source flowing when the destination
 * closes, so a client that hung up kept the upstream connection open; `pipeline` destroys the
 * upstream, and with it the socket. And `pipe` never ends the destination when the source fails
 * rather than ends, so an upstream that died mid-stream left the client waiting on a response that
 * never finished; `pipeline` cuts it, which is all a response already sent as 200 can do. The
 * pool's own relay is a `pipeline` for the same reasons.
 */
export function relayStream(upstream: NodeJS.ReadableStream, res: ServerResponse): void {
  pipeline(upstream, res, () => {
    // Nothing left to answer: a client that left has nobody to tell, and a failure after the
    // headers can only cut the response, which `pipeline` has already done.
  });
}

/**
 * POST a streamed request, giving the upstream `budgetMs` to answer with its headers and no deadline
 * at all once it has, so a long generation is never cut, exactly as through the pool.
 *
 * Not axios's `timeout`, because that does not stop at the headers. With axios's default transport
 * (follow-redirects) the wall-clock timer is cleared on the response, but the socket idle timeout
 * installed alongside it (`socket.setTimeout(timeout)`, then `socket.destroy` on expiry) stays for
 * the life of the stream: any gap between chunks as long as the budget kills the generation
 * mid-stream with ECONNRESET, after the client has already been sent a 200. Measured against this
 * repo's axios 1.18 / follow-redirects 1.16 with a server that pauses mid-stream. An engine that
 * sends its headers before it reads the prompt (vLLM, llama-server) has exactly such a gap, and so
 * does a cloud reasoning model that thinks for minutes between its first frame and its next. So
 * `timeout: 0`, and an abort signal whose timer is cleared the moment axios resolves, at the
 * headers, which is what the pool's `fetchWithConnectTimeout` does with `fetch`.
 *
 * `clientClosed` ({@link abortWhenClientCloses}) is combined with that deadline rather than checked
 * around it, and stays armed after the headers: axios listens on the signal until the response body
 * finishes, and on abort destroys the request and its socket. So a client that leaves while the
 * upstream is still reading the prompt stops the wait, and one that leaves mid-stream releases the
 * upstream connection, as through the pool.
 *
 * Shared by the local engine path and the cloud fallback: the cloud path kept `timeout: 120000`
 * after the local one was fixed, so a streamed cloud answer that paused for two minutes was cut
 * the same way.
 */
export async function postStreamUnderHeaderDeadline(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  deadline: HeaderDeadline,
  clientClosed?: AbortSignal,
): Promise<AxiosResponse<NodeJS.ReadableStream>> {
  const headerDeadline = new AbortController();
  const timer = setTimeout(() => headerDeadline.abort(), deadline.budgetMs);
  try {
    return await axios.post<NodeJS.ReadableStream>(url, body, {
      responseType: 'stream',
      timeout: 0,
      signal: clientClosed ? AbortSignal.any([headerDeadline.signal, clientClosed]) : headerDeadline.signal,
      headers,
    });
  } catch (err) {
    // axios reports an abort as a bare "canceled"; say which one it was. Still a 502 at the
    // controller: nothing answered, and a slow upstream can be healthy.
    if (headerDeadline.signal.aborted) {
      throw new Error(`${deadline.upstream} sent no response headers within ${deadline.budgetMs}ms${deadline.hint ?? ''}`);
    }
    if (clientClosed?.aborted) {
      throw new Error(`${CLIENT_CLOSED_MESSAGE}; the request to ${deadline.upstream} was abandoned before it answered`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
