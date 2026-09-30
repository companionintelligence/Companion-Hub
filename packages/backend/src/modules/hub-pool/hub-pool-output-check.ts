/**
 * Whether a generation an engine answered 200 for actually finished, and actually said anything.
 *
 * The pool judged an engine only by its status. core-2, 2026-09-29 (fleet run bank0929, 15 leaves):
 * its local Ollama 0.34.0 was misconfigured and answered `gemma4:e4b` turns with nothing but
 * `<unused49>` tokens, and its streams ended without Ollama's closing `{"done":true}` frame — no
 * `done_reason`, no eval counts — while its non-streamed bodies came back `done: false`. Every one of
 * those was a 200, so 167 of 237 local gemma4 chat rows were garbage or cut off while the routing
 * summary read served=895 failed=0 failovers=0, nothing was ever struck against the engine, and
 * `poolLocalAffinity` sent every retry from Hermes, OpenClaw and Memory straight back to it.
 *
 * Two checks, both narrow on purpose, because a false positive fails a request another node would
 * have served no better, and — once struck — moves a healthy engine to the back of the walk:
 *
 * - **The terminal marker.** Every dialect the pool relays ends a completed generation with a frame
 *   that says so: Ollama's native routes with `done: true` (on the last NDJSON line, or on the one
 *   non-streamed body), the OpenAI-compatible routes with `data: [DONE]` or a choice whose
 *   `finish_reason` is set (or, non-streamed, `choices[0].finish_reason`). A response in the dialect
 *   without one was cut off upstream. A body that is not recognisably the dialect at all is not
 *   judged: this checks that an answer finished, not that an engine speaks the schema. Token usage is
 *   deliberately NOT a signal — correct peer streams in the same run carried none.
 * - **Placeholder-only output.** The first {@link DEGENERATE_SCAN_CHARS} characters of generated
 *   text consisting of nothing but `<unusedN>` tokens. Those are Gemma's reserved vocabulary: slots a
 *   healthy model is never trained to emit, so a run of nothing else is an engine or weights fault,
 *   never an answer. A model that merely mentions one among other text is not matched.
 *
 * Streams are judged as they pass through, reading only the first slice of generated text and the
 * last line, so nothing here holds a stream in memory. Both verdicts are the NODE's fault, not the
 * caller's, which is why they are recorded as `requestError.basis: 'node'`.
 */

import type { InferenceBackendType } from '@ci-hub/common/types';
import { TransformStream, type ReadableStream } from 'node:stream/web';
import { ServingQuarantine, STRIKE_WINDOW_MS, type QuarantineDecision } from '@/modules/inference/backends/serving-quarantine';
import { canonicalModelId } from '@/common/helpers/hub-pool';
import type { PoolCandidate } from './hub-pool.types';

/** Which completion dialect a routed path answers in. */
export type OutputDialect = 'ollama-native' | 'openai';

/** What was wrong with a 200 an engine answered, as the routing log labels it. */
export type PoolOutputFault = 'truncated-upstream' | 'degenerate-output';

/** Every {@link PoolOutputFault}, for a reader that has only the label. */
export const POOL_OUTPUT_FAULTS: ReadonlySet<PoolOutputFault> = new Set<PoolOutputFault>(['truncated-upstream', 'degenerate-output']);

/** How much generated text is read before the placeholder check is decided. */
export const DEGENERATE_SCAN_CHARS = 256;

/** Longest line kept for the terminal check. Ollama's final line is a few hundred bytes of counters. */
const MAX_LINE_CHARS = 64 * 1024;

/** Largest non-streamed body judged whole. A chat completion is kilobytes; past this it is relayed unjudged. */
export const MAX_JUDGED_BODY_BYTES = 4 * 1024 * 1024;

/** One or more reserved-vocabulary placeholders and nothing else. */
const PLACEHOLDER_TOKENS_ONLY = /^(\s*<unused\d+>)+\s*$/;

/** `finish_reason` set to a string, on an SSE frame's raw text: a key, not escaped text, since content is a quoted string there. */
const FINISH_REASON_SET = /"finish_reason"\s*:\s*"/;

/** The completion routes and the dialect each answers in; anything else — embeddings, metadata — is never judged. */
export function outputDialectOf(path: string): OutputDialect | null {
  if (path === '/api/chat' || path === '/api/generate') return 'ollama-native';
  if (path === '/v1/chat/completions' || path === '/v1/completions') return 'openai';
  return null;
}

/**
 * Whether the start of a generation is placeholder tokens and nothing else. Reads the first
 * {@link DEGENERATE_SCAN_CHARS} characters, and drops a placeholder the cut left half-read, so a run
 * of `<unused49>` cut mid-token still matches. Empty text — a turn that only calls tools — does not.
 */
export function isDegenerateText(text: string): boolean {
  const head = text.slice(0, DEGENERATE_SCAN_CHARS).replace(/<[^>]*$/, '');
  return PLACEHOLDER_TOKENS_ONLY.test(head);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(...values: unknown[]): string {
  return values.filter((value): value is string => typeof value === 'string').join('');
}

/**
 * The generated text in one parsed frame or body: the answer and any reasoning, which a degenerate
 * engine fills with placeholders just the same. Never the prompt, which is not in a response.
 */
export function generatedTextOf(dialect: OutputDialect, frame: unknown): string {
  if (!isRecord(frame)) return '';
  if (dialect === 'ollama-native') {
    const message = isRecord(frame.message) ? frame.message : {};
    return strings(message.thinking, message.content, frame.thinking, frame.response);
  }
  const choice = Array.isArray(frame.choices) && isRecord(frame.choices[0]) ? frame.choices[0] : null;
  if (!choice) return '';
  const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : {};
  return strings(delta.reasoning_content, delta.reasoning, delta.content, choice.text);
}

/**
 * A response's verdict. `fault` is what was wrong, if anything; `complete` is whether it was
 * recognisably the dialect AND finished cleanly, which is the evidence that clears an engine's strikes.
 * Both false/null means nothing could be judged: not the dialect, or a line too long to keep.
 */
export interface OutputVerdict {
  fault: PoolOutputFault | null;
  complete: boolean;
}

const UNJUDGED: OutputVerdict = { fault: null, complete: false };

function verdictOf(terminal: boolean | null, degenerate: boolean): OutputVerdict {
  if (degenerate) return { fault: 'degenerate-output', complete: false };
  if (terminal === false) return { fault: 'truncated-upstream', complete: false };
  return { fault: null, complete: terminal === true };
}

/** Whether a parsed body is a finished one in its dialect: `true`, `false`, or `null` for a body that is not the dialect's. */
function bodyTerminal(dialect: OutputDialect, body: unknown): boolean | null {
  if (!isRecord(body)) return null;
  if (dialect === 'ollama-native') {
    return typeof body.done === 'boolean' ? body.done : null;
  }
  const first = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (!isRecord(first)) return null;
  return first.finish_reason !== null && first.finish_reason !== undefined;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A whole non-streamed body's verdict. */
export function judgeWholeBody(dialect: OutputDialect, text: string): OutputVerdict {
  const body = parse(text);
  const terminal = bodyTerminal(dialect, body);
  if (terminal === null) return UNJUDGED;
  return verdictOf(terminal, isDegenerateText(generatedTextOf(dialect, body)));
}

/**
 * Judges a response as it passes through, without holding it: {@link tap} wraps the body, and once
 * the body has ENDED — never for one the client or the upstream cut — {@link verdict} says what it
 * was. A streamed body is read line by line for the first slice of generated text and its last line;
 * a non-streamed one, which the inbound relay passes through rather than holding, is kept whole up to
 * {@link MAX_JUDGED_BODY_BYTES} and judged at the end.
 */
export class OutputJudge {
  private lineBuffer = '';
  private lineOverflowed = false;
  /** The last complete non-empty line, or `null` when it was too long to keep (and so cannot be read). */
  private lastLine: string | null = null;
  private scanned = '';
  private scanDone = false;
  /** Ollama: a frame carried `done`. OpenAI: a `data:` frame was seen. Either way the stream is the dialect. */
  private recognised = false;
  /** OpenAI: `[DONE]` or a set `finish_reason` was seen. */
  private finished = false;
  private whole = '';
  private wholeOverflowed = false;
  private ended: OutputVerdict | null = null;

  constructor(
    private readonly dialect: OutputDialect,
    private readonly streaming: boolean,
  ) {}

  /** The body with the judge reading it on the way past. Every chunk reaches the reader unchanged. */
  tap(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    return source.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          controller.enqueue(chunk);
          this.guard(() => this.push(decoder.decode(chunk, { stream: true })));
        },
        flush: () => {
          this.guard(() => this.push(decoder.decode()));
          this.guard(() => {
            this.ended = this.finish();
          });
        },
      }),
    );
  }

  /** The verdict on a body that ended; `null` while it is still flowing or when it was cut. */
  verdict(): OutputVerdict | null {
    return this.ended;
  }

  /** A judging failure must never reach the client's copy of the response, already enqueued: it leaves no verdict. */
  private guard(step: () => void): void {
    try {
      step();
    } catch {
      // Nothing judged is the honest answer, and the response is unaffected.
    }
  }

  private push(text: string): void {
    if (!text) return;
    if (!this.streaming) {
      if (!this.wholeOverflowed) {
        this.whole += text;
        if (this.whole.length > MAX_JUDGED_BODY_BYTES) {
          this.whole = '';
          this.wholeOverflowed = true;
        }
      }
      return;
    }
    this.lineBuffer += text;
    for (let index = this.lineBuffer.indexOf('\n'); index !== -1; index = this.lineBuffer.indexOf('\n')) {
      const line = this.lineBuffer.slice(0, index);
      this.lineBuffer = this.lineBuffer.slice(index + 1);
      if (this.lineOverflowed) {
        // The tail of a line too long to keep: nothing about it can be read, so neither can the
        // stream's last line until another complete one arrives.
        this.lineOverflowed = false;
        this.lastLine = null;
        continue;
      }
      this.line(line);
    }
    if (this.lineBuffer.length > MAX_LINE_CHARS) {
      this.lineBuffer = '';
      this.lineOverflowed = true;
      this.lastLine = null;
    }
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    this.lastLine = line;
    if (this.dialect === 'openai') {
      // SSE: `data:` frames only. Comments (`: ping`) and `event:` lines say nothing about the answer.
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      this.recognised = true;
      if (data === '[DONE]') {
        this.finished = true;
        return;
      }
      if (FINISH_REASON_SET.test(data)) {
        this.finished = true;
      }
      if (!this.scanDone) this.scan(parse(data));
      return;
    }
    if (!this.scanDone) {
      const frame = parse(line);
      if (isRecord(frame) && typeof frame.done === 'boolean') this.recognised = true;
      this.scan(frame);
    }
  }

  private scan(frame: unknown): void {
    this.scanned += generatedTextOf(this.dialect, frame);
    if (this.scanned.length >= DEGENERATE_SCAN_CHARS) {
      this.scanDone = true;
    }
  }

  private finish(): OutputVerdict {
    if (!this.streaming) {
      return this.wholeOverflowed ? UNJUDGED : judgeWholeBody(this.dialect, this.whole);
    }
    // A last line with no newline after it is still the last line.
    if (!this.lineOverflowed && this.lineBuffer.trim()) {
      this.line(this.lineBuffer);
    }
    const degenerate = isDegenerateText(this.scanned);
    if (this.dialect === 'openai') {
      if (this.recognised) return verdictOf(this.finished, degenerate);
      // An engine that ignored `stream: true` and answered one JSON body.
      return this.lastLine === null ? UNJUDGED : judgeWholeBody(this.dialect, this.lastLine);
    }
    if (!this.recognised || this.lastLine === null) {
      return degenerate ? verdictOf(null, true) : UNJUDGED;
    }
    const last = parse(this.lastLine);
    // A final line that is not an object — cut mid-JSON — is as unfinished as one saying `done: false`.
    return verdictOf(isRecord(last) && last.done === true, degenerate);
  }
}

/** Which engine an output strike is held against: a node (`local` or a peer id), one of its engines, one model. */
export interface OutputTarget {
  nodeKey: string;
  backend: InferenceBackendType;
  model: string;
}

/**
 * Engines that have been answering with {@link PoolOutputFault}s, per node, engine and model, and the
 * cooldown each is withheld for — the pool's own {@link ServingQuarantine}, keyed per target.
 *
 * Separate from the quarantine each Ollama backend keeps for itself, on purpose. That one withholds
 * a model an engine cannot LOAD (`model failed to load`), and it is cleared by anything showing the
 * model can run: a 200 at the headers, or the model appearing in `/api/ps`. A model answering
 * placeholder tokens is loaded, resident and answering 200 — both would clear it on the next
 * request. And it only exists for a local Ollama, where this has to cover every engine on every node.
 *
 * The same policy, because the same trade applies: two faults inside {@link STRIKE_WINDOW_MS} withhold
 * the engine for a minute, doubling to fifteen while it keeps failing its re-probe, and one clean
 * complete answer clears it outright.
 */
export class PoolOutputQuarantine {
  private readonly quarantine: ServingQuarantine;
  /**
   * Engines withheld at least once since their last clean answer — still inside a cooldown or
   * waiting for the re-probe after one — so the answer that clears them can say they are back.
   */
  private readonly withheldSinceClean = new Set<string>();

  constructor(now?: () => number) {
    this.quarantine = new ServingQuarantine(now);
  }

  /** One key per engine and model, the model folded as `sameModelId` compares, so `m` and `m:latest` share a record. */
  private keyOf(target: OutputTarget): string {
    return `${target.nodeKey}\n${target.backend}\n${canonicalModelId(target.model)}`;
  }

  /** Record one faulty answer. `withheld` is true on the answer that withheld the engine. */
  strike(target: OutputTarget, fault: PoolOutputFault): QuarantineDecision {
    const key = this.keyOf(target);
    const decision = this.quarantine.recordFailure(key, fault);
    if (decision.withheld) {
      this.withheldSinceClean.add(key);
    }
    return decision;
  }

  /** Record one clean, complete answer. True when the engine had been withheld since its last one. */
  clear(target: OutputTarget): boolean {
    const key = this.keyOf(target);
    this.quarantine.recordSuccess(key);
    return this.withheldSinceClean.delete(key);
  }

  isWithheld(target: OutputTarget): boolean {
    return this.quarantine.isWithheld(this.keyOf(target));
  }

  /** Nothing tracked at all — the check that keeps the request path from asking about every candidate for nothing. */
  isEmpty(): boolean {
    return this.quarantine.isEmpty() && this.withheldSinceClean.size === 0;
  }
}

/**
 * Move every withheld candidate behind every candidate that is not, each group in the order it came.
 *
 * Applied after every placement step and the pin, so nothing — the local node's affinity head start
 * included, which is what kept sending core-2's retries to its own broken engine — puts a withheld
 * engine ahead of a healthy one. The same rules as every placement step, because a preference must
 * never become a refusal:
 *
 * 1. **Demoted, never removed.** A withheld engine is still tried once every healthy candidate has
 *    failed, so an engine whose strikes were a fluke still answers when nothing else can.
 * 2. **All withheld means nothing moves**: the list comes back as it was.
 *
 * Pure and exported for its own test, like `applyPin`.
 */
export function applyOutputQuarantine(
  ordered: PoolCandidate[],
  isWithheld: (candidate: PoolCandidate) => boolean,
): { candidates: PoolCandidate[]; withheld: PoolCandidate[] } {
  const withheld = ordered.filter(isWithheld);
  if (withheld.length === 0 || withheld.length === ordered.length) {
    return { candidates: ordered, withheld: [] };
  }
  return { candidates: [...ordered.filter((candidate) => !withheld.includes(candidate)), ...withheld], withheld };
}

/** A fault in the words an operator reads in a log line. */
export function describeOutputFault(fault: PoolOutputFault): string {
  return fault === 'degenerate-output'
    ? 'degenerate output (only <unusedN> placeholder tokens)'
    : "a truncated response (it ended without the dialect's final frame)";
}

export { STRIKE_WINDOW_MS };
