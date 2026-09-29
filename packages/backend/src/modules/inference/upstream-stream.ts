import axios, { type AxiosResponse } from 'axios';

/** The settings that size a first-byte budget (`hub-pool-budget.ts`), for a deadline's error message. */
export const BUDGET_SETTINGS_HINT = '(HUB_POOL_FIRST_BYTE_TIMEOUT_MS / HUB_POOL_MIN_PREFILL_TOKENS_PER_SEC size this budget)';

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
 * Shared by the local engine path and the cloud fallback: the cloud path kept `timeout: 120000`
 * after the local one was fixed, so a streamed cloud answer that paused for two minutes was cut
 * the same way.
 */
export async function postStreamUnderHeaderDeadline(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  deadline: HeaderDeadline,
): Promise<AxiosResponse<NodeJS.ReadableStream>> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deadline.budgetMs);
  try {
    return await axios.post<NodeJS.ReadableStream>(url, body, {
      responseType: 'stream',
      timeout: 0,
      signal: abort.signal,
      headers,
    });
  } catch (err) {
    // axios reports our own abort as a bare "canceled"; say which deadline it was. Still a 502 at
    // the controller: nothing answered, and a slow upstream can be healthy.
    if (abort.signal.aborted) {
      throw new Error(`${deadline.upstream} sent no response headers within ${deadline.budgetMs}ms${deadline.hint ?? ''}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
