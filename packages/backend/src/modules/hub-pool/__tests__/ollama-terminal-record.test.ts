import { describe, expect, it } from 'vitest';
import { foldOllamaTerminalRecords } from '../ollama-terminal-record';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function textOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

const records = (text: string) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const delta = (content: string) => `${JSON.stringify({ model: 'm', message: { role: 'assistant', content }, done: false })}\n`;

/*
 * Lemonade 2026.45.3 ends a streamed /api/chat with two `done: true` records. OpenClaw fails the
 * answer with `malformed_streaming_fragment` on anything after the first.
 */
describe('foldOllamaTerminalRecords', () => {
  const stopReason = `${JSON.stringify({ created_at: 't', done: true, done_reason: 'length', message: { content: '', role: 'assistant' }, model: 'm' })}\n`;
  const counts = `${JSON.stringify({
    created_at: 't',
    done: true,
    done_reason: 'stop',
    eval_count: 12,
    eval_duration: 5,
    message: { content: '', role: 'assistant' },
    model: 'm',
    prompt_eval_count: 40,
  })}\n`;

  it("folds Lemonade's two terminal records into one, keeping the first stop reason and the counts", async () => {
    const out = records(await textOf(foldOllamaTerminalRecords(streamOf(delta('Hel'), delta('lo'), stopReason, counts))));

    expect(out.filter((record) => record.done === true)).toHaveLength(1);
    expect(out.at(-1)).toMatchObject({ done: true, done_reason: 'length', eval_count: 12, prompt_eval_count: 40 });
    expect(out.slice(0, -1).map((record) => (record.message as { content: string }).content)).toEqual(['Hel', 'lo']);
  });

  it('leaves a stream that ends with one terminal record, as real Ollama does, byte for byte', async () => {
    const original = `${delta('OK')}${counts}`;
    expect(await textOf(foldOllamaTerminalRecords(streamOf(original)))).toBe(original);
  });

  it('folds when the records are split across chunks, mid-line and mid-character', async () => {
    const whole = `${delta('café 🚲')}${stopReason}${counts}`;
    const bytes = new TextEncoder().encode(whole);
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += 7) pieces.push(bytes.slice(at, at + 7));
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      },
    });

    const out = records(await textOf(foldOllamaTerminalRecords(source)));

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ message: { content: 'caf\u00e9 \ud83d\udeb2' } });
    expect(out[1]).toMatchObject({ done: true, done_reason: 'length', eval_count: 12 });
  });

  it('folds a final record that has no trailing newline', async () => {
    const out = records(await textOf(foldOllamaTerminalRecords(streamOf(delta('a'), stopReason, counts.trimEnd()))));
    expect(out.filter((record) => record.done === true)).toHaveLength(1);
    expect(out.at(-1)).toMatchObject({ done_reason: 'length', eval_count: 12 });
  });

  it('never drops output a terminal record carries', async () => {
    const withText = `${JSON.stringify({ done: true, done_reason: 'stop', message: { role: 'assistant', content: 'tail' }, model: 'm' })}\n`;
    const out = records(await textOf(foldOllamaTerminalRecords(streamOf(delta('a'), withText, counts))));

    expect(out.filter((record) => record.done === true)).toHaveLength(1);
    expect(out.map((record) => (record.message as { content: string }).content).join('')).toBe('atail');
    expect(out.at(-1)).toMatchObject({ done: true, eval_count: 12 });
  });

  it('folds /api/generate records the same way', async () => {
    const first = `${JSON.stringify({ model: 'm', response: '', done: true, done_reason: 'stop' })}\n`;
    const second = `${JSON.stringify({ model: 'm', response: '', done: true, done_reason: 'stop', eval_count: 3 })}\n`;
    const out = records(
      await textOf(foldOllamaTerminalRecords(streamOf(`${JSON.stringify({ model: 'm', response: 'hi', done: false })}\n`, first, second))),
    );

    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ done: true, eval_count: 3 });
  });

  it('relays lines that are not JSON, and a body with no newline at all, unchanged', async () => {
    const sse = 'data: {"choices":[]}\n\ndata: [DONE]\n\n';
    expect(await textOf(foldOllamaTerminalRecords(streamOf(sse)))).toBe(sse);
    const whole = JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'OK' }, done: true, eval_count: 2 });
    expect(await textOf(foldOllamaTerminalRecords(streamOf(whole)))).toBe(whole);
  });

  it('gives up on a line longer than a record can be and relays the rest untouched', async () => {
    const huge = 'x'.repeat(1024 * 1024 + 10);
    expect(await textOf(foldOllamaTerminalRecords(streamOf(huge, 'tail\n')))).toBe(`${huge}tail\n`);
  });
});
