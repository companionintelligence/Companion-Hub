/**
 * An Ollama-native stream (`/api/chat`, `/api/generate`) ends with exactly one record marked
 * `done: true`, and clients hold engines to that. OpenClaw's reader, for one, fails the whole
 * answer with `malformed_streaming_fragment` when anything arrives after it.
 *
 * Lemonade's Ollama-compatible endpoint sends two (seen on 2026.45.3): first a record carrying
 * only the stop reason, then a second carrying the token counts and timings.
 *
 *   {"done":true,"done_reason":"length","message":{"content":"","role":"assistant"},...}
 *   {"done":true,"done_reason":"stop","eval_count":0,...,"message":{"content":"","role":"assistant"},...}
 *
 * Every streamed answer without tools therefore failed in OpenClaw behind a Lemonade-backed Hub:
 * compaction summaries and session titles, each retried to the token cap before giving up.
 *
 * This folds consecutive `done: true` records into one. Everything before the first is relayed
 * byte for byte. The folded record takes the later one's fields (the counts), except the stop
 * reason, where the first is the one that names why generation ended. A stream that already ends
 * with one record, which is every stream real Ollama sends, comes out unchanged.
 */

/** A line this long is not a streamed record; stop looking and relay the rest untouched. */
const MAX_RECORD_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
const DONE_TRUE = /"done"\s*:\s*true/;

type OllamaRecord = Record<string, unknown>;

function parseDoneRecord(line: Uint8Array, decoder: TextDecoder): OllamaRecord | null {
  const text = decoder.decode(line);
  if (!DONE_TRUE.test(text)) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && (parsed as OllamaRecord).done === true) {
      return parsed as OllamaRecord;
    }
  } catch {
    // Not a record; relayed as it came.
  }
  return null;
}

/** Whether a terminal record also carries text, reasoning or tool calls that must not be dropped. */
function carriesOutput(record: OllamaRecord): boolean {
  if (typeof record.response === 'string' && record.response !== '') return true;
  const message = record.message;
  if (typeof message !== 'object' || message === null) return false;
  const { content, thinking, reasoning, tool_calls: toolCalls } = message as Record<string, unknown>;
  return (
    (typeof content === 'string' && content !== '') ||
    (typeof thinking === 'string' && thinking !== '') ||
    (typeof reasoning === 'string' && reasoning !== '') ||
    (Array.isArray(toolCalls) && toolCalls.length > 0)
  );
}

function foldTerminalRecords(first: OllamaRecord, second: OllamaRecord): OllamaRecord {
  const folded: OllamaRecord = { ...first, ...second };
  if (typeof first.done_reason === 'string' && first.done_reason !== '') folded.done_reason = first.done_reason;
  return folded;
}

export function foldOllamaTerminalRecords(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending: Uint8Array = new Uint8Array(0);
  /** The terminal record seen so far, kept back until the next record or the end says it is the last. */
  let held: OllamaRecord | null = null;
  let heldBytes: Uint8Array | null = null;
  let passthrough = false;

  const emitRecord = (controller: TransformStreamDefaultController<Uint8Array>, record: OllamaRecord) => {
    controller.enqueue(encoder.encode(`${JSON.stringify(record)}\n`));
  };
  const releaseHeld = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (heldBytes) controller.enqueue(heldBytes);
    held = null;
    heldBytes = null;
  };

  const takeLine = (controller: TransformStreamDefaultController<Uint8Array>, lineWithNewline: Uint8Array) => {
    const line = lineWithNewline[lineWithNewline.length - 1] === NEWLINE ? lineWithNewline.subarray(0, -1) : lineWithNewline;
    const done = parseDoneRecord(line, decoder);
    if (!done) {
      // A blank line between the two records is dropped with the fold; anything else means the
      // held record was not the end after all, so it goes out as it came.
      if (held && decoder.decode(line).trim() === '') return;
      releaseHeld(controller);
      controller.enqueue(lineWithNewline);
      return;
    }
    if (!held) {
      held = done;
      heldBytes = lineWithNewline;
      return;
    }
    // A second terminal record. Output the first one carried goes on ahead as an ordinary record.
    if (carriesOutput(held)) {
      const { done_reason: _reason, ...rest } = held;
      emitRecord(controller, { ...rest, done: false });
    }
    held = foldTerminalRecords(held, done);
    heldBytes = encoder.encode(`${JSON.stringify(held)}\n`);
  };

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (passthrough) {
          controller.enqueue(chunk);
          return;
        }
        const data = new Uint8Array(pending.length + chunk.length);
        data.set(pending);
        data.set(chunk, pending.length);
        let start = 0;
        for (let end = data.indexOf(NEWLINE, start); end !== -1; end = data.indexOf(NEWLINE, start)) {
          takeLine(controller, data.subarray(start, end + 1));
          start = end + 1;
        }
        pending = data.slice(start);
        if (pending.length > MAX_RECORD_BYTES) {
          releaseHeld(controller);
          controller.enqueue(pending);
          pending = new Uint8Array(0);
          passthrough = true;
        }
      },
      flush(controller) {
        if (pending.length > 0) takeLine(controller, pending);
        releaseHeld(controller);
      },
    }),
  );
}
