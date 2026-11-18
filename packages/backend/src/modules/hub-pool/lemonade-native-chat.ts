/**
 * Ollama-native `/api/chat` requests for a Lemonade backend, sent to Lemonade's OpenAI
 * `/v1/chat/completions` with the answer turned back into Ollama's native shape.
 *
 * Lemonade's own Ollama-compatible `/api/chat` reports `prompt_eval_count` as only the prompt
 * tokens llama-server had to process fresh (its `timings.prompt_n`) and sends no
 * `prompt_eval_cached_count`. Measured on Lemonade 2026.48.0: one 13,912-token prompt sent twice
 * reported 13,948 and then 4. Its `/v1` answer to the same request says `prompt_tokens: 13912`,
 * `cached_tokens: 13908`. An agent that sizes its context from the reported count never sees its
 * conversation grow. Hermes, through its native adapter, compacts from that number. On 2026-11-17 it
 * logged turns of 242 and 697 tokens while llama-server held 47–63k. Lemonade then stopped at the
 * full 65,536-token window (`truncated = 1`), and every continuation Hermes tried stopped there too.
 *
 * Lemonade's native endpoint is a shim over the same llama-server, so going to `/v1` changes what
 * the caller reads, not what the engine runs. Things the shim does that this keeps:
 * - `options.num_ctx` is not sent. Lemonade sets the window when it loads a model, and its native
 *   route has never reloaded one for a `num_ctx`.
 * - `think` is not sent. The shim ignores it (`think: false` still thinks).
 * - `done_reason` is the engine's `finish_reason`, `tool_calls` included.
 *
 * Things it does differently: the counts are the whole prompt, plus `prompt_eval_cached_count`; a
 * stream ends with exactly one `done: true` record (see `ollama-terminal-record.ts`); `created_at` is
 * the time of the answer, not a fixed date; tool calls are sent once, whole, on the record before
 * the final one, as Ollama sends them.
 *
 * A request this module can't map exactly (content that isn't a string, an image that isn't a
 * base64 string, logprobs) is not translated. It goes to Lemonade's `/api/chat` as before.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A native request translated for `/v1/chat/completions`. */
export interface LemonadeChatPlan {
  /** The `/v1/chat/completions` body. */
  request: Record<string, unknown>;
  stream: boolean;
  /** The model the caller named, echoed in every record: llama-server streams its file path there. */
  model: string;
}

/** The image type a base64 payload starts with, for the data URI `/v1` wants. llama-server decodes by content, so this only has to be plausible. */
function imageMime(data: string): string {
  if (data.startsWith('/9j/')) return 'image/jpeg';
  if (data.startsWith('R0lGOD')) return 'image/gif';
  if (data.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

/** Native tool calls as OpenAI's, with ids for those that have none, or `null` when one can't be mapped. */
function openAiToolCalls(calls: unknown, nextId: () => string): Record<string, unknown>[] | null {
  if (calls === undefined || calls === null) return [];
  if (!Array.isArray(calls)) return null;
  const mapped: Record<string, unknown>[] = [];
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== 'string') return null;
    const args = call.function.arguments ?? {};
    if (!isRecord(args)) return null;
    mapped.push({
      id: typeof call.id === 'string' && call.id !== '' ? call.id : nextId(),
      type: 'function',
      function: { name: call.function.name, arguments: JSON.stringify(args) },
    });
  }
  return mapped;
}

/**
 * Native messages as OpenAI's, or `null` when one can't be mapped exactly.
 *
 * Native tool results name their tool (`tool_name`) but usually not the call they answer: Ollama
 * matches them by position. `/v1` wants a `tool_call_id`, so each result without one takes the
 * oldest call not yet answered, which is the same match.
 */
function openAiMessages(messages: readonly unknown[]): Record<string, unknown>[] | null {
  let counter = 0;
  const nextId = () => `call_${counter++}`;
  const unanswered: Array<{ id: string; name: string }> = [];
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (!isRecord(message) || typeof message.role !== 'string') return null;
    const role = message.role;
    const content = message.content ?? '';
    if (typeof content !== 'string') return null;
    const mapped: Record<string, unknown> = { role };

    if (message.images !== undefined && message.images !== null) {
      if (!Array.isArray(message.images) || !message.images.every((image) => typeof image === 'string' && image !== '')) return null;
      const parts: Record<string, unknown>[] = [];
      if (content !== '') parts.push({ type: 'text', text: content });
      for (const image of message.images as string[]) {
        parts.push({ type: 'image_url', image_url: { url: `data:${imageMime(image)};base64,${image}` } });
      }
      mapped.content = parts;
    } else {
      mapped.content = content;
    }

    if (typeof message.thinking === 'string' && message.thinking !== '') mapped.reasoning_content = message.thinking;

    const calls = openAiToolCalls(message.tool_calls, nextId);
    if (calls === null) return null;
    if (calls.length > 0) {
      mapped.tool_calls = calls;
      for (const call of calls) unanswered.push({ id: call.id as string, name: (call.function as { name: string }).name });
    }

    if (role === 'tool') {
      const name = typeof message.tool_name === 'string' ? message.tool_name : typeof message.name === 'string' ? message.name : '';
      let id = typeof message.tool_call_id === 'string' && message.tool_call_id !== '' ? message.tool_call_id : '';
      const pending = id === '' ? unanswered.findIndex((call) => name === '' || call.name === name) : unanswered.findIndex((call) => call.id === id);
      const answered = pending >= 0 ? unanswered.splice(pending, 1)[0] : undefined;
      if (answered) id ||= answered.id;
      if (id !== '') mapped.tool_call_id = id;
      if (name !== '') mapped.name = name;
    }
    out.push(mapped);
  }
  return out;
}

/** The native options `/v1` has a field for, by that field. `num_ctx` and the rest are left out (see the module comment). */
const NUMERIC_OPTIONS: ReadonlyArray<[string, string]> = [
  ['temperature', 'temperature'],
  ['top_p', 'top_p'],
  ['top_k', 'top_k'],
  ['min_p', 'min_p'],
  ['seed', 'seed'],
  ['repeat_penalty', 'repeat_penalty'],
  ['presence_penalty', 'presence_penalty'],
  ['frequency_penalty', 'frequency_penalty'],
];

/** The `/v1` request for a native `/api/chat` body sent to Lemonade, or `null` to send it to Lemonade's `/api/chat` as before. */
export function lemonadeChatPlan(body: unknown): LemonadeChatPlan | null {
  if (!isRecord(body) || typeof body.model !== 'string' || !Array.isArray(body.messages) || body.messages.length === 0) return null;
  if (body.logprobs !== undefined && body.logprobs !== false) return null;
  if (body.tools !== undefined && body.tools !== null && !Array.isArray(body.tools)) return null;

  const messages = openAiMessages(body.messages);
  if (messages === null) return null;

  // Ollama streams unless the body says `stream: false`.
  const stream = body.stream !== false;
  const request: Record<string, unknown> = { model: body.model, messages, stream };
  if (stream) request.stream_options = { include_usage: true };
  if (Array.isArray(body.tools) && body.tools.length > 0) request.tools = body.tools;

  if (body.format === 'json') request.response_format = { type: 'json_object' };
  else if (isRecord(body.format)) request.response_format = { type: 'json_schema', json_schema: { name: 'response', schema: body.format } };
  else if (body.format !== undefined && body.format !== null && body.format !== '') return null;

  const options = isRecord(body.options) ? body.options : {};
  for (const [option, field] of NUMERIC_OPTIONS) {
    const value = options[option];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    request[field] = value;
  }
  const predict = options.num_predict;
  if (predict !== undefined && predict !== null) {
    if (typeof predict !== 'number' || !Number.isInteger(predict)) return null;
    // -1 is "no limit" and -2 "fill the window", both what an absent `max_tokens` means to llama-server.
    if (predict >= 0) request.max_tokens = predict;
  }
  if (typeof options.stop === 'string') request.stop = [options.stop];
  else if (Array.isArray(options.stop)) request.stop = options.stop.filter((stop): stop is string => typeof stop === 'string');

  return { request, stream, model: body.model };
}

// ─── The answer ───────────────────────────────────────────────────────────────────────

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAiTimings {
  prompt_ms?: number;
  predicted_ms?: number;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function nanoseconds(ms: unknown): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.round(ms * 1e6) : 0;
}

/** The counts and durations a native closing record carries, from `/v1`'s usage and llama-server's timings. */
function countsOf(usage: OpenAiUsage | undefined, timings: OpenAiTimings | undefined): Record<string, number> {
  const promptNs = nanoseconds(timings?.prompt_ms);
  const evalNs = nanoseconds(timings?.predicted_ms);
  const counts: Record<string, number> = {
    total_duration: promptNs + evalNs,
    load_duration: 0,
    prompt_eval_count: count(usage?.prompt_tokens),
    prompt_eval_duration: promptNs,
    eval_count: count(usage?.completion_tokens),
    eval_duration: evalNs,
  };
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  if (typeof cached === 'number' && Number.isFinite(cached) && cached >= 0) counts.prompt_eval_cached_count = Math.trunc(cached);
  return counts;
}

/** OpenAI tool calls as native ones, their arguments parsed to the object Ollama sends. */
function nativeToolCalls(calls: unknown): Record<string, unknown>[] {
  if (!Array.isArray(calls)) return [];
  const mapped: Record<string, unknown>[] = [];
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    let args: unknown = call.function.arguments;
    if (typeof args === 'string') {
      try {
        args = args.trim() === '' ? {} : JSON.parse(args);
      } catch {
        args = {};
      }
    }
    mapped.push({
      ...(typeof call.id === 'string' && call.id !== '' ? { id: call.id } : {}),
      type: 'function',
      function: { name: typeof call.function.name === 'string' ? call.function.name : '', arguments: isRecord(args) ? args : {} },
    });
  }
  return mapped;
}

/** The message of an OpenAI error body, or the text itself when it isn't one. */
function errorMessageOf(text: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      if (typeof parsed.error === 'string') return parsed.error;
      if (isRecord(parsed.error) && typeof parsed.error.message === 'string') return parsed.error.message;
    }
  } catch {
    // Not JSON: the text is the message.
  }
  return text.trim() || fallback;
}

/** A whole `/v1` answer as Ollama's non-streamed `/api/chat` record. */
function recordOf(completion: Record<string, unknown>, model: string): Record<string, unknown> {
  const choice = Array.isArray(completion.choices) && isRecord(completion.choices[0]) ? completion.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const toolCalls = nativeToolCalls(message.tool_calls);
  return {
    model,
    created_at: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : '',
      ...(typeof message.reasoning_content === 'string' && message.reasoning_content !== '' ? { thinking: message.reasoning_content } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    done: true,
    done_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
    ...countsOf(completion.usage as OpenAiUsage | undefined, completion.timings as OpenAiTimings | undefined),
  };
}

interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Turns `/v1` server-sent events into Ollama's NDJSON records. */
class StreamTranslator {
  private readonly toolCalls = new Map<number, PartialToolCall>();
  private finishReason: string | null = null;
  private usage: OpenAiUsage | undefined;
  private timings: OpenAiTimings | undefined;
  finished = false;

  constructor(private readonly model: string) {}

  private record(message: Record<string, unknown>, done: boolean, extra: Record<string, unknown> = {}): string {
    return `${JSON.stringify({ model: this.model, created_at: new Date().toISOString(), message: { role: 'assistant', ...message }, done, ...extra })}\n`;
  }

  /** The records for one server-sent event's data. */
  event(data: string): string[] {
    if (data === '[DONE]') return this.close();
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];
    }
    if (!isRecord(parsed)) return [];
    if (parsed.error !== undefined) {
      this.finished = true;
      return [`${JSON.stringify({ error: errorMessageOf(JSON.stringify(parsed), 'Lemonade reported an error') })}\n`];
    }
    if (isRecord(parsed.usage)) this.usage = parsed.usage as OpenAiUsage;
    if (isRecord(parsed.timings)) this.timings = parsed.timings as OpenAiTimings;
    const records: string[] = [];
    const choice = Array.isArray(parsed.choices) && isRecord(parsed.choices[0]) ? parsed.choices[0] : null;
    if (choice) {
      const delta = isRecord(choice.delta) ? choice.delta : {};
      const content = typeof delta.content === 'string' ? delta.content : '';
      const thinking = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
      if (content !== '' || thinking !== '') records.push(this.record({ content, ...(thinking === '' ? {} : { thinking }) }, false));
      if (Array.isArray(delta.tool_calls)) {
        for (const [position, call] of delta.tool_calls.entries()) {
          if (!isRecord(call)) continue;
          const index = typeof call.index === 'number' ? call.index : position;
          const partial = this.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
          if (typeof call.id === 'string' && call.id !== '') partial.id = call.id;
          if (isRecord(call.function)) {
            if (typeof call.function.name === 'string') partial.name += call.function.name;
            if (typeof call.function.arguments === 'string') partial.arguments += call.function.arguments;
          }
          this.toolCalls.set(index, partial);
        }
      }
      if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason;
    }
    return records;
  }

  /** The tool calls, if any, then the one closing record. Empty when the engine never said why it stopped. */
  close(): string[] {
    if (this.finished) return [];
    this.finished = true;
    if (this.finishReason === null) return [];
    const records: string[] = [];
    if (this.toolCalls.size > 0) {
      const calls = [...this.toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => ({ ...(call.id ? { id: call.id } : {}), type: 'function', function: { name: call.name, arguments: call.arguments } }));
      records.push(this.record({ content: '', tool_calls: nativeToolCalls(calls) }, false));
    }
    records.push(this.record({ content: '' }, true, { done_reason: this.finishReason, ...countsOf(this.usage, this.timings) }));
    return records;
  }
}

/**
 * Lemonade's `/v1` answer to a {@link lemonadeChatPlan} request, as Ollama's `/api/chat` would have
 * sent it: NDJSON for a stream, one JSON record otherwise, `{"error": ...}` for any status but 200.
 * The status passes through. A stream is translated as it arrives; cancelling it cancels the read
 * from Lemonade.
 */
export async function nativeChatResponseFromOpenAi(upstream: globalThis.Response, plan: LemonadeChatPlan): Promise<globalThis.Response> {
  const jsonHeaders = { 'Content-Type': 'application/json' };
  if (upstream.status !== 200) {
    const message = errorMessageOf(await upstream.text().catch(() => ''), upstream.statusText || `HTTP ${upstream.status}`);
    return new Response(`${JSON.stringify({ error: message })}\n`, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: jsonHeaders,
    });
  }
  if (!plan.stream) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await upstream.text());
    } catch {
      parsed = null;
    }
    if (!isRecord(parsed)) {
      return new Response(`${JSON.stringify({ error: 'Lemonade sent a chat answer that is not JSON' })}\n`, { status: 502, headers: jsonHeaders });
    }
    return new Response(`${JSON.stringify(recordOf(parsed, plan.model))}\n`, { status: 200, headers: jsonHeaders });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const source = upstream.body?.getReader();
  const translator = new StreamTranslator(plan.model);
  let buffered = '';

  /** The `data:` payloads of the complete events in `buffered`, leaving a partial one there. */
  const takeEvents = (flush: boolean): string[] => {
    const datas: string[] = [];
    buffered = buffered.replace(/\r\n/g, '\n');
    let end = buffered.indexOf('\n\n');
    while (end >= 0 || (flush && buffered.trim() !== '')) {
      const block = end >= 0 ? buffered.slice(0, end) : buffered;
      buffered = end >= 0 ? buffered.slice(end + 2) : '';
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).replace(/^ /, ''))
        .join('\n');
      if (data !== '') datas.push(data);
      end = buffered.indexOf('\n\n');
    }
    return datas;
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!source) {
        controller.close();
        return;
      }
      for (;;) {
        const next = await source.read();
        if (next.done) {
          buffered += decoder.decode();
          for (const data of takeEvents(true)) {
            for (const record of translator.event(data)) controller.enqueue(encoder.encode(record));
          }
          for (const record of translator.close()) controller.enqueue(encoder.encode(record));
          controller.close();
          return;
        }
        buffered += decoder.decode(next.value, { stream: true });
        let wrote = false;
        for (const data of takeEvents(false)) {
          if (translator.finished) break;
          for (const record of translator.event(data)) {
            controller.enqueue(encoder.encode(record));
            wrote = true;
          }
        }
        if (translator.finished) {
          await source.cancel().catch(() => undefined);
          controller.close();
          return;
        }
        if (wrote) return;
      }
    },
    async cancel(reason) {
      await source?.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(body, { status: 200, statusText: upstream.statusText, headers: new Headers({ 'Content-Type': 'application/x-ndjson' }) });
}
