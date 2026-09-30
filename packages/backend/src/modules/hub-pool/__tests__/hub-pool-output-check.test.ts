/**
 * The judge that tells a finished, meaningful 200 from one that was cut off or was only placeholder
 * tokens — the check the pool lacked on 2026-09-29, when core-2's Ollama answered 167 of 237 local
 * gemma4 turns with `<unused49>` and no closing frame while every row read `served`.
 *
 * The frames below are the dialects' own shapes: Ollama's NDJSON with its closing `done: true` line,
 * and OpenAI-compatible SSE with `finish_reason` and `data: [DONE]`.
 */

import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import {
  DEGENERATE_SCAN_CHARS,
  OutputJudge,
  PoolOutputQuarantine,
  applyOutputQuarantine,
  isDegenerateText,
  isStreamedContentType,
  judgeWholeBody,
  outputDialectOf,
  type OutputDialect,
} from '../hub-pool-output-check';
import type { PoolCandidate } from '../hub-pool.types';

const MODEL = 'gemma4:e4b';

function ollamaFrame(content: string, done = false, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ model: MODEL, created_at: '2026-09-29T10:00:00Z', message: { role: 'assistant', content }, done, ...extra })}\n`;
}

const OLLAMA_DONE = ollamaFrame('', true, { done_reason: 'stop', prompt_eval_count: 12, eval_count: 3 });

function sseFrame(content: string | null, finishReason: string | null = null): string {
  const delta = content === null ? {} : { content };
  return `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

/** Runs `chunks` through a judge the way a relay does, and returns what it decided. */
async function judge(dialect: OutputDialect, streaming: boolean, chunks: string[]) {
  const judgeInstance = new OutputJudge(dialect, streaming);
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const passed: string[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of judgeInstance.tap(source)) passed.push(decoder.decode(chunk, { stream: true }));
  return { verdict: judgeInstance.verdict(), passed: passed.join('') };
}

describe('outputDialectOf', () => {
  it('judges the four completion routes, and nothing else', () => {
    expect(outputDialectOf('/api/chat')).toBe('ollama-native');
    expect(outputDialectOf('/api/generate')).toBe('ollama-native');
    expect(outputDialectOf('/v1/chat/completions')).toBe('openai');
    expect(outputDialectOf('/v1/completions')).toBe('openai');
    expect(outputDialectOf('/v1/embeddings')).toBeNull();
    expect(outputDialectOf('/api/embed')).toBeNull();
    expect(outputDialectOf('/api/show')).toBeNull();
  });
});

describe('isStreamedContentType', () => {
  it('reads NDJSON and SSE as a stream, with or without parameters, and a JSON body as none', () => {
    expect(isStreamedContentType('application/x-ndjson')).toBe(true);
    expect(isStreamedContentType('text/event-stream; charset=utf-8')).toBe(true);
    expect(isStreamedContentType('Text/Event-Stream')).toBe(true);
    expect(isStreamedContentType('application/json; charset=utf-8')).toBe(false);
    expect(isStreamedContentType('application/x-ndjsonish')).toBe(false);
    expect(isStreamedContentType(null)).toBe(false);
  });
});

describe('isDegenerateText', () => {
  it('matches a run of reserved placeholder tokens and nothing else', () => {
    expect(isDegenerateText('<unused49><unused49><unused49>')).toBe(true);
    expect(isDegenerateText('  <unused49>\n<unused12> ')).toBe(true);
  });

  it('still matches when the scan cuts the last placeholder in half', () => {
    const run = '<unused49>'.repeat(40);
    expect(run.length).toBeGreaterThan(DEGENERATE_SCAN_CHARS);
    expect(DEGENERATE_SCAN_CHARS % '<unused49>'.length).not.toBe(0);
    expect(isDegenerateText(run)).toBe(true);
  });

  it('leaves a real answer alone, even one that mentions a placeholder, and an empty one', () => {
    expect(isDegenerateText('Hello there')).toBe(false);
    expect(isDegenerateText('The token <unused49> is reserved in Gemma')).toBe(false);
    expect(isDegenerateText('<unused49> and then words')).toBe(false);
    // A turn that only calls tools generates no text at all: nothing to judge, not garbage.
    expect(isDegenerateText('')).toBe(false);
    expect(isDegenerateText('<unused>')).toBe(false);
  });

  it('decides on the head of the answer, so placeholders after a real start do not count', () => {
    expect(isDegenerateText(`${'a'.repeat(DEGENERATE_SCAN_CHARS)}<unused49>`)).toBe(false);
  });
});

describe('judgeWholeBody (a non-streamed completion)', () => {
  it('reads Ollama done:false as cut off and done:true as complete', () => {
    expect(judgeWholeBody('ollama-native', ollamaFrame('partial', false))).toEqual({ fault: 'truncated-upstream', complete: false });
    expect(judgeWholeBody('ollama-native', ollamaFrame('Hello', true))).toEqual({ fault: null, complete: true });
  });

  it('reads an OpenAI body without a finish_reason as cut off', () => {
    const body = (finishReason: string | null) =>
      JSON.stringify({
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: finishReason }],
      });
    expect(judgeWholeBody('openai', body(null))).toEqual({ fault: 'truncated-upstream', complete: false });
    expect(judgeWholeBody('openai', body('stop'))).toEqual({ fault: null, complete: true });
    expect(judgeWholeBody('openai', body('length'))).toEqual({ fault: null, complete: true });
    // The legacy completions shape.
    expect(judgeWholeBody('openai', JSON.stringify({ choices: [{ text: 'Hi', finish_reason: 'stop' }] }))).toEqual({ fault: null, complete: true });
  });

  it('names placeholder-only content degenerate, finished or not', () => {
    expect(judgeWholeBody('ollama-native', ollamaFrame('<unused49>'.repeat(30), true))).toEqual({ fault: 'degenerate-output', complete: false });
    expect(judgeWholeBody('ollama-native', ollamaFrame('<unused49>'.repeat(30), false))).toEqual({ fault: 'degenerate-output', complete: false });
    const openai = JSON.stringify({ choices: [{ message: { content: '<unused49><unused49>' }, finish_reason: 'stop' }] });
    expect(judgeWholeBody('openai', openai)).toEqual({ fault: 'degenerate-output', complete: false });
  });

  it('does not judge a body that is not the dialect at all', () => {
    expect(judgeWholeBody('ollama-native', JSON.stringify({ ok: true }))).toEqual({ fault: null, complete: false });
    expect(judgeWholeBody('openai', JSON.stringify({ ok: true }))).toEqual({ fault: null, complete: false });
    expect(judgeWholeBody('openai', 'not json')).toEqual({ fault: null, complete: false });
  });
});

describe('OutputJudge on a stream', () => {
  it('passes every byte through unchanged', async () => {
    const chunks = [ollamaFrame('Hel'), ollamaFrame('lo'), OLLAMA_DONE];
    const { passed } = await judge('ollama-native', true, chunks);
    expect(passed).toBe(chunks.join(''));
  });

  it('reads an Ollama stream that ends on done:true as complete — with or without eval counts', async () => {
    expect((await judge('ollama-native', true, [ollamaFrame('Hel'), ollamaFrame('lo'), OLLAMA_DONE])).verdict).toEqual({
      fault: null,
      complete: true,
    });
    expect((await judge('ollama-native', true, [ollamaFrame('Hello'), ollamaFrame('', true)])).verdict).toEqual({ fault: null, complete: true });
  });

  it('reads an Ollama stream that ends without done:true as cut off — the core-2 stream', async () => {
    expect((await judge('ollama-native', true, [ollamaFrame('Hel'), ollamaFrame('lo')])).verdict).toEqual({
      fault: 'truncated-upstream',
      complete: false,
    });
    // An error line in place of the closing frame is no better.
    expect((await judge('ollama-native', true, [ollamaFrame('Hel'), `${JSON.stringify({ error: 'runner crashed' })}\n`])).verdict?.fault).toBe(
      'truncated-upstream',
    );
    // Nor is a last line cut mid-JSON.
    expect((await judge('ollama-native', true, [ollamaFrame('Hel'), '{"model":"gemma4:e4b","message":{"con'])).verdict?.fault).toBe(
      'truncated-upstream',
    );
  });

  it('finds the closing frame split across chunks and without a trailing newline', async () => {
    const whole = OLLAMA_DONE.trimEnd();
    const { verdict } = await judge('ollama-native', true, [ollamaFrame('Hi'), whole.slice(0, 20), whole.slice(20)]);
    expect(verdict).toEqual({ fault: null, complete: true });
  });

  it('names a stream of <unused49> tokens degenerate, across frames', async () => {
    const frames = Array.from({ length: 40 }, () => ollamaFrame('<unused49>'));
    expect((await judge('ollama-native', true, frames)).verdict).toEqual({ fault: 'degenerate-output', complete: false });
    expect((await judge('ollama-native', true, [...frames, OLLAMA_DONE])).verdict).toEqual({ fault: 'degenerate-output', complete: false });
  });

  it('leaves a healthy OpenAI stream alone, with a usage frame or without one', async () => {
    const withoutUsage = [sseFrame('Hel'), sseFrame('lo'), sseFrame(null, 'stop'), 'data: [DONE]\n\n'];
    expect((await judge('openai', true, withoutUsage)).verdict).toEqual({ fault: null, complete: true });
    const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`;
    expect((await judge('openai', true, [sseFrame('Hi'), sseFrame(null, 'stop'), usage, 'data: [DONE]\n\n'])).verdict).toEqual({
      fault: null,
      complete: true,
    });
  });

  it('takes either [DONE] or a set finish_reason as the end of an OpenAI stream, and neither as cut off', async () => {
    expect((await judge('openai', true, [sseFrame('Hi'), 'data: [DONE]\n\n'])).verdict).toEqual({ fault: null, complete: true });
    expect((await judge('openai', true, [sseFrame('Hi'), sseFrame(null, 'stop')])).verdict).toEqual({ fault: null, complete: true });
    expect((await judge('openai', true, [sseFrame('Hel'), sseFrame('lo')])).verdict).toEqual({ fault: 'truncated-upstream', complete: false });
  });

  it('reads an error frame as the answer cut off, even when [DONE] follows it — how vLLM ends a failed generation', async () => {
    const errorFrame = `data: ${JSON.stringify({ error: { object: 'error', message: 'engine died', type: 'InternalServerError', code: 500 } })}\n\n`;
    expect((await judge('openai', true, [sseFrame('Hel'), errorFrame, 'data: [DONE]\n\n'])).verdict).toEqual({
      fault: 'truncated-upstream',
      complete: false,
    });
    // Content that merely talks about an error is generated text, not an error frame.
    expect((await judge('openai', true, [sseFrame('{"error": "is a JSON key"}'), 'data: [DONE]\n\n'])).verdict).toEqual({
      fault: null,
      complete: true,
    });
  });

  it('is not fooled by finish_reason inside the generated text', async () => {
    const quoted = sseFrame('the field is "finish_reason": "stop"');
    expect((await judge('openai', true, [quoted])).verdict).toEqual({ fault: 'truncated-upstream', complete: false });
  });

  it('judges an engine that ignored stream:true and sent one body', async () => {
    const body = JSON.stringify({ choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }] });
    expect((await judge('openai', true, [body])).verdict).toEqual({ fault: null, complete: true });
  });

  it('judges nothing it cannot recognise, rather than failing it', async () => {
    expect((await judge('ollama-native', true, ['plain text\n'])).verdict).toEqual({ fault: null, complete: false });
    expect((await judge('openai', true, [': ping\n\n'])).verdict).toEqual({ fault: null, complete: false });
  });

  it('judges a non-streamed body whole', async () => {
    const body = ollamaFrame('partial', false).trimEnd();
    expect((await judge('ollama-native', false, [body.slice(0, 10), body.slice(10)])).verdict).toEqual({
      fault: 'truncated-upstream',
      complete: false,
    });
  });

  it('has no verdict for a stream that never ended', () => {
    expect(new OutputJudge('ollama-native', true).verdict()).toBeNull();
  });
});

describe('applyOutputQuarantine', () => {
  const local: PoolCandidate = { peerId: null, nodeFqdn: null, backend: 'ollama' };
  const a: PoolCandidate = { peerId: 'a', nodeFqdn: 'a.tailxyz.ts.net', backend: 'ollama' };
  const b: PoolCandidate = { peerId: 'b', nodeFqdn: 'b.tailxyz.ts.net', backend: 'vllm' };

  it('moves withheld engines behind every healthy one, each group in its order', () => {
    const { candidates, withheld } = applyOutputQuarantine([local, a, b], (candidate) => candidate === local);
    expect(candidates).toEqual([a, b, local]);
    expect(withheld).toEqual([local]);
  });

  it('moves nothing when nothing, or everything, is withheld', () => {
    const ordered = [local, a];
    expect(applyOutputQuarantine(ordered, () => false).candidates).toBe(ordered);
    expect(applyOutputQuarantine(ordered, () => true)).toEqual({ candidates: ordered, withheld: [] });
  });
});

describe('PoolOutputQuarantine', () => {
  const target = { nodeKey: 'local', backend: 'ollama' as const, model: MODEL };

  it('withholds an engine after two faults inside the window, and for that engine and model only', () => {
    let now = 1_000_000;
    const quarantine = new PoolOutputQuarantine(() => now);
    expect(quarantine.strike(target, 'degenerate-output').withheld).toBe(false);
    expect(quarantine.isWithheld(target)).toBe(false);
    now += 30_000;
    const decision = quarantine.strike(target, 'truncated-upstream');
    expect(decision).toMatchObject({ withheld: true, forMs: 60_000 });
    expect(quarantine.isWithheld(target)).toBe(true);
    // `:latest` folds as model ids do everywhere else in the pool.
    expect(quarantine.isWithheld({ ...target, model: `${MODEL}:latest` })).toBe(false);
    expect(quarantine.isWithheld({ ...target, backend: 'vllm' })).toBe(false);
    expect(quarantine.isWithheld({ ...target, nodeKey: 'peer-1' })).toBe(false);
  });

  it('restores the engine when the cooldown runs out, and re-withholds it on the next fault', () => {
    let now = 1_000_000;
    const quarantine = new PoolOutputQuarantine(() => now);
    quarantine.strike(target, 'degenerate-output');
    quarantine.strike(target, 'degenerate-output');
    now += 61_000;
    expect(quarantine.isWithheld(target)).toBe(false);
    // Its benefit of the doubt is spent: the re-probe is the test, and one more fault settles it.
    expect(quarantine.strike(target, 'degenerate-output')).toMatchObject({ withheld: true, forMs: 120_000 });
  });

  it('is cleared outright by one clean, complete answer', () => {
    const quarantine = new PoolOutputQuarantine();
    quarantine.strike(target, 'degenerate-output');
    quarantine.strike(target, 'degenerate-output');
    expect(quarantine.clear(target)).toBe(true);
    expect(quarantine.isWithheld(target)).toBe(false);
    expect(quarantine.isEmpty()).toBe(true);
    expect(quarantine.clear(target)).toBe(false);
  });
});
