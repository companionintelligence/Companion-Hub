import { describe, expect, it } from 'vitest';
import {
  extractEngineTimingsFromParsedJson,
  extractUsageFromParsedJson,
  injectUsageOptIn,
  tapResponseUsageWhileStreaming,
} from '../response-usage-tap';

describe('extractUsageFromParsedJson', () => {
  it('reads an OpenAI-style usage object', () => {
    expect(extractUsageFromParsedJson({ usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } })).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
    });
  });

  it('sums prompt and completion when a usage object omits total_tokens', () => {
    expect(extractUsageFromParsedJson({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('ignores an empty usage object rather than reporting all-null usage', () => {
    expect(extractUsageFromParsedJson({ usage: {} })).toBeNull();
  });

  it('reads Ollama-native done:true trailer with eval_count / prompt_eval_count', () => {
    expect(extractUsageFromParsedJson({ done: true, eval_count: 42, prompt_eval_count: 88, model: 'llama3.2:3b' })).toEqual({
      promptTokens: 88,
      completionTokens: 42,
      totalTokens: 130,
    });
  });

  it('does not fire on an Ollama intermediate token line (done: false)', () => {
    expect(extractUsageFromParsedJson({ done: false, response: 'the' })).toBeNull();
  });

  it('does not fire on a done:true line with neither count (e.g. an error trailer)', () => {
    expect(extractUsageFromParsedJson({ done: true, error: 'model not found' })).toBeNull();
  });

  it('returns null for non-objects and null input', () => {
    expect(extractUsageFromParsedJson(null)).toBeNull();
    expect(extractUsageFromParsedJson('hello')).toBeNull();
    expect(extractUsageFromParsedJson(42)).toBeNull();
  });
});

describe('injectUsageOptIn', () => {
  it('adds stream_options.include_usage to a streamed request', () => {
    expect(injectUsageOptIn({ model: 'x', stream: true })).toEqual({ model: 'x', stream: true, stream_options: { include_usage: true } });
  });

  it('merges under an existing stream_options rather than replacing it', () => {
    expect(injectUsageOptIn({ stream: true, stream_options: { keep: 'me' } })).toEqual({
      stream: true,
      stream_options: { keep: 'me', include_usage: true },
    });
  });

  it('leaves a non-streamed request untouched', () => {
    const body = { model: 'x', stream: false };
    expect(injectUsageOptIn(body)).toBe(body);
  });

  it('leaves a request with no stream field untouched (Ollama-native calls default to non-streamed differently, but this proxy never guesses)', () => {
    const body = { model: 'x' };
    expect(injectUsageOptIn(body)).toBe(body);
  });

  it('leaves non-object bodies untouched', () => {
    expect(injectUsageOptIn(null)).toBeNull();
    expect(injectUsageOptIn('raw')).toBe('raw');
    expect(injectUsageOptIn([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

/** Builds a ReadableStream from a list of strings, one chunk per string, UTF-8 encoded. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text;
}

describe('tapResponseUsageWhileStreaming', () => {
  it('passes every byte through unchanged when no usage frame is ever seen', async () => {
    const source = streamOf(['{"done":false,"response":"a"}\n', '{"done":false,"response":"b"}\n']);
    const usages: unknown[] = [];
    const tapped = tapResponseUsageWhileStreaming(source, (u) => usages.push(u));

    const text = await drain(tapped);

    expect(text).toBe('{"done":false,"response":"a"}\n{"done":false,"response":"b"}\n');
    expect(usages).toEqual([]);
  });

  it('finds an Ollama NDJSON trailer split across chunk boundaries, and still passes bytes through unchanged', async () => {
    const line = '{"done":true,"eval_count":42,"prompt_eval_count":88}\n';
    // Split mid-line, the way a real TCP chunk boundary would.
    const splitAt = 20;
    const source = streamOf(['{"done":false}\n', line.slice(0, splitAt), line.slice(splitAt)]);
    const usages: unknown[] = [];
    const tapped = tapResponseUsageWhileStreaming(source, (u) => usages.push(u));

    const text = await drain(tapped);

    expect(text).toBe(`{"done":false}\n${line}`);
    expect(usages).toEqual([{ promptTokens: 88, completionTokens: 42, totalTokens: 130 }]);
  });

  it('finds usage on the final SSE data frame and ignores [DONE]', async () => {
    const source = streamOf([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const usages: unknown[] = [];
    const tapped = tapResponseUsageWhileStreaming(source, (u) => usages.push(u));

    await drain(tapped);

    expect(usages).toEqual([{ promptTokens: 5, completionTokens: 2, totalTokens: 7 }]);
  });

  it('falls back to parsing the whole body for a non-streamed response with no internal newlines', async () => {
    const source = streamOf(['{"choices":[{"message":{"content":"hi"}}],', '"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}']);
    const usages: unknown[] = [];
    const tapped = tapResponseUsageWhileStreaming(source, (u) => usages.push(u));

    const text = await drain(tapped);

    expect(text).toBe('{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}');
    expect(usages).toEqual([{ promptTokens: 3, completionTokens: 1, totalTokens: 4 }]);
  });

  it('never throws out of the stream on malformed JSON, and still delivers the bytes', async () => {
    const source = streamOf(['not json at all\n', '{"done":true,"eval_count":1,"prompt_eval_count":1}\n']);
    const usages: unknown[] = [];
    const tapped = tapResponseUsageWhileStreaming(source, (u) => usages.push(u));

    const text = await drain(tapped);

    expect(text).toBe('not json at all\n{"done":true,"eval_count":1,"prompt_eval_count":1}\n');
    expect(usages).toEqual([{ promptTokens: 1, completionTokens: 1, totalTokens: 2 }]);
  });

  it('fires onUsage at most once even if a later line also looks like usage', async () => {
    const source = streamOf(['{"done":true,"eval_count":1,"prompt_eval_count":1}\n', '{"done":true,"eval_count":99,"prompt_eval_count":99}\n']);
    const usages: unknown[] = [];
    const tapped = tapResponseUsageWhileStreaming(source, (u) => usages.push(u));

    await drain(tapped);

    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
  });
});

describe('extractEngineTimingsFromParsedJson', () => {
  it("reads Ollama's native trailer, converting its nanoseconds", () => {
    expect(
      extractEngineTimingsFromParsedJson({
        done: true,
        prompt_eval_count: 46_000,
        prompt_eval_duration: 371_000_000_000,
        eval_count: 512,
        eval_duration: 46_500_000_000,
        load_duration: 12_000_000_000,
      }),
    ).toEqual({ promptTokens: 46_000, promptMs: 371_000, completionTokens: 512, decodeMs: 46_500 });
  });

  it("reads llama.cpp's `timings` object, already in milliseconds", () => {
    expect(
      extractEngineTimingsFromParsedJson({
        choices: [{ finish_reason: 'stop', delta: {} }],
        timings: { prompt_n: 9_800, prompt_ms: 20_110.4, predicted_n: 300, predicted_ms: 9_870.2, prompt_per_second: 487.3 },
      }),
    ).toEqual({ promptTokens: 9_800, promptMs: 20_110.4, completionTokens: 300, decodeMs: 9_870.2 });
  });

  it('finds nothing on an OpenAI-compatible usage frame, which carries counts but no times', () => {
    expect(extractEngineTimingsFromParsedJson({ usage: { prompt_tokens: 46_000, completion_tokens: 512 } })).toBeNull();
    expect(extractEngineTimingsFromParsedJson({ done: false, response: 'x' })).toBeNull();
    expect(extractEngineTimingsFromParsedJson({ timings: 'soon' })).toBeNull();
    expect(extractEngineTimingsFromParsedJson(null)).toBeNull();
  });
});

describe('tapResponseUsageWhileStreaming observer', () => {
  it('reports the first chunk, the engine timings and completion, once each, without touching the bytes', async () => {
    const frames = [
      '{"done":false,"message":{"content":"a"}}\n',
      '{"done":false}\n',
      '{"done":true,"prompt_eval_count":8,"prompt_eval_duration":2000000,"eval_count":2,"eval_duration":1000000}\n',
    ];
    const events: string[] = [];
    const usages: unknown[] = [];
    const tapped = tapResponseUsageWhileStreaming(streamOf(frames), (usage) => usages.push(usage), {
      onFirstChunk: () => events.push('first'),
      onEngineTimings: (timings) => events.push(`timings ${timings.promptMs}/${timings.decodeMs}`),
      onComplete: () => events.push('complete'),
    });

    const text = await drain(tapped);

    expect(text).toBe(frames.join(''));
    expect(events).toEqual(['first', 'timings 2/1', 'complete']);
    expect(usages).toEqual([{ promptTokens: 8, completionTokens: 2, totalTokens: 10 }]);
  });

  it('keeps looking for timings after usage when they arrive on a later frame', async () => {
    const source = streamOf([
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      'data: {"choices":[],"timings":{"prompt_n":5,"prompt_ms":40,"predicted_n":2,"predicted_ms":10}}',
    ]);
    const timings: unknown[] = [];

    await drain(tapResponseUsageWhileStreaming(source, () => undefined, { onEngineTimings: (t) => timings.push(t) }));

    // The second frame has no trailing newline: timings on an unterminated last line still arrive.
    expect(timings).toEqual([{ promptTokens: 5, promptMs: 40, completionTokens: 2, decodeMs: 10 }]);
  });

  it('never lets an observer that throws reach the stream', async () => {
    const frames = ['{"done":false}\n', '{"done":true,"eval_count":1,"prompt_eval_count":1}\n'];
    const tapped = tapResponseUsageWhileStreaming(streamOf(frames), () => undefined, {
      onFirstChunk: () => {
        throw new Error('observer bug');
      },
      onComplete: () => {
        throw new Error('observer bug');
      },
    });

    await expect(drain(tapped)).resolves.toBe(frames.join(''));
  });
});
