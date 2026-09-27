import { describe, expect, it } from 'vitest';
import {
  REQUEST_ERROR_MAX_BYTES,
  classifyRequestError,
  engineErrorMessage,
  judgeRequestError,
  readRequestErrorVerdict,
  type PoolRequestErrorVerdict,
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
  const tooLong: PoolRequestErrorVerdict = { signature: 'context-length', definitive: false, strikesModel: false };
  const anyWindow = () => true;

  it('ends the walk on a definitive verdict, confirmed by nobody', () => {
    expect(judgeRequestError(definitive, 'b', null, anyWindow)).toEqual({ signature: 'no-user-query', basis: 'definitive', confirms: null });
  });

  it('carries an ambiguous verdict forward, and ends the walk when the next one to answer agrees', () => {
    expect(judgeRequestError(template, 'a', null, anyWindow)).toBeNull();
    expect(judgeRequestError(template, 'b', { verdict: template, candidate: 'a', node: 'node-a' }, anyWindow)).toEqual({
      signature: 'chat-template',
      basis: 'confirmed',
      confirms: 'node-a',
    });
  });

  it('reads a different reason as new evidence, not agreement', () => {
    expect(judgeRequestError(tooLong, 'b', { verdict: template, candidate: 'a', node: 'node-a' }, anyWindow)).toBeNull();
  });

  it('counts a second "too long" only from a candidate running the same window', () => {
    const unconfirmed = { verdict: tooLong, candidate: 'a', node: 'node-a' };

    expect(judgeRequestError(tooLong, 'b', unconfirmed, () => false)).toBeNull();
    expect(judgeRequestError(tooLong, 'b', unconfirmed, (x, y) => x === 'a' && y === 'b')).toMatchObject({ basis: 'confirmed' });
  });
});
