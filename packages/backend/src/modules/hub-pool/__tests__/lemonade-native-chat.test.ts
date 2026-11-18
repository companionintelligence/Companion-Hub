import { describe, expect, it } from 'vitest';
import { type LemonadeChatPlan, lemonadeChatPlan, nativeChatResponseFromOpenAi } from '../lemonade-native-chat';

const MODEL = 'Qwen3.8-27B-GGUF';
const PNG = 'iVBORw0KGgo=';
const JPEG = '/9j/4AAQ';

/** The plan for a body this module translates; a test of the answer fails here if it doesn't. */
function planOf(body: Record<string, unknown>): LemonadeChatPlan {
  const plan = lemonadeChatPlan(body);
  if (!plan) throw new Error('expected a translated request');
  return plan;
}

function turn(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: MODEL, messages: [{ role: 'user', content: 'hi' }], ...extra };
}

/** Server-sent events as llama-server streams them, split across reads at arbitrary points. */
function sse(events: unknown[], splitAt = 7): globalThis.Response {
  const text = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += splitAt) controller.enqueue(bytes.slice(at, at + splitAt));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function records(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A chunk the way llama-server words one: the model is the GGUF's path, not the name asked for. */
function chunk(delta: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
  return { object: 'chat.completion.chunk', model: '/var/lib/lemonade/models/x.gguf', choices: [{ index: 0, delta, finish_reason: finish }] };
}

const USAGE_CHUNK = {
  object: 'chat.completion.chunk',
  choices: [],
  usage: { prompt_tokens: 13_912, completion_tokens: 3, total_tokens: 13_915, prompt_tokens_details: { cached_tokens: 13_908 } },
  timings: { prompt_n: 4, prompt_ms: 160.5, predicted_n: 3, predicted_ms: 40.25, cache_n: 13_908 },
};

describe('lemonadeChatPlan', () => {
  it('sends a native turn to /v1 with the stream on by default and usage asked for', () => {
    expect(lemonadeChatPlan(turn())).toEqual({
      model: MODEL,
      stream: true,
      request: { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } },
    });
    expect(lemonadeChatPlan(turn({ stream: false }))?.request).toEqual({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: false });
  });

  it('maps the options /v1 has a field for and leaves num_ctx, think and keep_alive out', () => {
    const plan = lemonadeChatPlan(
      turn({
        stream: false,
        think: false,
        keep_alive: '10m',
        options: {
          num_ctx: 65_536,
          num_predict: 200,
          temperature: 0.3,
          top_p: 0.9,
          top_k: 20,
          min_p: 0,
          seed: 7,
          repeat_penalty: 1.1,
          stop: 'END',
          num_gpu: 99,
        },
      }),
    );
    expect(plan?.request).toEqual({
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      max_tokens: 200,
      temperature: 0.3,
      top_p: 0.9,
      top_k: 20,
      min_p: 0,
      seed: 7,
      repeat_penalty: 1.1,
      stop: ['END'],
    });
  });

  it('treats a negative num_predict as no limit', () => {
    expect(lemonadeChatPlan(turn({ options: { num_predict: -1 } }))?.request.max_tokens).toBeUndefined();
    expect(lemonadeChatPlan(turn({ options: { num_predict: -2 } }))?.request.max_tokens).toBeUndefined();
  });

  it('maps format to response_format', () => {
    expect(lemonadeChatPlan(turn({ format: 'json' }))?.request.response_format).toEqual({ type: 'json_object' });
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(lemonadeChatPlan(turn({ format: schema }))?.request.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema },
    });
  });

  it('turns images into data URIs and thinking into reasoning_content', () => {
    const plan = lemonadeChatPlan(
      turn({
        messages: [
          { role: 'user', content: 'what is this?', images: [PNG, JPEG] },
          { role: 'assistant', content: 'a cat', thinking: 'looks furry' },
        ],
      }),
    );
    expect(plan?.request.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG}` } },
        ],
      },
      { role: 'assistant', content: 'a cat', reasoning_content: 'looks furry' },
    ]);
  });

  it('gives tool calls ids and matches each result to its call by position, as Ollama does', () => {
    // Hermes's native adapter sends neither a call id nor a result's tool_call_id.
    const plan = lemonadeChatPlan(
      turn({
        messages: [
          { role: 'user', content: 'weather in Paris and Rome?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'get_weather', arguments: { city: 'Paris' } } },
              { function: { name: 'get_weather', arguments: { city: 'Rome' } } },
            ],
          },
          { role: 'tool', content: 'sunny', tool_name: 'get_weather' },
          { role: 'tool', content: 'rain', tool_name: 'get_weather' },
        ],
      }),
    );
    expect(plan?.request.messages).toEqual([
      { role: 'user', content: 'weather in Paris and Rome?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_0', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } },
        ],
      },
      { role: 'tool', content: 'sunny', tool_call_id: 'call_0', name: 'get_weather' },
      { role: 'tool', content: 'rain', tool_call_id: 'call_1', name: 'get_weather' },
    ]);
  });

  it('keeps the ids a caller sent, and a result that names its call answers that one', () => {
    const plan = lemonadeChatPlan(
      turn({
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'a', function: { name: 'one', arguments: {} } },
              { id: 'b', function: { name: 'two', arguments: {} } },
            ],
          },
          { role: 'tool', content: '2', tool_call_id: 'b' },
          { role: 'tool', content: '1', tool_name: 'one' },
        ],
      }),
    );
    const messages = plan?.request.messages as Record<string, unknown>[];
    expect(messages[1]).toEqual({ role: 'tool', content: '2', tool_call_id: 'b' });
    expect(messages[2]).toEqual({ role: 'tool', content: '1', tool_call_id: 'a', name: 'one' });
  });

  it("leaves what it can't map exactly on Lemonade's /api/chat", () => {
    expect(lemonadeChatPlan(null)).toBeNull();
    expect(lemonadeChatPlan({ model: MODEL, messages: [] })).toBeNull();
    expect(lemonadeChatPlan(turn({ logprobs: true }))).toBeNull();
    expect(lemonadeChatPlan(turn({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))).toBeNull();
    expect(lemonadeChatPlan(turn({ messages: [{ role: 'user', content: 'hi', images: [42] }] }))).toBeNull();
    expect(
      lemonadeChatPlan(turn({ messages: [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'x', arguments: '{}' } }] }] })),
    ).toBeNull();
    expect(lemonadeChatPlan(turn({ options: { temperature: 'hot' } }))).toBeNull();
    expect(lemonadeChatPlan(turn({ options: { num_predict: 1.5 } }))).toBeNull();
    expect(lemonadeChatPlan(turn({ format: 'yaml' }))).toBeNull();
  });
});

describe('nativeChatResponseFromOpenAi', () => {
  it('reports the whole prompt, cached part included, on a whole answer', async () => {
    const plan = planOf(turn({ stream: false }));
    const upstream = new Response(
      JSON.stringify({
        object: 'chat.completion',
        model: MODEL,
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              reasoning_content: 'need the tool',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
            },
          },
        ],
        usage: USAGE_CHUNK.usage,
        timings: USAGE_CHUNK.timings,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

    const response = await nativeChatResponseFromOpenAi(upstream, plan);
    const record = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(record).toMatchObject({
      model: MODEL,
      done: true,
      done_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: '',
        thinking: 'need the tool',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
      },
      prompt_eval_count: 13_912,
      prompt_eval_cached_count: 13_908,
      eval_count: 3,
      prompt_eval_duration: 160_500_000,
      eval_duration: 40_250_000,
      total_duration: 200_750_000,
      load_duration: 0,
    });
    expect(Number.isFinite(Date.parse(record.created_at as string))).toBe(true);
  });

  it('streams content and thinking as they arrive and ends with exactly one done record', async () => {
    const plan = planOf(turn());
    const response = await nativeChatResponseFromOpenAi(
      sse([
        chunk({ role: 'assistant', content: null }),
        chunk({ reasoning_content: 'hm' }),
        chunk({ content: 'O' }),
        chunk({ content: 'K' }),
        chunk({}, 'stop'),
        USAGE_CHUNK,
        '[DONE]',
      ]),
      plan,
    );

    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    const lines = records(await response.text());
    expect(lines.map((line) => line.message)).toEqual([
      { role: 'assistant', content: '', thinking: 'hm' },
      { role: 'assistant', content: 'O' },
      { role: 'assistant', content: 'K' },
      { role: 'assistant', content: '' },
    ]);
    expect(lines.filter((line) => line.done === true)).toHaveLength(1);
    expect(lines.every((line) => line.model === MODEL)).toBe(true);
    expect(lines[3]).toMatchObject({ done: true, done_reason: 'stop', prompt_eval_count: 13_912, prompt_eval_cached_count: 13_908, eval_count: 3 });
  });

  it('assembles streamed tool-call fragments into whole calls on the record before the last', async () => {
    const plan = planOf(turn());
    const response = await nativeChatResponseFromOpenAi(
      sse([
        chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"city":"Par' } }] }),
        chunk({ tool_calls: [{ index: 1, id: 'c2', type: 'function', function: { name: 'get_time', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'is"}' } }] }),
        chunk({}, 'tool_calls'),
        USAGE_CHUNK,
        '[DONE]',
      ]),
      plan,
    );

    const lines = records(await response.text());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      done: false,
      message: {
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: { city: 'Paris' } } },
          { id: 'c2', type: 'function', function: { name: 'get_time', arguments: {} } },
        ],
      },
    });
    expect(lines[1]).toMatchObject({ done: true, done_reason: 'tool_calls', prompt_eval_count: 13_912 });
  });

  it('closes a stream that ends without [DONE] once the engine said why it stopped', async () => {
    const plan = planOf(turn());
    const response = await nativeChatResponseFromOpenAi(sse([chunk({ content: 'x' }), chunk({}, 'length'), USAGE_CHUNK]), plan);
    const lines = records(await response.text());
    expect(lines.at(-1)).toMatchObject({ done: true, done_reason: 'length', prompt_eval_count: 13_912 });
  });

  it('passes an error status through with the message in Ollama’s shape', async () => {
    const plan = planOf(turn());
    const upstream = new Response(JSON.stringify({ error: { message: 'model not loaded', type: 'not_found_error' } }), { status: 404 });
    const response = await nativeChatResponseFromOpenAi(upstream, plan);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'model not loaded' });
  });

  it('turns an error event mid-stream into an error record and stops', async () => {
    const plan = planOf(turn());
    const response = await nativeChatResponseFromOpenAi(
      sse([chunk({ content: 'x' }), { error: { message: 'context full' } }, chunk({ content: 'never' })]),
      plan,
    );
    const lines = records(await response.text());
    expect(lines).toEqual([expect.objectContaining({ message: { role: 'assistant', content: 'x' } }), { error: 'context full' }]);
  });

  it('answers 502 for a whole answer that is not JSON', async () => {
    const plan = planOf(turn({ stream: false }));
    const response = await nativeChatResponseFromOpenAi(new Response('<html>', { status: 200 }), plan);
    expect(response.status).toBe(502);
  });
});
