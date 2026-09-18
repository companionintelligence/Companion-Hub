import { TransformStream, type ReadableStream } from 'node:stream/web';
import type { PoolRoutingUsage } from './hub-pool-routing-log.service';

/**
 * Reads a backend's chat/completion response for a token-usage frame while it streams through,
 * without changing a single byte the client receives.
 *
 * Two dialects are recognised, both confirmed against this fleet's actual backends (see
 * `docs/hub-pool-testing.md` and the eval harness's `prompt-bank.ts`, which verified
 * `stream_options.include_usage` against live ollama, llama-server/lemonade, vLLM and mlx-dspark
 * servers):
 *   - Ollama's native NDJSON: the LAST line has `"done":true` alongside `eval_count` /
 *     `prompt_eval_count`. Sent unconditionally — no request opt-in needed.
 *   - OpenAI-compatible: a top-level `usage` object, either on a non-streamed JSON body, or on the
 *     final SSE `data:` frame when the request carried `stream_options.include_usage: true` (see
 *     {@link injectUsageOptIn} — the proxy adds that flag itself, since apps do not know to).
 *
 * What this deliberately does NOT do: estimate tokens from `durationMs`, byte counts, or any other
 * proxy of the real number. A dialect this does not recognise, or a request nobody opted in for
 * usage on, yields no call to `onUsage` at all — `PoolRoutingRecord.usage` stays `null`, which is
 * the honest answer, not a guess dressed as one.
 */

const MAX_LINE_BUFFER_BYTES = 64 * 1024;
const MAX_WHOLE_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Pulls a `PoolRoutingUsage` out of one already-parsed JSON value — a single NDJSON line, one SSE
 * frame's payload, or a whole non-streamed response body. Returns `null` when the value carries
 * neither shape, or when every field it does carry is empty (a `usage: {}` frame some backends
 * send mid-stream before the real one, for instance, must not overwrite nothing with nothing).
 */
export function extractUsageFromParsedJson(value: unknown): PoolRoutingUsage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;

  // OpenAI-compatible: a `usage` object, either at the top level (non-streamed) or on the final
  // SSE frame's payload (streamed, with the opt-in this proxy adds).
  const usageField = record.usage;
  if (usageField && typeof usageField === 'object') {
    const usage = usageField as Record<string, unknown>;
    const promptTokens = toFiniteNumberOrNull(usage.prompt_tokens);
    const completionTokens = toFiniteNumberOrNull(usage.completion_tokens);
    const totalTokens = toFiniteNumberOrNull(usage.total_tokens);
    if (promptTokens !== null || completionTokens !== null || totalTokens !== null) {
      return { promptTokens, completionTokens, totalTokens: totalTokens ?? sumOrNull(promptTokens, completionTokens) };
    }
  }

  // Ollama native: the final NDJSON line, `done: true` alongside eval_count / prompt_eval_count.
  // Every intermediate line also has `done: false` with neither field, so gating on `done === true`
  // is what keeps this from firing (with nulls) on every token of the generation.
  if (record.done === true) {
    const promptTokens = toFiniteNumberOrNull(record.prompt_eval_count);
    const completionTokens = toFiniteNumberOrNull(record.eval_count);
    if (promptTokens !== null || completionTokens !== null) {
      return { promptTokens, completionTokens, totalTokens: sumOrNull(promptTokens, completionTokens) };
    }
  }

  return null;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sumOrNull(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

/** An engine's own account of where a request's time went, in milliseconds. Any part it did not report is `null`. */
export interface EngineTimings {
  promptTokens: number | null;
  promptMs: number | null;
  completionTokens: number | null;
  decodeMs: number | null;
}

/**
 * The engine's own prefill and decode timings from one parsed frame, for throughput placement. Better
 * than timing the first byte from outside when present, because they leave out the model load and the
 * queue. Two dialects, both on the frame that ends the response:
 *   - Ollama native: `prompt_eval_duration` / `eval_duration` in NANOSECONDS on the `done: true` line.
 *     Its OpenAI-compatible surface reports no timings, which is why the proxy also times the first byte.
 *   - llama.cpp's server (llama-server, lemonade): a `timings` object in milliseconds.
 */
export function extractEngineTimingsFromParsedJson(value: unknown): EngineTimings | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.done === true) {
    const promptNs = toFiniteNumberOrNull(record.prompt_eval_duration);
    const decodeNs = toFiniteNumberOrNull(record.eval_duration);
    if (promptNs !== null || decodeNs !== null) {
      return {
        promptTokens: toFiniteNumberOrNull(record.prompt_eval_count),
        promptMs: promptNs === null ? null : promptNs / 1e6,
        completionTokens: toFiniteNumberOrNull(record.eval_count),
        decodeMs: decodeNs === null ? null : decodeNs / 1e6,
      };
    }
  }
  const timings = record.timings;
  if (timings && typeof timings === 'object' && !Array.isArray(timings)) {
    const t = timings as Record<string, unknown>;
    const promptMs = toFiniteNumberOrNull(t.prompt_ms);
    const decodeMs = toFiniteNumberOrNull(t.predicted_ms);
    if (promptMs !== null || decodeMs !== null) {
      return { promptTokens: toFiniteNumberOrNull(t.prompt_n), promptMs, completionTokens: toFiniteNumberOrNull(t.predicted_n), decodeMs };
    }
  }
  return null;
}

/** The rest of what a response can tell throughput placement while it streams through. Every callback is optional and at most once. */
export interface ResponseTapObserver {
  onEngineTimings?: (timings: EngineTimings) => void;
  /** The first body chunk arrived. For an engine that holds its headers until it has a token, that is the same moment. */
  onFirstChunk?: () => void;
  /** The body ended normally. Never called for a stream that was cut off. */
  onComplete?: () => void;
}

function notify(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // An observer's failure must never reach the client's stream.
  }
}

/**
 * Adds `stream_options.include_usage: true` to a streamed request body, which is what makes an
 * OpenAI-compatible backend include a `usage` frame at all — without it, a streamed completion
 * never reports tokens, by the spec's own design, not a bug in any one backend. Left untouched for
 * a non-streamed request (`usage` there is unconditional) and for anything that is not a plain
 * object. Any `stream_options` the caller already set is preserved and merged under, never replaced.
 */
export function injectUsageOptIn(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body) || (body as Record<string, unknown>).stream !== true) {
    return body;
  }
  const record = body as Record<string, unknown>;
  const existingStreamOptions = record.stream_options && typeof record.stream_options === 'object' ? record.stream_options : {};
  return { ...record, stream_options: { ...existingStreamOptions, include_usage: true } };
}

/**
 * Wraps a response body so every chunk reaches the client byte-for-byte and unbuffered, while a
 * side channel incrementally scans decoded text for a usage frame and calls `onUsage` at most once
 * if it finds one.
 *
 * `controller.enqueue(chunk)` happens on the ORIGINAL `Uint8Array`, before any parsing attempt —
 * the client's copy of the response can never be affected by what this function does or fails to
 * do. Parsing runs off a separate decoded-text buffer that is capped ({@link MAX_LINE_BUFFER_BYTES}
 * per line, {@link MAX_WHOLE_BODY_BYTES} for the whole-body fallback used by non-streamed
 * responses) so a pathological or enormous response cannot grow this tap's own memory without
 * bound — past the cap, this tap simply stops looking, the pipe-through keeps running regardless.
 */
export function tapResponseUsageWhileStreaming(
  source: ReadableStream<Uint8Array>,
  onUsage: (usage: PoolRoutingUsage) => void,
  observer: ResponseTapObserver = {},
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let wholeBodyBuffer = '';
  let wholeBodyOverflowed = false;
  let usageFired = false;
  // Nothing to look for when nobody asked, so a usage-only tap stops parsing where it always did.
  let timingsFired = !observer.onEngineTimings;
  let sawFirstChunk = false;
  let sawNewline = false;
  const fired = () => usageFired && timingsFired;

  const tryLine = (line: string) => {
    if (fired()) return;
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]' || trimmed === '[DONE]') return;
    const jsonText = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!jsonText) return;
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (!usageFired) {
        const usage = extractUsageFromParsedJson(parsed);
        if (usage) {
          usageFired = true;
          onUsage(usage);
        }
      }
      if (!timingsFired) {
        const timings = extractEngineTimingsFromParsedJson(parsed);
        if (timings) {
          timingsFired = true;
          observer.onEngineTimings?.(timings);
        }
      }
    } catch {
      // Not a JSON line — most NDJSON/SSE lines this ever sees are exactly that, and are not the
      // one this tap is looking for.
    }
  };

  const consumeText = (text: string) => {
    if (fired()) return;

    if (!wholeBodyOverflowed) {
      wholeBodyBuffer += text;
      if (wholeBodyBuffer.length > MAX_WHOLE_BODY_BYTES) {
        wholeBodyOverflowed = true;
        wholeBodyBuffer = '';
      }
    }

    lineBuffer += text;
    for (let newlineIndex = lineBuffer.indexOf('\n'); newlineIndex !== -1; newlineIndex = lineBuffer.indexOf('\n')) {
      sawNewline = true;
      const line = lineBuffer.slice(0, newlineIndex);
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      tryLine(line);
      if (fired()) return;
    }
    if (lineBuffer.length > MAX_LINE_BUFFER_BYTES) {
      // One line has grown implausibly long without a newline — not a shape this tap recognises
      // either way. Drop it rather than let a single malformed line grow without bound.
      lineBuffer = '';
    }
  };

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          notify(observer.onFirstChunk);
        }
        try {
          consumeText(decoder.decode(chunk, { stream: true }));
        } catch {
          // A parse-side failure must never touch the client's copy of the response, already
          // enqueued above.
        }
      },
      flush() {
        try {
          if (!fired() && lineBuffer.trim()) tryLine(lineBuffer);
          // A non-streamed response is one JSON object with no internal newlines at all — nothing
          // above ever called `tryLine` for it. Only worth trying when nothing that looked like a
          // line-oriented stream was seen, so a genuinely huge streamed generation whose usage line
          // got dropped by the per-line cap does not ALSO pay for a 2 MB whole-body re-parse.
          if (!fired() && !sawNewline && !wholeBodyOverflowed && wholeBodyBuffer.trim()) {
            tryLine(wholeBodyBuffer);
          }
        } catch {
          // Same rule as above: telemetry extraction must never throw out of a stream's flush.
        }
        // After the last line was read, so timings on an unterminated final line arrive first.
        notify(observer.onComplete);
      },
    }),
  );
}
