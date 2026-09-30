import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
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
 * The one `close` listener a response carries for everything the Hub needs to know about it closing:
 * whether the client left (which aborts `clientClosed`, the signal handed to the upstream request made
 * on the client's behalf), and, for {@link relayToResponse}, whether to stop relaying.
 *
 * One per response, and shared, because every `close` listener on a response counts against Node's
 * limit of ten for it. The pool path used to add eight of its own to one request — one for its
 * client-closed signal and seven from `pipeline`'s end-of-stream bookkeeping — and the Sentry HTTP
 * integration adds three more to every server response, so every relayed pool request crossed the
 * limit: `MaxListenersExceededWarning: 11 close listeners added to [ServerResponse]`, 1,011 times in
 * one hour on core-2, 2026-09-29. Nothing was leaking and walking more candidates added none, but the
 * warning fires once per response, and a warning that fires on every request hides the one that
 * would matter.
 */
export interface ResponseCloseWatch {
  /**
   * Aborted when the client left: the response closed before it finished, and not because the Hub
   * destroyed it with an error. A response that completed normally closes too, and a relay whose
   * UPSTREAM died destroys the response with that error, which also closes it; neither is a hang-up.
   */
  readonly clientClosed: AbortSignal;
  /** Whether the response has closed, for any reason. */
  readonly closed: boolean;
  /** Call `listener` once when the response closes, or at once if it already has. Returns the unsubscribe. */
  onClose(listener: () => void): () => void;
  /** Take the listener off the response, for the handler that is done with it. Nothing is aborted after this. */
  dispose(): void;
}

/** The part of a response the watch and the relay use: an Express response, a bare `ServerResponse`, or a test's `Writable`. */
export type RelayTarget = Pick<ServerResponse, 'write' | 'end' | 'destroy' | 'on' | 'once' | 'off' | 'destroyed' | 'writableFinished'> & {
  readonly errored?: Error | null;
};

const responseWatches = new WeakMap<object, ResponseCloseWatch>();

/**
 * The {@link ResponseCloseWatch} for `res`, made on first use and shared after that, so however many
 * places ask about one response it carries one `close` listener. `message` is the abort reason the
 * first caller wants; a later caller shares the signal the first one made.
 */
export function watchResponseClose(res: RelayTarget, message = CLIENT_CLOSED_MESSAGE): ResponseCloseWatch {
  const existing = responseWatches.get(res);
  if (existing) {
    return existing;
  }
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  let closed = false;
  const onClose = () => {
    closed = true;
    responseWatches.delete(res);
    // `errored` because a client leaving is not the only way a response closes unfinished: a relay
    // whose upstream died destroys the response with that error. A client that disconnects leaves it
    // null: Node closes the response from the socket, not through `destroy(err)`.
    if (!res.writableFinished && !res.errored) controller.abort(new Error(message));
    for (const listener of [...listeners]) {
      listeners.delete(listener);
      try {
        listener();
      } catch {
        // One subscriber's failure must not stop the others hearing the close.
      }
    }
  };
  const watch: ResponseCloseWatch = {
    clientClosed: controller.signal,
    get closed() {
      return closed;
    },
    onClose(listener) {
      if (closed) {
        listener();
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      res.off('close', onClose);
      responseWatches.delete(res);
      listeners.clear();
    },
  };
  if (res.destroyed) {
    onClose();
  } else {
    res.once('close', onClose);
    responseWatches.set(res, watch);
  }
  return watch;
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
 * missed; a response already closed by then aborts at once. It is the signal of the response's
 * shared {@link watchResponseClose}, so it costs the response no listener of its own.
 */
export function abortWhenClientCloses(res: RelayTarget): AbortSignal {
  return watchResponseClose(res).clientClosed;
}

/**
 * Why {@link relayToResponse} stopped: the UPSTREAM body failed (an engine that died mid-generation),
 * or the DOWNSTREAM response closed or failed under it (a client that left, a socket write that
 * failed). The two mean different things to a caller that keeps a record — the first is the serving
 * node's failure, the second is not — and `pipeline` reported both as whichever error came first.
 */
export class RelayError extends Error {
  constructor(
    readonly side: 'upstream' | 'downstream',
    override readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : cause == null ? '' : String(cause);
    super(
      side === 'upstream'
        ? `the upstream response failed mid-body${detail ? `: ${detail}` : ''}`
        : `the response to the client closed${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'RelayError';
  }
}

function isWebStream(source: unknown): source is ReadableStream<Uint8Array> {
  return typeof (source as ReadableStream | undefined)?.getReader === 'function';
}

/**
 * Send an upstream body to the client, each torn down with the other, adding no `close` listener to
 * the response: it hears the close through the response's {@link watchResponseClose}.
 *
 * What it keeps from the `pipeline` it replaces, each measured against real sockets in
 * `upstream-stream.test.ts` and the pool's `hub-pool-proxy-client-abort.test.ts`:
 *   - a client that leaves cancels the upstream body, and with it the engine's or provider's
 *     connection. `pipe` alone left the source flowing into nothing;
 *   - an upstream that dies mid-body destroys the response with that error, so the client sees a cut
 *     connection rather than a response it may take for whole. A response already sent as 200 can do
 *     no more;
 *   - backpressure: nothing more is read while the client's socket buffer is full.
 * What it adds is saying which side failed, as a {@link RelayError}. Resolves once the response has
 * finished, as `pipeline` did.
 */
export async function relayToResponse(
  source: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
  res: RelayTarget,
  watch: ResponseCloseWatch = watchResponseClose(res),
): Promise<void> {
  const web = isWebStream(source) ? source : (Readable.toWeb(source as Readable) as unknown as ReadableStream<Uint8Array>);
  const reader = web.getReader();
  let downstreamClosed = watch.closed;
  let downstreamError: unknown = null;
  // The `error` a failed write emits on a plain Writable; a ServerResponse reports its socket's
  // failures to the server instead. Kept for the error the relay throws, never left unhandled.
  const onError = (error: unknown) => {
    downstreamError ??= error;
  };
  res.on('error', onError);
  // Cancelling a pending read resolves it as done, so a client that leaves while the upstream is
  // silent — an engine still reading the prompt — still releases the upstream at once.
  const unsubscribe = watch.onClose(() => {
    downstreamClosed = true;
    reader.cancel(new Error(CLIENT_CLOSED_MESSAGE)).catch(() => undefined);
  });
  const closedError = () => new RelayError('downstream', downstreamError ?? res.errored ?? new Error(CLIENT_CLOSED_MESSAGE));
  try {
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        throw downstreamClosed ? closedError() : new RelayError('upstream', error);
      }
      if (downstreamClosed || res.destroyed || downstreamError) {
        throw closedError();
      }
      if (next.done) {
        break;
      }
      if (!res.write(next.value)) {
        await untilDrained(res, watch);
      }
    }
    await untilFinished(res, watch);
    if (downstreamError) {
      throw closedError();
    }
  } catch (error) {
    reader.cancel(error).catch(() => undefined);
    if (error instanceof RelayError && error.side === 'upstream' && !res.destroyed) {
      res.destroy(error.cause instanceof Error ? error.cause : error);
    }
    throw error;
  } finally {
    unsubscribe();
    res.off('error', onError);
  }
}

/** Resolves when `res` can take more, or has closed, whichever comes first. Its listeners go with it. */
function untilDrained(res: RelayTarget, watch: ResponseCloseWatch): Promise<void> {
  return new Promise<void>((resolve) => {
    let unsubscribe: () => void = () => undefined;
    const done = () => {
      res.off('drain', done);
      unsubscribe();
      resolve();
    };
    res.on('drain', done);
    unsubscribe = watch.onClose(done);
  });
}

/** Ends `res` and resolves once it has finished; rejects if it closes unfinished first. */
function untilFinished(res: RelayTarget, watch: ResponseCloseWatch): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (error) reject(new RelayError('downstream', error));
      else resolve();
    };
    unsubscribe = watch.onClose(() => settle(res.writableFinished ? undefined : (res.errored ?? new Error(CLIENT_CLOSED_MESSAGE))));
    res.end((error?: unknown) => settle(error ?? undefined));
  });
}

/**
 * Send an upstream stream to the client, each torn down with the other — {@link relayToResponse} for a
 * caller with nothing left to do once it is over. A client that left has nobody to tell, and a
 * failure after the headers can only cut the response, which the relay has already done.
 */
export function relayStream(upstream: NodeJS.ReadableStream, res: RelayTarget): void {
  const watch = watchResponseClose(res);
  relayToResponse(upstream, res, watch)
    .catch(() => undefined)
    .finally(() => watch.dispose());
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
