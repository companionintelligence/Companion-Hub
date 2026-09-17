import { Injectable } from '@nestjs/common';
import { INFERENCE_BACKEND_TYPES, type InferenceBackendType } from '@ci-hub/common/types';
import { canonicalModelId } from '@/common/helpers/hub-pool';
import type { PoolDecodeEstimate, PoolPrefillEstimate, PoolThroughputEstimate } from './hub-pool.types';

/**
 * How fast each engine has read prompts and written tokens, per (node, backend, model), for
 * throughput-aware placement.
 *
 * Queue depth and hardware tier cannot tell a GPU node from one serving the same model on CPU, and
 * for a long prompt that is the whole difference. Measured on the fleet, 2026-09-17, with
 * `qwen3-coder:30b`: core-6 (GPU) prefilled a 184 KB (~48k-token) streamed turn at ~496 tok/s and
 * answered in 268 s; fzzy (CPU, `size_vram` 0) read a 10.6k-token turn at ~123 tok/s but produced no
 * first byte for a ~46k-token one inside its 922 s budget, because CPU attention cost grows with the
 * context. Earlier, `qwen3.6:27b` prefilled at ~300 tok/s on GPU nodes and 27–37 tok/s on fzzy and
 * core-7.
 *
 * The evidence is kept pessimistically, because the mistake this exists to avoid costs a whole
 * budget (15 minutes for that turn) while the opposite mistake costs a reorder:
 *
 * - **By prompt size.** A prefill rate is a rate at a size, so evidence sits in bands that double
 *   from {@link THROUGHPUT_MIN_PROMPT_TOKENS}, and a band's point is applied to prompts of that size
 *   and larger only. A node too slow for a smaller prompt is too slow for a larger one; a larger
 *   prompt's rate says little about a smaller one.
 * - **Slower evidence wins at once.** Most agent turns share a cached prefix with the previous one
 *   and reach their first byte in seconds. Averaged in, they would make a CPU node look fast between
 *   the cold turns that time out. So a band keeps its slowest standing evidence and the latest faster
 *   sample apart. The slow evidence holds outright for {@link THROUGHPUT_HOLD_MS}, then gives way to
 *   the faster sample as it decays — however many fast samples arrive. Everything is forgotten after
 *   {@link THROUGHPUT_FORGET_AFTER_MS}, which is also how a demoted node gets tried again.
 * - **Missed deadlines count.** A request that ran out of its budget with no first byte carries no
 *   usage frame, and it is exactly the failure placement exists to avoid repeating, so it is recorded
 *   as "at least this slow".
 *
 * Rates are in estimated tokens (`bytes / 4` of the forwarded body), the unit the budget is sized in.
 * In memory and process-local, like the load counter and the routing log: a restart forgets it.
 */

/**
 * The smallest prompt that counts as prefill evidence, and that placement judges. Below it a wait is
 * mostly fixed cost (a cold model load, the hop), and the 300 s minimum budget is only missed below
 * ~14 tok/s, which no measured fleet node is.
 */
export const THROUGHPUT_MIN_PROMPT_TOKENS = 4096;
/** Size bands double from {@link THROUGHPUT_MIN_PROMPT_TOKENS}; the last one (~524k and up) is open-ended. */
export const THROUGHPUT_PREFILL_BANDS = 8;
/**
 * How long slow evidence is believed outright. It has to hold rather than decay from the first second
 * because a missed deadline is recorded AT its budget — it is a lower bound — so any blending at all
 * would read it back as just inside the budget it missed.
 */
export const THROUGHPUT_HOLD_MS = 30 * 60_000;
/**
 * After the hold, how fast evidence loses its weight. Short on purpose: Ollama decides at load time how
 * much of a model fits in free VRAM, so the same model on the same node can be CPU-bound now and on
 * the GPU after something else unloads.
 */
export const THROUGHPUT_HALF_LIFE_MS = 30 * 60_000;
/** After this, evidence is gone and the node is unmeasured again for that band. */
export const THROUGHPUT_FORGET_AFTER_MS = THROUGHPUT_HOLD_MS + 3 * THROUGHPUT_HALF_LIFE_MS;
/** How many (backend, model) entries a node advertises, and how many of a peer's a reader accepts. */
export const MAX_ADVERTISED_THROUGHPUT = 32;

const MIN_DECODE_TOKENS = 32;
const MIN_DECODE_MS = 500;
const MAX_TRACKED = 512;
const MAX_MODEL_LENGTH = 256;
const MAX_PROMPT_TOKENS = 2 ** 24;
const MAX_TOKENS_PER_SEC = 1_000_000;

export type ThroughputSource = 'observed' | 'advertised';

/** Which engine, on which node, serving which model. `nodeKey` is `local` or a peer row id. */
export interface ThroughputTarget {
  nodeKey: string;
  backend: InferenceBackendType;
  model: string;
}

/** One piece of prefill evidence, or a band's effective reading of it. `at` is this process's clock. */
export interface PrefillPoint {
  msPerToken: number;
  promptTokens: number;
  deadline: boolean;
  at: number;
}

/** What a band remembers: its slowest standing evidence, and the latest faster sample since. */
export interface PrefillBandEvidence {
  slow: PrefillPoint;
  recent: PrefillPoint | null;
}

export interface SourcedPrefillPoint extends PrefillPoint {
  source: ThroughputSource;
}

/** A decayed mean: `tokensPerSecSum / weight`, both decayed together. */
export interface DecodeMean {
  weight: number;
  tokensPerSecSum: number;
  at: number;
}

export interface PrefillPrediction {
  /** Estimated time to the first byte, from the slowest applicable evidence. A lower bound on it for a deadline point. */
  predictedMs: number;
  tokensPerSec: number;
  deadline: boolean;
  source: ThroughputSource;
}

/** The band a prompt of `estimatedTokens` falls in, or `null` below the smallest one. */
export function prefillBand(estimatedTokens: number): number | null {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens < THROUGHPUT_MIN_PROMPT_TOKENS) {
    return null;
  }
  return Math.min(THROUGHPUT_PREFILL_BANDS - 1, Math.floor(Math.log2(estimatedTokens / THROUGHPUT_MIN_PROMPT_TOKENS)));
}

export function prefillBandFloor(band: number): number {
  return THROUGHPUT_MIN_PROMPT_TOKENS * 2 ** band;
}

/** How much slow prefill evidence still counts: all of it through {@link THROUGHPUT_HOLD_MS}, then halving every {@link THROUGHPUT_HALF_LIFE_MS}. */
export function evidenceWeight(at: number, now: number): number {
  return 0.5 ** (Math.max(0, now - at - THROUGHPUT_HOLD_MS) / THROUGHPUT_HALF_LIFE_MS);
}

export function isForgotten(at: number, now: number): boolean {
  return now - at >= THROUGHPUT_FORGET_AFTER_MS;
}

/**
 * Fold a new sample into a band. Evidence at least as slow as the band currently reads replaces it
 * outright. A faster sample only becomes `recent`, replacing any earlier one, so ten cache-hit turns
 * weigh exactly what the last of them does.
 */
export function mergePrefillEvidence(stored: PrefillBandEvidence | undefined, next: PrefillPoint, now: number): PrefillBandEvidence {
  const current = stored ? effectivePrefillPoint(stored, now) : null;
  if (!stored || !current || next.msPerToken >= current.msPerToken) {
    return { slow: next, recent: null };
  }
  return { slow: stored.slow, recent: next };
}

/**
 * What a band reads as now: the slow evidence, blended toward `recent` by how far it has decayed —
 * all of it through the hold, half one half-life later — then `recent` alone once the slow evidence
 * is forgotten, and nothing once both are. The point keeps the slow evidence's size, flag and age, since
 * that is what it mostly still describes.
 */
export function effectivePrefillPoint(evidence: PrefillBandEvidence, now: number): PrefillPoint | null {
  const { slow, recent } = evidence;
  const liveRecent = recent && !isForgotten(recent.at, now) ? recent : null;
  if (isForgotten(slow.at, now)) {
    return liveRecent;
  }
  if (!liveRecent) {
    return slow;
  }
  const weight = evidenceWeight(slow.at, now);
  return { ...slow, msPerToken: weight * slow.msPerToken + (1 - weight) * liveRecent.msPerToken };
}

export function mergeDecode(stored: DecodeMean | undefined, tokensPerSec: number, now: number): DecodeMean {
  if (!stored || isForgotten(stored.at, now)) {
    return { weight: 1, tokensPerSecSum: tokensPerSec, at: now };
  }
  // A mean, not a bound, so it decays from the first second: no hold.
  const decay = 0.5 ** (Math.max(0, now - stored.at) / THROUGHPUT_HALF_LIFE_MS);
  return { weight: stored.weight * decay + 1, tokensPerSecSum: stored.tokensPerSecSum * decay + tokensPerSec, at: now };
}

/**
 * The time to a first byte for a prompt of `estimatedTokens`, from the slowest live point in its band
 * or a smaller one, or `null` when nothing applies — unmeasured, which placement treats as neither
 * fast nor slow.
 */
export function predictPrefill(points: readonly SourcedPrefillPoint[], estimatedTokens: number, now: number): PrefillPrediction | null {
  const band = prefillBand(estimatedTokens);
  if (band === null) {
    return null;
  }
  let slowest: SourcedPrefillPoint | null = null;
  for (const point of points) {
    const pointBand = prefillBand(point.promptTokens);
    if (pointBand === null || pointBand > band || isForgotten(point.at, now)) {
      continue;
    }
    if (!slowest || point.msPerToken > slowest.msPerToken || (point.msPerToken === slowest.msPerToken && point.deadline && !slowest.deadline)) {
      slowest = point;
    }
  }
  if (!slowest) {
    return null;
  }
  return {
    // Whole milliseconds, so a deadline point replayed at its own size lands exactly on its budget
    // rather than a float's width either side of it.
    predictedMs: Math.round(estimatedTokens * slowest.msPerToken),
    tokensPerSec: floorTenth(1000 / slowest.msPerToken),
    deadline: slowest.deadline,
    source: slowest.source,
  };
}

/**
 * Whether a prediction says the node will not reach a first byte within `budgetMs`. A deadline point
 * is a strict lower bound — that request had not started answering when its budget ran out — so
 * reaching the budget exactly already counts as missing it.
 */
export function missesBudget(prediction: PrefillPrediction, budgetMs: number): boolean {
  return prediction.deadline ? prediction.predictedMs >= budgetMs : prediction.predictedMs > budgetMs;
}

/** An advertised or reported estimate turned back into points for {@link predictPrefill}. */
export function prefillPointsOf(estimate: PoolThroughputEstimate, source: ThroughputSource, now: number): SourcedPrefillPoint[] {
  return estimate.prefill.map((point) => ({
    msPerToken: 1000 / point.tokensPerSec,
    promptTokens: point.promptTokens,
    deadline: point.deadline,
    at: now - point.ageMs,
    source,
  }));
}

/**
 * A peer's `throughput` capability as this build will believe it. The jsonb is the peer's to write,
 * so anything malformed is dropped rather than guessed at, band edges are recomputed from the prompt
 * size rather than taken from the wire, and the snapshot's own age is added so evidence ages on our
 * clock between polls.
 *
 * There is no anti-gaming concern that needs more than this: an advertised rate is only ever combined
 * with what this node timed itself by taking the slower, so a peer can make itself look slow (which
 * `acceptingWork: false` already allows) but not fast.
 */
export function readAdvertisedThroughput(raw: unknown, snapshotAgeMs: number): PoolThroughputEstimate[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const extraAgeMs = Number.isFinite(snapshotAgeMs) ? Math.max(0, snapshotAgeMs) : THROUGHPUT_FORGET_AFTER_MS;
  const estimates: PoolThroughputEstimate[] = [];
  for (const item of raw.slice(0, MAX_ADVERTISED_THROUGHPUT)) {
    if (!isRecord(item)) continue;
    const { model, backend } = item;
    if (typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_LENGTH) continue;
    if (!(INFERENCE_BACKEND_TYPES as readonly unknown[]).includes(backend)) continue;
    const bands = new Map<number, PoolPrefillEstimate>();
    for (const rawPoint of Array.isArray(item.prefill) ? item.prefill.slice(0, THROUGHPUT_PREFILL_BANDS) : []) {
      const point = readPrefillPoint(rawPoint, extraAgeMs);
      if (!point) continue;
      const band = prefillBand(point.promptTokens) as number;
      const existing = bands.get(band);
      if (!existing || point.tokensPerSec < existing.tokensPerSec) {
        bands.set(band, point);
      }
    }
    const decode = readDecode(item.decode, extraAgeMs);
    if (bands.size === 0 && decode === null) continue;
    estimates.push({
      model,
      backend: backend as InferenceBackendType,
      prefill: [...bands.entries()].sort(([a], [b]) => a - b).map(([, point]) => point),
      decode,
    });
  }
  return estimates;
}

function readPrefillPoint(raw: unknown, extraAgeMs: number): PoolPrefillEstimate | null {
  if (!isRecord(raw)) return null;
  const { promptTokens, tokensPerSec, ageMs } = raw;
  if (typeof promptTokens !== 'number' || !Number.isInteger(promptTokens) || promptTokens > MAX_PROMPT_TOKENS) return null;
  const band = prefillBand(promptTokens);
  if (band === null || !isRate(tokensPerSec) || !isAge(ageMs)) return null;
  const age = ageMs + extraAgeMs;
  if (age >= THROUGHPUT_FORGET_AFTER_MS) return null;
  return { fromTokens: prefillBandFloor(band), promptTokens, tokensPerSec, deadline: raw.deadline === true, ageMs: Math.round(age) };
}

function readDecode(raw: unknown, extraAgeMs: number): PoolDecodeEstimate | null {
  if (!isRecord(raw) || !isRate(raw.tokensPerSec) || !isAge(raw.ageMs)) return null;
  const age = raw.ageMs + extraAgeMs;
  return age >= THROUGHPUT_FORGET_AFTER_MS ? null : { tokensPerSec: raw.tokensPerSec, ageMs: Math.round(age) };
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_TOKENS_PER_SEC;
}

function isAge(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rounded down, so a rate that crossed the wire can only read slower than the one measured. The epsilon absorbs `1000 / (1000 / x)`. */
function floorTenth(value: number): number {
  return Math.floor(value * 10 + 1e-9) / 10;
}

interface TrackedThroughput {
  target: ThroughputTarget;
  prefill: (PrefillBandEvidence | undefined)[];
  decode: DecodeMean | undefined;
}

@Injectable()
export class HubPoolThroughputService {
  /** Insertion order is recency order: every write re-inserts, so the first key is the one to evict. */
  private readonly tracked = new Map<string, TrackedThroughput>();

  /** A prompt of `promptTokens` reached its first byte after `ms` — or, with `deadline`, had not after `ms`. */
  recordPrefill(target: ThroughputTarget, sample: { promptTokens: number; ms: number; deadline: boolean }, now = Date.now()): void {
    const band = prefillBand(sample.promptTokens);
    if (band === null || !Number.isFinite(sample.ms) || sample.ms <= 0) {
      return;
    }
    const entry = this.touch(target, now);
    entry.prefill[band] = mergePrefillEvidence(
      entry.prefill[band],
      { msPerToken: sample.ms / sample.promptTokens, promptTokens: sample.promptTokens, deadline: sample.deadline, at: now },
      now,
    );
  }

  /** `tokens` engine tokens were generated over `ms`. Too short a generation measures scheduling, not decode, and is ignored. */
  recordDecode(target: ThroughputTarget, sample: { tokens: number; ms: number }, now = Date.now()): void {
    if (!Number.isFinite(sample.tokens) || !Number.isFinite(sample.ms) || sample.tokens < MIN_DECODE_TOKENS || sample.ms < MIN_DECODE_MS) {
      return;
    }
    const entry = this.touch(target, now);
    entry.decode = mergeDecode(entry.decode, (sample.tokens / sample.ms) * 1000, now);
  }

  /** Live prefill points this node has timed for one engine and model. */
  prefillPoints(target: ThroughputTarget, now = Date.now()): SourcedPrefillPoint[] {
    const entry = this.tracked.get(keyOf(target));
    if (!entry) {
      return [];
    }
    return entry.prefill.flatMap((evidence) => {
      const point = evidence ? effectivePrefillPoint(evidence, now) : null;
      return point ? [{ ...point, source: 'observed' as const }] : [];
    });
  }

  /** Everything timed for one node, as status and the capability advert report it. Newest-touched first, capped at {@link MAX_ADVERTISED_THROUGHPUT}. */
  estimatesFor(nodeKey: string, now = Date.now()): PoolThroughputEstimate[] {
    const estimates: PoolThroughputEstimate[] = [];
    for (const entry of [...this.tracked.values()].reverse()) {
      if (entry.target.nodeKey !== nodeKey) continue;
      const estimate = describe(entry, now);
      if (estimate) estimates.push(estimate);
      if (estimates.length === MAX_ADVERTISED_THROUGHPUT) break;
    }
    return estimates;
  }

  private touch(target: ThroughputTarget, now: number): TrackedThroughput {
    const key = keyOf(target);
    const existing = this.tracked.get(key);
    if (existing) {
      this.tracked.delete(key);
      this.tracked.set(key, existing);
      return existing;
    }
    // Room is made before the new entry goes in, so eviction can never pick the one being written.
    if (this.tracked.size >= MAX_TRACKED) {
      this.evict(now);
    }
    const entry: TrackedThroughput = { target: { ...target, model: canonicalModelId(target.model) }, prefill: [], decode: undefined };
    this.tracked.set(key, entry);
    return entry;
  }

  /** Dead entries first (an unpaired peer's, a model no longer served), then the least recently measured. */
  private evict(now: number): void {
    for (const [key, entry] of this.tracked) {
      if (!describe(entry, now)) this.tracked.delete(key);
    }
    for (const key of this.tracked.keys()) {
      if (this.tracked.size < MAX_TRACKED) break;
      this.tracked.delete(key);
    }
  }
}

function keyOf(target: ThroughputTarget): string {
  return `${target.nodeKey} ${target.backend} ${canonicalModelId(target.model)}`;
}

function describe(entry: TrackedThroughput, now: number): PoolThroughputEstimate | null {
  const prefill = entry.prefill.flatMap((evidence, band): PoolPrefillEstimate[] => {
    const point = evidence ? effectivePrefillPoint(evidence, now) : null;
    return point
      ? [
          {
            fromTokens: prefillBandFloor(band),
            promptTokens: point.promptTokens,
            tokensPerSec: floorTenth(1000 / point.msPerToken),
            deadline: point.deadline,
            ageMs: Math.round(now - point.at),
          },
        ]
      : [];
  });
  const decode =
    entry.decode && !isForgotten(entry.decode.at, now)
      ? { tokensPerSec: floorTenth(entry.decode.tokensPerSecSum / entry.decode.weight), ageMs: Math.round(now - entry.decode.at) }
      : null;
  if (prefill.length === 0 && decode === null) {
    return null;
  }
  return { model: entry.target.model, backend: entry.target.backend, prefill, decode };
}
