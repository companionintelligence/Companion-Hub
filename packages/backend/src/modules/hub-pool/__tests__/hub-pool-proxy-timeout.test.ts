/**
 * Which deadline applies to which request.
 *
 * The bug this covers was invisible in code review because the comment was TRUE for the case
 * everyone pictured. `CONNECT_TIMEOUT_MS` "only guards the wait for response headers" — correct for a
 * streamed request, where the first frame arrives in milliseconds. For a non-streamed completion the
 * upstream sends no headers until the whole body is ready, so the identical timer silently becomes a
 * cap on total generation time.
 *
 * Proven on the fleet, same node, same model, back to back:
 *   direct :11434 -> 200 in 33.9s
 *   pool   :5002  -> 502 in 15.03s, reported as an unreachable node
 * A 12s generation through the pool succeeded, and a cold model load — the likelier suspect —
 * succeeded in 4.6s with nothing resident. It is specifically generations past the deadline, which
 * means every real coding task, long summary and agent turn failed while short pings passed.
 */

import { describe, expect, it } from 'vitest';
import { isStreamingRequest } from '../hub-pool-proxy.service';

describe('isStreamingRequest', () => {
  it('is true only for an explicit stream:true', () => {
    expect(isStreamingRequest({ stream: true })).toBe(true);
  });

  it('is false for a body that omits stream — the OpenAI default is non-streamed', () => {
    // The default matters: omitting `stream` is how almost every client sends a completion, and it
    // is exactly the case that was being cut off at 15s.
    expect(isStreamingRequest({ model: 'm', messages: [] })).toBe(false);
  });

  it('is false for stream:false and for truthy-but-not-true values', () => {
    expect(isStreamingRequest({ stream: false })).toBe(false);
    // A string "true" is not a streaming request — the upstream would not stream, so budgeting as
    // though it would is how a real generation gets aborted again.
    expect(isStreamingRequest({ stream: 'true' })).toBe(false);
    expect(isStreamingRequest({ stream: 1 })).toBe(false);
  });

  it('survives the shapes a proxy actually sees', () => {
    expect(isStreamingRequest(null)).toBe(false);
    expect(isStreamingRequest(undefined)).toBe(false);
    expect(isStreamingRequest('not an object')).toBe(false);
    expect(isStreamingRequest([])).toBe(false);
  });
});

describe('describeAllCandidatesFailed recognises both deadlines', () => {
  it('names a completion timeout as a deadline, not a dead node', async () => {
    // The seam the merge created: two deadlines now exist, and the message helper originally matched
    // only the header one. Left unfixed, every long-generation abort — the common case, and the
    // whole reason the completion budget exists — would print a raw abort string instead of the
    // sentence that stops an operator hunting through pairing and ACLs.
    const { describeAllCandidatesFailed } = await import('../hub-pool-proxy.service');
    const msg = describeAllCandidatesFailed('qwen3.6:35b', 2, new Error('No completion within 300000ms'));
    expect(msg).toMatch(/deadline, not/i);
    expect(msg).not.toMatch(/unreachable/i);
    expect(msg).toContain('HUB_POOL_COMPLETION_TIMEOUT_MS');
  });

  it('still names a header timeout the same way', async () => {
    const { describeAllCandidatesFailed } = await import('../hub-pool-proxy.service');
    expect(describeAllCandidatesFailed('m', 1, new Error('No response headers within 15000ms'))).toMatch(/deadline, not/i);
  });

  it('a real transport failure is still reported as a failure', async () => {
    const { describeAllCandidatesFailed } = await import('../hub-pool-proxy.service');
    const msg = describeAllCandidatesFailed('m', 3, new Error('connect ECONNREFUSED 100.64.0.2:5002'));
    expect(msg).toContain('ECONNREFUSED');
    expect(msg).not.toMatch(/deadline, not/i);
  });
});

describe('poolFetchDispatcher — undici must not cap the pool budgets at 300 s', () => {
  // Node's fetch is undici, whose default Agent abandons a request whose headers take longer than
  // 300 s, before any AbortController deadline set by the proxy. That silently capped the body-sized
  // first-byte budget: a 922 s budget on a CPU-served 46k-token turn failed at 300.8 s as "fetch
  // failed". These tests pin the three facts the fix rests on, without waiting five minutes.
  it("finds Node's bundled Agent and builds a dispatcher from the same class", async () => {
    const { poolFetchDispatcher, resetPoolFetchDispatcherForTests } = await import('../hub-pool-proxy.service');
    resetPoolFetchDispatcherForTests();
    const dispatcher = poolFetchDispatcher();
    expect(dispatcher).not.toBeNull();
    expect(typeof dispatcher?.dispatch).toBe('function');
    const installed = (globalThis as unknown as Record<symbol, { constructor: unknown }>)[Symbol.for('undici.globalDispatcher.1')];
    expect(dispatcher?.constructor).toBe(installed.constructor);
    expect(poolFetchDispatcher()).toBe(dispatcher); // memoised: one connection pool for all forwards
  });

  it('that class honours headersTimeout — so passing 0 really removes the 300 s cap', async () => {
    const { createServer } = await import('node:http');
    const { poolFetchDispatcher } = await import('../hub-pool-proxy.service');
    const server = createServer((_req, res) => setTimeout(() => res.writeHead(200).end('ok'), 1200));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/`;
    try {
      const AgentClass = poolFetchDispatcher()!.constructor as new (o: { headersTimeout: number }) => object;
      // A short header timer on the same class fails the slow server — proving the option is live,
      // which is what makes `headersTimeout: 0` a real change rather than a no-op.
      const short = fetch(url, { dispatcher: new AgentClass({ headersTimeout: 250 }) } as RequestInit);
      await expect(short).rejects.toMatchObject({ cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
      // The pool's dispatcher waits for the headers, however long the proxy's own budget allows.
      const res = await fetch(url, { dispatcher: poolFetchDispatcher() } as RequestInit);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      server.close();
    }
  });

  it('reports an undici header timeout as a deadline, not a dead node', async () => {
    const { describeAllCandidatesFailed } = await import('../hub-pool-proxy.service');
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT', message: 'Headers Timeout Error' } });
    const msg = describeAllCandidatesFailed('qwen3-coder:30b', 1, err);
    expect(msg).toMatch(/deadline, not/i);
    expect(msg).not.toMatch(/: fetch failed$/);
  });
});

describe('a missed deadline is recognisable as one', () => {
  // Throughput placement records a missed deadline as evidence, so the proxy has to be able to tell
  // its own budget running out from a refused connection. That rests on `fetch` rejecting with the
  // abort REASON the proxy passed, not a generic AbortError — pinned here against Node's real fetch.
  it("rejects fetch with the proxy's own deadline error, which isForwardDeadline recognises", async () => {
    const { createServer } = await import('node:http');
    const { PoolForwardDeadlineError, isForwardDeadline } = await import('../hub-pool-proxy.service');
    const server = createServer((_req, res) => setTimeout(() => res.writeHead(200).end('late'), 1_000));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const controller = new AbortController();
      const reason = new PoolForwardDeadlineError('No response headers within 50ms', 50);
      setTimeout(() => controller.abort(reason), 50);

      const error = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal }).catch((caught: unknown) => caught);

      expect(error).toBe(reason);
      expect(isForwardDeadline(error)).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('recognises undici’s own header timeout, and nothing else', async () => {
    const { isForwardDeadline } = await import('../hub-pool-proxy.service');
    expect(isForwardDeadline(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }))).toBe(true);
    expect(isForwardDeadline(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(false);
    // A message that merely looks like the deadline is not one: the 502 text is for people, not for this.
    expect(isForwardDeadline(new Error('No response headers within 920000ms'))).toBe(false);
  });
});
