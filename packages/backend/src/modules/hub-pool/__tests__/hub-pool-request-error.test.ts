import { describe, expect, it } from 'vitest';
import {
  REQUEST_ERROR_MAX_BYTES,
  classifyRequestError,
  engineErrorMessage,
  judgeRequestError,
  lastCandidateRequestError,
  passedThroughRequestError,
  readRequestErrorVerdict,
  type PoolRequestErrorVerdict,
  type RequestErrorWalk,
} from '../hub-pool-request-error';

const json = (value: unknown) => JSON.stringify(value);

describe('classifyRequestError', () => {
  it('reads Ollama’s native answer to a turn with no user message as the request’s fault, on the first node', () => {
    // Verbatim from core-14's Ollama 0.34.0, 2026-09-26 23:51:23Z.
    expect(classifyRequestError(500, json({ error: 'no user query found in messages' }))).toEqual({
      signature: 'no-user-query',
      definitive: true,
      strikesModel: false,
    });
  });

  it('reads the same message in each engine’s error shape, whatever its case and punctuation', () => {
    const bodies = [
      // llama-server, where the Qwen template's own `raise_exception` supplies the text.
      { error: { code: 500, message: 'No user query found in messages.', type: 'server_error' } },
      // Ollama's `/v1` routes.
      { error: { message: 'no user query found in messages', type: 'api_error', param: null, code: null } },
      // vLLM.
      { object: 'error', message: 'Jinja: No user query found in messages.', type: 'InternalServerError', code: 500 },
    ];
    for (const body of bodies) {
      expect(classifyRequestError(500, json(body))?.signature).toBe('no-user-query');
    }
  });

  it('judges only a 500: a 4xx is already the caller’s, and a 502, 503 or 504 is a node talking about itself', () => {
    const body = json({ error: 'no user query found in messages' });
    for (const status of [400, 404, 422, 429, 501, 502, 503, 504]) {
      expect(classifyRequestError(status, body)).toBeNull();
    }
  });

  it('never reads a node’s own trouble as the request’s', () => {
    for (const error of [
      'model requires more system memory (30.1 GiB) than is available (22.4 GiB)',
      'llama runner process has terminated: exit status 2',
      'timed out waiting for llama runner to start - progress 0.00',
      'model failed to load, this may be due to resource limitations or an internal error',
      'runtime error: invalid memory address or nil pointer dereference',
      'context canceled',
    ]) {
      expect(classifyRequestError(500, json({ error }))).toBeNull();
    }
  });

  it('ignores a body that is not an engine’s error: plain text, HTML from a proxy, or the Hub’s own 500', () => {
    expect(classifyRequestError(500, 'no user query found in messages')).toBeNull();
    expect(classifyRequestError(500, '<html><body>no user query found in messages</body></html>')).toBeNull();
    expect(classifyRequestError(500, json({ statusCode: 500, message: 'no user query found in messages' }))).toBeNull();
    expect(classifyRequestError(500, '')).toBeNull();
  });

  it('asks a second node before believing what one engine may judge differently from another', () => {
    const cases: Array<[string, PoolRequestErrorVerdict['signature'], boolean]> = [
      ['Missing \'role\' in message: {"content":"x"}', 'invalid-message', false],
      ["Expected 'content' or 'tool_calls' (ref: https://github.com/ggml-org/llama.cpp/issues/8367)", 'invalid-message', false],
      ['the request exceeds the available context size, try increasing it', 'context-length', false],
      ["This model's maximum context length is 32768 tokens. However, you requested 40000 tokens.", 'context-length', false],
      ['template: :14:7: executing "" at <.ToolCalls>: can\'t evaluate field ToolCalls', 'chat-template', true],
      ['Error rendering the chat template', 'chat-template', true],
    ];
    for (const [message, signature, strikesModel] of cases) {
      expect(classifyRequestError(500, json({ error: message }))).toEqual({ signature, definitive: false, strikesModel });
    }
  });

  it('takes a chat body with no messages at all as the request’s fault on the first node', () => {
    expect(classifyRequestError(500, json({ error: { message: "'messages' is required", type: 'server_error' } }))).toMatchObject({
      signature: 'missing-messages',
      definitive: true,
    });
    expect(classifyRequestError(500, json({ error: "Expected 'messages' to be an array, got null" }))?.signature).toBe('missing-messages');
  });
});

describe('engineErrorMessage', () => {
  it('finds no message in a body no engine sends', () => {
    expect(engineErrorMessage(null)).toBeNull();
    expect(engineErrorMessage(['no user query found in messages'])).toBeNull();
    expect(engineErrorMessage({ error: { code: 500 } })).toBeNull();
    expect(engineErrorMessage({ message: 'x' })).toBeNull();
  });
});

describe('readRequestErrorVerdict', () => {
  const promptError = () => new Response(json({ error: 'no user query found in messages' }), { status: 500 });

  it('reads the verdict from a clone, and leaves the response whole to relay to the caller', async () => {
    const response = promptError();

    expect(await readRequestErrorVerdict(response)).toMatchObject({ signature: 'no-user-query' });
    expect(await response.json()).toEqual({ error: 'no user query found in messages' });
  });

  it('does not touch the body of anything but a 500', async () => {
    const response = new Response(json({ error: 'no user query found in messages' }), { status: 503 });

    expect(await readRequestErrorVerdict(response)).toBeNull();
    expect(response.bodyUsed).toBe(false);
  });

  it('gives up on a body that has not finished arriving, rather than holding the walk', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        // Headers and the start of a body, and then nothing: the engine is not answering.
        controller.enqueue(new TextEncoder().encode('{"error":"no user query'));
      },
    });
    const startedAt = Date.now();

    expect(await readRequestErrorVerdict(new Response(stalled, { status: 500 }), { timeoutMs: 50 })).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('gives up on a body larger than any engine error', async () => {
    const huge = json({ error: `no user query found in messages ${'x'.repeat(REQUEST_ERROR_MAX_BYTES)}` });

    expect(await readRequestErrorVerdict(new Response(huge, { status: 500 }))).toBeNull();
  });

  it('reads a body that already failed as no verdict, never as a throw', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('socket hang up'));
      },
    });

    await expect(readRequestErrorVerdict(new Response(broken, { status: 500 }))).resolves.toBeNull();
  });
});

describe('judgeRequestError', () => {
  const definitive: PoolRequestErrorVerdict = { signature: 'no-user-query', definitive: true, strikesModel: false };
  const template: PoolRequestErrorVerdict = { signature: 'chat-template', definitive: false, strikesModel: true };
  const malformed: PoolRequestErrorVerdict = { signature: 'invalid-message', definitive: false, strikesModel: false };
  const tooLong: PoolRequestErrorVerdict = { signature: 'context-length', definitive: false, strikesModel: false };

  /** A candidate as the walk sees it: the node's name, its engine, and the window it runs the request at. */
  interface Node {
    name: string;
    engine: string;
    window: number | null;
  }
  const node = (name: string, engine = 'ollama', window: number | null = 16384): Node => ({ name, engine, window });
  const walk = (...untried: Node[]): RequestErrorWalk<Node> => ({
    untried,
    engineOf: (candidate) => candidate.engine,
    windowOf: (candidate) => candidate.window,
  });
  const refusedBy = (verdict: PoolRequestErrorVerdict, candidate: Node) => ({ verdict, candidate, node: candidate.name });

  it('ends the walk on a definitive verdict, confirmed by nobody, whatever is still ahead', () => {
    expect(judgeRequestError(definitive, node('b'), null, walk(node('c', 'vllm', null)))).toEqual({
      signature: 'no-user-query',
      basis: 'definitive',
      confirms: null,
    });
  });

  it('carries an ambiguous verdict forward, and ends the walk when the next one to answer agrees', () => {
    expect(judgeRequestError(template, node('a'), null, walk(node('b')))).toBeNull();
    expect(judgeRequestError(template, node('b'), refusedBy(template, node('a')), walk(node('c')))).toEqual({
      signature: 'chat-template',
      basis: 'confirmed',
      confirms: 'a',
    });
  });

  it('reads a different reason as new evidence, not agreement', () => {
    expect(judgeRequestError(tooLong, node('b'), refusedBy(template, node('a')), walk())).toBeNull();
  });

  it('counts a second "too long" only from a candidate running the same, known window', () => {
    expect(judgeRequestError(tooLong, node('b', 'ollama', 65536), refusedBy(tooLong, node('a')), walk())).toBeNull();
    expect(judgeRequestError(tooLong, node('b', 'ollama', null), refusedBy(tooLong, node('a', 'ollama', null)), walk())).toBeNull();
    expect(judgeRequestError(tooLong, node('b'), refusedBy(tooLong, node('a')), walk())).toMatchObject({ basis: 'confirmed' });
  });

  /**
   * Two agreeing proves the prompt needs more than THEIR window, and nothing about a node further
   * down: the second refuser is only the next in rank.
   */
  it('does not end the walk on "too long" while a node still ahead runs a larger window, or does not say', () => {
    const agreed = refusedBy(tooLong, node('a'));

    expect(judgeRequestError(tooLong, node('b'), agreed, walk(node('c', 'ollama', 131072)))).toBeNull();
    expect(judgeRequestError(tooLong, node('b'), agreed, walk(node('c'), node('d', 'ollama', null)))).toBeNull();
    expect(judgeRequestError(tooLong, node('b'), agreed, walk(node('c'), node('d', 'ollama', 8192)))).toMatchObject({ basis: 'confirmed' });
  });

  it('does not end the walk on a malformed message or a template while an engine that has not refused is still ahead', () => {
    for (const verdict of [malformed, template]) {
      const agreed = refusedBy(verdict, node('a', 'lemonade'));

      expect(judgeRequestError(verdict, node('b', 'lemonade'), agreed, walk(node('c', 'lemonade'), node('d', 'ollama')))).toBeNull();
      expect(judgeRequestError(verdict, node('b', 'lemonade'), agreed, walk(node('c', 'lemonade')))).toMatchObject({ basis: 'confirmed' });
      // Two engines that both refused cover both of them.
      expect(judgeRequestError(verdict, node('b', 'ollama'), agreed, walk(node('c', 'ollama'), node('d', 'lemonade')))).toMatchObject({
        basis: 'confirmed',
      });
    }
  });

  it('does not care what is ahead once the verdict is on the last candidate', () => {
    expect(judgeRequestError(tooLong, node('b'), refusedBy(tooLong, node('a')), walk())).toMatchObject({ basis: 'confirmed' });
    expect(judgeRequestError(malformed, node('b', 'vllm'), refusedBy(malformed, node('a', 'lemonade')), walk())).toMatchObject({
      basis: 'confirmed',
    });
  });
});

describe('lastCandidateRequestError', () => {
  it('labels the verdict the walk ended on unconfirmed, naming no node it agreed with', () => {
    const malformed: PoolRequestErrorVerdict = { signature: 'invalid-message', definitive: false, strikesModel: false };

    expect(lastCandidateRequestError(malformed)).toEqual({ signature: 'invalid-message', basis: 'last-candidate', confirms: null });
  });
});

describe('passedThroughRequestError', () => {
  it('labels every 4xx by its status alone, and nothing else', () => {
    for (const status of [400, 401, 404, 413, 422, 499]) {
      expect(passedThroughRequestError(status)).toEqual({ signature: 'client-error', basis: 'status', confirms: null });
    }
    // A served answer is not a refusal, and a 5xx that reached here is an engine's verdict, labelled by its body.
    for (const status of [200, 204, 304, 399, 500, 502]) {
      expect(passedThroughRequestError(status)).toBeNull();
    }
  });
});
