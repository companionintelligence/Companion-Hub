import { describe, expect, it } from 'vitest';
import { extractUsageFromParsedJson, injectUsageOptIn, tapResponseUsageWhileStreaming } from '../response-usage-tap';

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
