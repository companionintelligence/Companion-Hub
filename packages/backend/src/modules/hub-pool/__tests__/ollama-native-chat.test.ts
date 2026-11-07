import { describe, expect, it } from 'vitest';
import { nativeChatPlan, nativeChatPlanAt, nativeChatWindow, openAiChatResponse } from '../ollama-native-chat';

const PNG = 'iVBORw0KGgo=';

function turn(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: 'qwen3.5:4b', options: { num_ctx: 65_536 }, messages: [{ role: 'user', content: 'hi' }], ...extra };
}

/** A native answer as Ollama streams it: one JSON object per line, split across reads at arbitrary points. */
function ndjson(lines: unknown[], splitAt = 7, status = 200): globalThis.Response {
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += splitAt) controller.enqueue(bytes.slice(at, at + splitAt));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'application/x-ndjson' } });
}

function events(text: string): unknown[] {
  return text
    .split('\n\n')
    .filter((event) => event.startsWith('data: '))
    .map((event) => event.slice('data: '.length))
    .map((data) => (data === '[DONE]' ? '[DONE]' : JSON.parse(data)));
}

const at = '2026-11-07T10:00:00.000Z';

describe('nativeChatPlan', () => {
  it('leaves a request that names no window on /v1, since that is all /v1 loses', () => {
    expect(nativeChatPlan({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })).toBeNull();
    expect(nativeChatPlan(turn({ options: { num_ctx: 0 } }))).toBeNull();
    expect(nativeChatPlan(turn({ options: { num_ctx: 4096.5 } }))).toBeNull();
    expect(nativeChatPlan(turn({ options: { temperature: 0.2 } }))).toBeNull();
    expect(nativeChatWindow(turn())).toBe(65_536);
    expect(nativeChatWindow({ model: 'm', messages: [] })).toBeNull();
  });

  it('maps the fields Ollama maps, keeps only num_ctx from options, and says stream false out loud', () => {
    const plan = nativeChatPlan(
      turn({
        options: { num_ctx: 32_768, temperature: 9, num_gpu: 0 },
        max_tokens: 200,
        temperature: 0.3,
        top_p: 0.9,
        seed: 7,
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        stop: 'END',
        keep_alive: '10m',
        user: 'ignored',
        n: 1,
      }),
    );
    expect(plan).toEqual({
      stream: false,
      includeUsage: false,
      request: {
        model: 'qwen3.5:4b',
        messages: [{ role: 'user', content: 'hi' }],
        options: {
          num_ctx: 32_768,
          num_predict: 200,
          temperature: 0.3,
          top_p: 0.9,
          seed: 7,
          frequency_penalty: 0.1,
          presence_penalty: 0.2,
          stop: ['END'],
        },
        stream: false,
        keep_alive: '10m',
      },
    });
    expect(nativeChatPlan(turn({ stop: ['a', 3, 'b'] }))?.request.options).toMatchObject({ stop: ['a', 'b'] });
    expect(nativeChatPlan(turn({ stream: true, stream_options: { include_usage: true } }))).toMatchObject({ stream: true, includeUsage: true });
  });

  it('maps reasoning effort to think as Ollama does, and leaves a value it refuses to /v1', () => {
    expect(nativeChatPlan(turn({ reasoning_effort: 'high' }))?.request.think).toBe('high');
    expect(nativeChatPlan(turn({ reasoning_effort: 'none' }))?.request.think).toBe(false);
    expect(nativeChatPlan(turn({ reasoning_effort: 'minimal' }))?.request.think).toBe('low');
    expect(nativeChatPlan(turn({ reasoning: { effort: 'ultra' } }))?.request.think).toBe('max');
    expect(nativeChatPlan(turn({ reasoning_effort: '' }))?.request).not.toHaveProperty('think');
    expect(nativeChatPlan(turn({ reasoning_effort: 'extreme' }))).toBeNull();
  });

  it('maps response_format, tools and logprobs', () => {
    const tools = [{ type: 'function', function: { name: 'get_time', description: 'now', parameters: { type: 'object', properties: {} } } }];
    const plan = nativeChatPlan(turn({ response_format: { type: 'json_object' }, tools, logprobs: true, top_logprobs: 2 }));
    expect(plan?.request).toMatchObject({ format: 'json', tools, logprobs: true, top_logprobs: 2 });
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(nativeChatPlan(turn({ response_format: { type: 'json_schema', json_schema: { name: 'x', schema } } }))?.request.format).toEqual(schema);
    expect(nativeChatPlan(turn({ response_format: { type: 'text' } }))?.request).not.toHaveProperty('format');
  });

  it('turns tool calls and their results into the native shape, naming the tool from its call id', () => {
    const plan = nativeChatPlan(
      turn({
        messages: [
          { role: 'user', content: 'time?' },
          {
            role: 'assistant',
            content: null,
            reasoning: 'I should call it',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '10:00' },
        ],
      }),
    );
    expect(plan?.request.messages).toEqual([
      { role: 'user', content: 'time?' },
      {
        role: 'assistant',
        content: '',
        thinking: 'I should call it',
        tool_calls: [{ id: 'call_1', function: { name: 'get_time', arguments: { tz: 'UTC' } } }],
      },
      { role: 'tool', content: '10:00', tool_name: 'get_time', tool_call_id: 'call_1' },
    ]);
  });

  it('splits content parts as Ollama does, images as their own messages, and merges a tool result', () => {
    const plan = nativeChatPlan(
      turn({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
            ],
          },
          {
            role: 'tool',
            name: 'lookup',
            content: [
              { type: 'text', text: 'a ' },
              { type: 'text', text: 'b' },
            ],
          },
        ],
      }),
    );
    expect(plan?.request.messages).toEqual([
      { role: 'user', content: 'What is this?' },
      { role: 'user', content: '', images: [PNG] },
      { role: 'tool', content: 'a b', tool_name: 'lookup' },
    ]);
  });

  it('leaves to /v1 what Ollama refuses there, so the caller gets its answer unchanged', () => {
    const image = (url: string) => turn({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] });
    expect(nativeChatPlan(image('https://example.com/cat.png'))).toBeNull();
    expect(nativeChatPlan(image('data:image/gif;base64,R0lGOD=='))).toBeNull();
    expect(nativeChatPlan(image('data:image/png;base64,not base64'))).toBeNull();
    const call = (args: string) =>
      turn({ messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'f', arguments: args } }] }] });
    expect(nativeChatPlan(call('{not json'))).toBeNull();
    expect(nativeChatPlan(call('[1,2]'))).toBeNull();
    expect(nativeChatPlan(turn({ messages: [{ role: 'user', content: [{ type: 'file', file: {} }] }] }))).toBeNull();
    expect(nativeChatPlan(turn({ messages: [{ role: 'user', content: null }] }))).toBeNull();
    expect(nativeChatPlan(turn({ messages: [] }))).toBeNull();
    expect(nativeChatPlan(turn({ _debug_render_only: true }))).toBeNull();
    expect(nativeChatPlan(turn({ temperature: 'hot' }))).toBeNull();
    // `/v1` reads max_tokens and seed as integers and refuses a fraction.
    expect(nativeChatPlan(turn({ max_tokens: 100.5 }))).toBeNull();
    expect(nativeChatPlan(turn({ seed: 1.5 }))).toBeNull();
  });

  it('works a body out once, however many times its window is asked for', () => {
    const body = turn();
    expect(nativeChatPlan(body)).toBe(nativeChatPlan(body));
    expect(nativeChatWindow(body)).toBe(65_536);
  });
});

describe('nativeChatPlanAt', () => {
  it('maps a request that names no window at the window given but refuses one that names its own', () => {
    const untitled = { model: 'm', messages: [{ role: 'user', content: 'Title this' }], max_tokens: 10 };
    expect(nativeChatPlanAt(untitled, 65_536)?.request).toMatchObject({ options: { num_ctx: 65_536, num_predict: 10 }, stream: false });
    expect(nativeChatPlanAt(turn(), 65_536)).toBeNull();
    expect(nativeChatPlanAt(untitled, 0)).toBeNull();
    expect(nativeChatPlanAt({ ...untitled, messages: [{ role: 'user', content: null }] }, 65_536)).toBeNull();
  });
});

describe('openAiChatResponse', () => {
  it('streams text as OpenAI chunks, role first, then a finish chunk, usage when asked and [DONE]', async () => {
    const plan = nativeChatPlan(turn({ stream: true, stream_options: { include_usage: true } }));
    const upstream = ndjson([
      { model: 'qwen3.5:4b', created_at: at, message: { role: 'assistant', content: 'Hel' }, done: false },
      { model: 'qwen3.5:4b', created_at: at, message: { role: 'assistant', content: 'lo' }, done: false },
      {
        model: 'qwen3.5:4b',
        created_at: at,
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 10,
        prompt_eval_duration: 2_000_000_000,
        eval_count: 4,
        eval_duration: 1_000_000_000,
      },
    ]);

    const response = await openAiChatResponse(upstream, plan as NonNullable<typeof plan>);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const out = events(await response.text()) as Array<Record<string, any>>;

    const created = Math.floor(Date.parse(at) / 1000);
    expect(out[0]).toMatchObject({
      object: 'chat.completion.chunk',
      created,
      model: 'qwen3.5:4b',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }],
    });
    expect(out[1]?.choices[0].delta).toEqual({ content: 'lo' });
    // The metrics-only trailer adds no empty content chunk.
    expect(out[2]?.choices).toEqual([{ index: 0, delta: {}, finish_reason: 'stop' }]);
    expect(out[3]).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      timings: { prompt_n: 10, prompt_ms: 2000, prompt_per_second: 5, predicted_n: 4, predicted_ms: 1000, predicted_per_second: 4 },
    });
    expect(out[4]).toBe('[DONE]');
    expect(new Set(out.slice(0, 4).map((chunk) => (chunk as { id: string }).id)).size).toBe(1);
  });

  it('splits thinking from the answer, and finishes a tool call with tool_calls', async () => {
    const plan = nativeChatPlan(turn({ stream: true, tools: [{ type: 'function', function: { name: 'get_time' } }] }));
    const upstream = ndjson([
      {
        model: 'm',
        created_at: at,
        message: {
          role: 'assistant',
          content: '',
          thinking: 'need the time',
          tool_calls: [{ id: 'call_x', function: { index: 0, name: 'get_time', arguments: { tz: 'UTC' } } }],
        },
        done: false,
      },
      { model: 'm', created_at: at, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
    ]);

    const out = events(await (await openAiChatResponse(upstream, plan as NonNullable<typeof plan>)).text()) as Array<Record<string, any>>;

    expect(out[0]?.choices[0].delta).toEqual({ role: 'assistant', reasoning: 'need the time' });
    expect(out[1]?.choices[0].delta).toEqual({
      content: '',
      tool_calls: [{ id: 'call_x', index: 0, type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } }],
    });
    expect(out[2]?.choices[0].finish_reason).toBe('tool_calls');
    expect(out[3]).toBe('[DONE]');
    expect(out).toHaveLength(4);
  });

  it('answers a non-streamed request with one chat.completion', async () => {
    const plan = nativeChatPlan(turn());
    const upstream = ndjson(
      [
        {
          model: 'm',
          created_at: at,
          message: { role: 'assistant', content: '', tool_calls: [{ function: { index: 0, name: 'get_time', arguments: {} } }] },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 3,
          prompt_eval_cached_count: 2,
          eval_count: 5,
        },
      ],
      5,
    );

    const response = await openAiChatResponse(upstream, plan as NonNullable<typeof plan>);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as Record<string, any>;

    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'm',
      system_fingerprint: 'fp_ollama',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '' } }],
      usage: { prompt_tokens: 3, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens: 5, total_tokens: 8 },
    });
    // Ollama gives every call an id; one without is given one, as OpenAI clients pair results by it.
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      id: expect.stringMatching(/^call_/),
      type: 'function',
      function: { name: 'get_time', arguments: '{}' },
    });
  });

  it("turns Ollama's error body into OpenAI's, with the same status", async () => {
    const plan = nativeChatPlan(turn({ stream: true }));
    const missing = await openAiChatResponse(
      ndjson([{ error: 'model "nope" not found, try pulling it first' }], 64, 404),
      plan as NonNullable<typeof plan>,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/json');
    expect(await missing.json()).toEqual({
      error: { message: 'model "nope" not found, try pulling it first', type: 'not_found_error', param: null, code: null },
    });

    const refused = await openAiChatResponse(ndjson([{ error: '"gemma3:1b" does not support thinking' }], 64, 400), plan as NonNullable<typeof plan>);
    expect(await refused.json()).toMatchObject({ error: { message: '"gemma3:1b" does not support thinking', type: 'invalid_request_error' } });

    const plain = await openAiChatResponse(new Response('upstream broke', { status: 500 }), plan as NonNullable<typeof plan>);
    expect(await plain.json()).toMatchObject({ error: { message: 'upstream broke', type: 'api_error' } });

    const empty = await openAiChatResponse(new Response('', { status: 502, statusText: 'Bad Gateway' }), plan as NonNullable<typeof plan>);
    expect(await empty.json()).toMatchObject({ error: { message: 'Bad Gateway', type: 'api_error' } });
  });

  it('answers a whole answer that is not JSON with a 502, not an error body under a 200', async () => {
    const plan = nativeChatPlan(turn());
    const response = await openAiChatResponse(new Response('<html>proxy</html>', { status: 200 }), plan as NonNullable<typeof plan>);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { message: 'Ollama sent a chat answer that is not JSON', type: 'api_error' } });
  });

  it('ends a stream that fails partway with an error event instead of an empty chunk', async () => {
    const plan = nativeChatPlan(turn({ stream: true }));
    const upstream = ndjson([
      { model: 'm', created_at: at, message: { role: 'assistant', content: 'par' }, done: false },
      { error: 'runner process has terminated' },
    ]);

    const out = events(await (await openAiChatResponse(upstream, plan as NonNullable<typeof plan>)).text()) as Array<Record<string, any>>;

    expect(out[0]?.choices[0].delta.content).toBe('par');
    expect(out[1]).toEqual({ error: { message: 'runner process has terminated', type: 'api_error', param: null, code: null } });
    expect(out).toHaveLength(2);
  });

  it('hands each chunk on as it arrives and stops reading Ollama when the caller cancels', async () => {
    const plan = nativeChatPlan(turn({ stream: true }));
    let cancelled = false;
    let push: (line: unknown) => void = () => undefined;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          push = (line) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
    const reader = ((await openAiChatResponse(upstream, plan as NonNullable<typeof plan>)).body as ReadableStream<Uint8Array>).getReader();

    push({ model: 'm', created_at: at, message: { role: 'assistant', content: 'one' }, done: false });
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"content":"one"');

    await reader.cancel();
    expect(cancelled).toBe(true);
  });
});
