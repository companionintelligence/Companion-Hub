/**
 * OpenAI chat completions sent to Ollama's native `/api/chat` with the answer turned back into the
 * OpenAI shape, so a `/v1` caller gets the context window it asks for (CI-Hub#2310).
 *
 * Ollama's `/v1/chat/completions` handler copies a fixed list of OpenAI fields into the request's
 * options (stop, max_tokens, temperature, seed, the two penalties, top_p) and drops everything else,
 * `options.num_ctx` included. It is unchanged through Ollama 0.40.15. ollama/ollama#16825, which
 * would forward it, is still open. Its native `/api/chat` honours `options.num_ctx`. Companion Memory
 * sends `options.num_ctx` on `/v1` and Hermes sends it through `extra_body`, so both ran at the
 * host's default window while OpenClaw, on the native route, asked for the handout's. On a
 * CPU-only machine each switch between the two reloaded the model and threw away its prompt cache.
 *
 * A request that names `options.num_ctx` is translated, because that is the one thing `/v1` loses.
 * One that names none is translated only through {@link nativeChatPlanAt}, at the window its model
 * is already loaded at, so it doesn't reload it. Everything else maps the way Ollama's own middleware maps it (`openai/openai.go` and
 * `middleware/openai.go` at v0.40.15), so the caller sees what `/v1` would have sent. A request
 * this module can't map exactly (an image URL Ollama refuses, tool arguments that aren't a JSON
 * object, an unknown content part) is not translated: it goes to `/v1` as before and gets Ollama's
 * own answer there.
 *
 * Older Ollama releases (0.22, for one) set temperature and top_p to 1.0 on `/v1` when a request
 * leaves them out. 0.40.15 doesn't, and neither does this module: the model's own defaults apply.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A request translated for `/api/chat`, with what the answer's translation needs to know. */
export interface NativeChatPlan {
  /** The `/api/chat` body. */
  request: Record<string, unknown>;
  stream: boolean;
  /** `stream_options.include_usage`: a streamed answer ends with a usage chunk. */
  includeUsage: boolean;
}

/** The window a body names in `options.num_ctx`, or `null`. Anything but a positive integer is none. */
export function optionsNumCtx(body: unknown): number | null {
  if (!isRecord(body) || !isRecord(body.options)) return null;
  const raw = body.options.num_ctx;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/** Strict standard base64 with padding, as Go's `base64.StdEncoding` reads it. */
function isStdBase64(text: string): boolean {
  return text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text);
}

const IMAGE_DATA_PREFIXES = ['data:image/jpeg;base64,', 'data:image/jpg;base64,', 'data:image/png;base64,', 'data:image/webp;base64,'];

/** The base64 payload of an image data URI, as Ollama's `decodeImageURL` accepts it, or `null` for anything it refuses. */
function imageData(url: string): string | null {
  let data: string | undefined;
  if (url.startsWith('data:;base64,')) {
    data = url.slice('data:;base64,'.length);
  } else {
    const prefix = IMAGE_DATA_PREFIXES.find((candidate) => url.startsWith(candidate));
    data = prefix === undefined ? undefined : url.slice(prefix.length);
  }
  return data !== undefined && isStdBase64(data) ? data : null;
}

type NativeToolCall = { id?: string; function: { name: unknown; arguments: Record<string, unknown> } };

/** OpenAI tool calls with their arguments as objects, or `null` when one carries arguments that aren't a JSON object. */
function nativeToolCalls(toolCalls: unknown): NativeToolCall[] | null {
  if (toolCalls === undefined || toolCalls === null) return [];
  if (!Array.isArray(toolCalls)) return null;
  const calls: NativeToolCall[] = [];
  for (const call of toolCalls) {
    if (!isRecord(call) || !isRecord(call.function) || typeof call.function.arguments !== 'string') return null;
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      return null;
    }
    if (!isRecord(args)) return null;
    calls.push({
      ...(typeof call.id === 'string' && call.id !== '' ? { id: call.id } : {}),
      function: { name: call.function.name, arguments: args },
    });
  }
  return calls;
}

/** The tool a `tool` message answers, by its call id, the last call with that id winning (Ollama's `nameFromToolCallID`). */
function toolNameFor(messages: readonly unknown[], toolCallId: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (isRecord(call) && call.id === toolCallId && isRecord(call.function) && typeof call.function.name === 'string') {
        return call.function.name;
      }
    }
  }
  return '';
}

/** One OpenAI message as Ollama's native messages, or `null` when it can't be mapped exactly. */
function nativeMessages(message: unknown, all: readonly unknown[]): Record<string, unknown>[] | null {
  if (!isRecord(message) || typeof message.role !== 'string') return null;
  const role = message.role;
  const reasoning = typeof message.reasoning === 'string' ? message.reasoning : '';
  const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
  let toolName = '';
  if (role.toLowerCase() === 'tool') {
    toolName = typeof message.name === 'string' ? message.name : '';
    if (toolName === '' && toolCallId !== '') toolName = toolNameFor(all, toolCallId);
  }
  const calls = nativeToolCalls(message.tool_calls);
  if (calls === null) return null;
  const hasCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const extras = (into: Record<string, unknown>): Record<string, unknown> => {
    if (toolName !== '') into.tool_name = toolName;
    if (toolCallId !== '') into.tool_call_id = toolCallId;
    return into;
  };

  let content = message.content;
  if (Array.isArray(content) && content.length === 0 && hasCalls) content = '';

  if (typeof content === 'string') {
    return [extras({ role, content, ...(reasoning ? { thinking: reasoning } : {}), ...(calls.length > 0 ? { tool_calls: calls } : {}) })];
  }

  if (Array.isArray(content)) {
    const parts: Record<string, unknown>[] = [];
    for (const part of content) {
      if (!isRecord(part)) return null;
      if (part.type === 'text') {
        if (typeof part.text !== 'string') return null;
        parts.push({ role, content: part.text });
      } else if (part.type === 'image_url') {
        const url = isRecord(part.image_url) ? part.image_url.url : part.image_url;
        if (typeof url !== 'string') return null;
        const data = imageData(url);
        if (data === null) return null;
        parts.push({ role, content: '', images: [data] });
      } else if (part.type === 'input_audio') {
        const data = isRecord(part.input_audio) ? part.input_audio.data : undefined;
        if (typeof data !== 'string' || !isStdBase64(data)) return null;
        parts.push({ role, content: '', images: [data] });
      } else {
        return null;
      }
    }
    // A tool message is one result: its text parts merge into one message while parts with images
    // stay apart so each image keeps its place, every one still naming the call it answers.
    if (role.toLowerCase() === 'tool') {
      if (parts.some((part) => part.images !== undefined)) {
        for (const part of parts) extras(part);
      } else if (parts.length > 0 || toolName !== '' || toolCallId !== '') {
        parts.splice(0, parts.length, extras({ role, content: parts.map((part) => part.content).join('') }));
      }
    }
    // Several messages may have come from one, so the tool calls go on the last of them.
    if (parts.length > 0 && hasCalls) {
      const last = parts[parts.length - 1] as Record<string, unknown>;
      last.tool_calls = calls;
      extras(last);
      if (reasoning) last.thinking = reasoning;
    }
    return parts;
  }

  // No content is only valid alongside tool calls.
  if (!Array.isArray(message.tool_calls)) return null;
  return [
    { role, content: '', ...(reasoning ? { thinking: reasoning } : {}), tool_calls: calls, ...(toolCallId ? { tool_call_id: toolCallId } : {}) },
  ];
}

/** `think` for a reasoning effort, as Ollama's `ThinkingFromReasoningEffort` maps it; `undefined` for none, `null` for a value it refuses. */
function thinkFor(effort: unknown): boolean | string | undefined | null {
  if (effort === undefined || effort === null || effort === '') return undefined;
  if (typeof effort !== 'string') return null;
  if (effort === 'none') return false;
  const level = effort === 'minimal' ? 'low' : effort === 'xhigh' || effort === 'ultra' ? 'max' : effort;
  return ['low', 'medium', 'high', 'max'].includes(level) ? level : null;
}

/** Plans already worked out, by body: one request's routing asks for its window several times. */
const plans = new WeakMap<object, NativeChatPlan | null>();

/**
 * The `/api/chat` request for an OpenAI chat completion body that names `options.num_ctx`, or `null`
 * to leave the request on `/v1`: it names no window, or carries something this module would not map
 * exactly as Ollama does (Ollama's `/v1` then answers it, error included).
 *
 * Worked out once per body. Placement, the window bookkeeping and the forward all ask. An agent
 * turn carries every tool call's arguments and every image it has sent so far.
 */
export function nativeChatPlan(body: unknown): NativeChatPlan | null {
  if (!isRecord(body)) return null;
  let plan = plans.get(body);
  if (plan === undefined) {
    plan = planFor(body);
    plans.set(body, plan);
  }
  return plan;
}

/**
 * The `/api/chat` request for a `/v1` chat completion that names no window, run at `numCtx`: the
 * window its model is already loaded at, so the request doesn't reload it at the engine's default
 * (see `PoolProxyService.loadedWindowPlan`). `null` when the body names a window of its own, or
 * carries something this module would not map exactly as Ollama does.
 */
export function nativeChatPlanAt(body: unknown, numCtx: number): NativeChatPlan | null {
  if (!isRecord(body) || optionsNumCtx(body) !== null || !Number.isInteger(numCtx) || numCtx <= 0) return null;
  return planFor(body, numCtx);
}

function planFor(body: Record<string, unknown>, numCtx: number | null = optionsNumCtx(body)): NativeChatPlan | null {
  if (numCtx === null) return null;
  if (typeof body.model !== 'string' || !Array.isArray(body.messages) || body.messages.length === 0) return null;
  if (body._debug_render_only !== undefined) return null;

  const messages: Record<string, unknown>[] = [];
  for (const message of body.messages) {
    const mapped = nativeMessages(message, body.messages);
    if (mapped === null) return null;
    messages.push(...mapped);
  }

  const options: Record<string, unknown> = { num_ctx: numCtx };
  if (typeof body.stop === 'string') options.stop = [body.stop];
  else if (Array.isArray(body.stop)) options.stop = body.stop.filter((stop): stop is string => typeof stop === 'string');
  else if (body.stop !== undefined && body.stop !== null) return null;
  const numeric: ReadonlyArray<[string, string]> = [
    ['max_tokens', 'num_predict'],
    ['temperature', 'temperature'],
    ['seed', 'seed'],
    ['frequency_penalty', 'frequency_penalty'],
    ['presence_penalty', 'presence_penalty'],
    ['top_p', 'top_p'],
  ];
  for (const [field, option] of numeric) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number') return null;
    // `/v1` reads these two into Go ints and refuses a fraction; `/api/chat` would truncate it.
    if ((field === 'max_tokens' || field === 'seed') && !Number.isInteger(value)) return null;
    options[option] = value;
  }

  let format: unknown;
  if (isRecord(body.response_format)) {
    const type = typeof body.response_format.type === 'string' ? body.response_format.type.trim().toLowerCase() : '';
    if (type === 'json_object') format = 'json';
    else if (type === 'json_schema' && isRecord(body.response_format.json_schema)) format = body.response_format.json_schema.schema;
  }

  const effort = isRecord(body.reasoning) ? body.reasoning.effort : body.reasoning_effort;
  const think = thinkFor(effort);
  if (think === null) return null;

  if (body.tools !== undefined && body.tools !== null && !Array.isArray(body.tools)) return null;
  const stream = body.stream === true;
  const request: Record<string, unknown> = {
    model: body.model,
    messages,
    options,
    stream,
  };
  if (format !== undefined) request.format = format;
  if (Array.isArray(body.tools) && body.tools.length > 0) request.tools = body.tools;
  if (think !== undefined) request.think = think;
  if (body.logprobs === true) request.logprobs = true;
  if (typeof body.top_logprobs === 'number' && body.top_logprobs > 0) request.top_logprobs = body.top_logprobs;
  if (body.keep_alive !== undefined) request.keep_alive = body.keep_alive;
  const includeUsage = isRecord(body.stream_options) && body.stream_options.include_usage === true;
  return { request, stream, includeUsage };
}

/** The window a `/v1` chat completion runs at once {@link nativeChatPlan} sends it to Ollama natively, or `null` when it stays on `/v1`. */
export function nativeChatWindow(body: unknown): number | null {
  return nativeChatPlan(body) ? optionsNumCtx(body) : null;
}

// ─── The answer ───────────────────────────────────────────────────────────────────────

interface NativeToolCallOut {
  id?: string;
  function?: { index?: number; name?: string; arguments?: unknown };
}

interface NativeChatResponse {
  model?: string;
  created_at?: string;
  message?: { role?: string; content?: string; thinking?: string; tool_calls?: NativeToolCallOut[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  logprobs?: unknown[];
  error?: unknown;
}

function openAiToolCalls(calls: NativeToolCallOut[] | undefined): Record<string, unknown>[] {
  return (calls ?? []).map((call, position) => ({
    id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
    index: call.function?.index ?? position,
    type: 'function',
    function: { name: call.function?.name ?? '', arguments: JSON.stringify(call.function?.arguments ?? {}) },
  }));
}

function usageOf(response: NativeChatResponse): Record<string, unknown> {
  const prompt = response.prompt_eval_count ?? 0;
  const completion = response.eval_count ?? 0;
  return {
    prompt_tokens: prompt,
    ...(typeof response.prompt_eval_cached_count === 'number' ? { prompt_tokens_details: { cached_tokens: response.prompt_eval_cached_count } } : {}),
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

/** Ollama's `ToTimings`: its durations are nanoseconds, cut to whole milliseconds. */
function timingsOf(response: NativeChatResponse): Record<string, number> | undefined {
  const promptN = response.prompt_eval_count ?? 0;
  const predictedN = response.eval_count ?? 0;
  const promptNs = response.prompt_eval_duration ?? 0;
  const predictedNs = response.eval_duration ?? 0;
  if (promptN === 0 && promptNs === 0 && predictedN === 0 && predictedNs === 0) return undefined;
  const promptMs = Math.trunc(promptNs / 1e6);
  const predictedMs = Math.trunc(predictedNs / 1e6);
  return {
    prompt_n: promptN,
    prompt_ms: promptMs,
    prompt_per_token_ms: safeDiv(promptMs, promptN),
    prompt_per_second: safeDiv(promptN * 1000, promptMs),
    predicted_n: predictedN,
    predicted_ms: predictedMs,
    predicted_per_token_ms: safeDiv(predictedMs, predictedN),
    predicted_per_second: safeDiv(predictedN * 1000, predictedMs),
  };
}

function unixSeconds(createdAt: string | undefined): number | null {
  const parsed = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null;
}

/** OpenAI's error body for a status, as Ollama's `NewError` words its type. */
function openAiError(status: number, message: string): Record<string, unknown> {
  const type = status === 400 ? 'invalid_request_error' : status === 404 ? 'not_found_error' : 'api_error';
  return { error: { message, type, param: null, code: null } };
}

function errorMessageOf(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Not JSON: the text itself is the message, as Ollama's `writeError` takes it.
  }
  return text;
}

interface ChunkParts {
  includeRole: boolean;
  /** The content and tool calls. Off for the thinking half of a split response. */
  answer: boolean;
  /** The thinking and the logprobs. Off for the answer half of a split response. */
  reasoning: boolean;
}

/** A chunk of a streamed answer, Ollama's `toChunk`, with the halves {@link ChunkParts} asks for. */
function chunkOf(id: string, created: number, response: NativeChatResponse, toolCalls: Record<string, unknown>[], parts: ChunkParts) {
  const message = response.message ?? {};
  const delta: Record<string, unknown> = {};
  if (parts.includeRole) delta.role = 'assistant';
  if (parts.answer) delta.content = message.content ?? '';
  if (parts.reasoning && message.thinking) delta.reasoning = message.thinking;
  if (parts.answer && toolCalls.length > 0) delta.tool_calls = toolCalls;
  const choice: Record<string, unknown> = { index: 0, delta, finish_reason: null };
  if (parts.reasoning && Array.isArray(response.logprobs) && response.logprobs.length > 0) choice.logprobs = { content: response.logprobs };
  return { id, object: 'chat.completion.chunk', created, model: response.model ?? '', system_fingerprint: 'fp_ollama', choices: [choice] };
}

/** Turns Ollama's NDJSON stream into OpenAI's server-sent events, as Ollama's `ChatWriter` does for `/v1`. */
class StreamTranslator {
  private readonly id = `chatcmpl-${Math.floor(Math.random() * 999)}`;
  private created: number | null = null;
  private firstChunkSent = false;
  private toolCallSent = false;
  finished = false;

  constructor(private readonly includeUsage: boolean) {}

  /** The events for one NDJSON line. */
  line(text: string): string[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    if (!isRecord(parsed)) return [];
    const response = parsed as NativeChatResponse;
    if (response.error !== undefined) {
      // Ollama's own `/v1` turns this line into an empty chunk and stops; an error event says why.
      this.finished = true;
      return [`data: ${JSON.stringify(openAiError(500, typeof response.error === 'string' ? response.error : JSON.stringify(response.error)))}\n\n`];
    }
    this.created ??= unixSeconds(response.created_at) ?? Math.floor(Date.now() / 1000);
    const created = this.created;
    const message = response.message ?? {};
    const toolCalls = openAiToolCalls(message.tool_calls);
    const events: string[] = [];
    const emptyTrailer =
      response.done === true &&
      this.firstChunkSent &&
      !message.content &&
      !message.thinking &&
      toolCalls.length === 0 &&
      !(Array.isArray(response.logprobs) && response.logprobs.length > 0);
    if (!emptyTrailer) {
      const includeRole = !this.firstChunkSent;
      const mixed = Boolean(message.thinking) && (Boolean(message.content) || toolCalls.length > 0);
      // Thinking and an answer in one response: the thinking goes out first, on its own chunk.
      const chunks = mixed
        ? [
            chunkOf(this.id, created, response, toolCalls, { includeRole, answer: false, reasoning: true }),
            chunkOf(this.id, created, response, toolCalls, { includeRole: false, answer: true, reasoning: false }),
          ]
        : [chunkOf(this.id, created, response, toolCalls, { includeRole, answer: true, reasoning: true })];
      for (const chunk of chunks) events.push(`data: ${JSON.stringify(chunk)}\n\n`);
      if (toolCalls.length > 0) this.toolCallSent = true;
      this.firstChunkSent = true;
    }
    if (response.done === true) {
      let reason = response.done_reason || 'stop';
      if (reason === 'stop' && this.toolCallSent) reason = 'tool_calls';
      const finish = {
        id: this.id,
        object: 'chat.completion.chunk',
        created,
        model: response.model ?? '',
        system_fingerprint: 'fp_ollama',
        choices: [{ index: 0, delta: {}, finish_reason: reason }],
      };
      events.push(`data: ${JSON.stringify(finish)}\n\n`);
      if (this.includeUsage) {
        const timings = timingsOf(response);
        events.push(`data: ${JSON.stringify({ ...finish, choices: [], usage: usageOf(response), ...(timings ? { timings } : {}) })}\n\n`);
      }
      events.push('data: [DONE]\n\n');
      this.finished = true;
    }
    return events;
  }
}

/** A whole answer, Ollama's `ToChatCompletion`. */
function completionOf(response: NativeChatResponse): Record<string, unknown> {
  const message = response.message ?? {};
  const toolCalls = openAiToolCalls(message.tool_calls);
  let reason: string | null = response.done_reason || null;
  if (reason === 'stop' && toolCalls.length > 0) reason = 'tool_calls';
  const choice: Record<string, unknown> = {
    index: 0,
    message: {
      role: message.role ?? 'assistant',
      content: message.content ?? '',
      ...(message.thinking ? { reasoning: message.thinking } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    finish_reason: reason,
  };
  if (Array.isArray(response.logprobs) && response.logprobs.length > 0) choice.logprobs = { content: response.logprobs };
  return {
    id: `chatcmpl-${Math.floor(Math.random() * 999)}`,
    object: 'chat.completion',
    created: unixSeconds(response.created_at) ?? Math.floor(Date.now() / 1000),
    model: response.model ?? '',
    system_fingerprint: 'fp_ollama',
    choices: [choice],
    usage: usageOf(response),
  };
}

/**
 * Ollama's `/api/chat` answer to a {@link nativeChatPlan} request, as the OpenAI answer `/v1` would
 * have sent: server-sent events for a stream, one JSON object otherwise or OpenAI's error body for
 * any status but 200. The status passes through. A stream is translated as it arrives, so it reaches
 * the caller chunk by chunk. Cancelling it cancels the read from Ollama. A whole answer is read
 * first, because Ollama sends it in one piece, so one that isn't JSON can become a 502 instead of an
 * error body under a 200.
 */
export async function openAiChatResponse(upstream: globalThis.Response, plan: NativeChatPlan): Promise<globalThis.Response> {
  if (upstream.status === 200 && !plan.stream) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await upstream.text());
    } catch {
      parsed = null;
    }
    const headers = { 'Content-Type': 'application/json' };
    if (!isRecord(parsed)) {
      return new Response(`${JSON.stringify(openAiError(502, 'Ollama sent a chat answer that is not JSON'))}\n`, { status: 502, headers });
    }
    return new Response(`${JSON.stringify(completionOf(parsed as NativeChatResponse))}\n`, { status: 200, headers });
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const source = upstream.body?.getReader();
  const ok = upstream.status === 200;
  const streamed = ok && plan.stream;
  const translator = new StreamTranslator(plan.includeUsage);
  let buffered = '';

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!source) {
        if (!ok) controller.enqueue(encoder.encode(`${JSON.stringify(openAiError(upstream.status, upstream.statusText))}\n`));
        controller.close();
        return;
      }
      for (;;) {
        const next = await source.read();
        if (next.done) {
          buffered += decoder.decode();
          if (ok) {
            const rest = buffered.trim();
            if (rest !== '' && !translator.finished) {
              for (const event of translator.line(rest)) controller.enqueue(encoder.encode(event));
            }
          } else {
            const message = errorMessageOf(buffered) || upstream.statusText;
            controller.enqueue(encoder.encode(`${JSON.stringify(openAiError(upstream.status, message))}\n`));
          }
          controller.close();
          return;
        }
        buffered += decoder.decode(next.value, { stream: true });
        if (!streamed) continue;
        let newline = buffered.indexOf('\n');
        let wrote = false;
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line !== '' && !translator.finished) {
            for (const event of translator.line(line)) {
              controller.enqueue(encoder.encode(event));
              wrote = true;
            }
          }
          newline = buffered.indexOf('\n');
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

  const headers = new Headers({ 'Content-Type': streamed ? 'text/event-stream' : 'application/json' });
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}
