/**
 * Paired A/B benchmark methodology, as code.
 *
 * Raw tokens/sec across two backends is close to meaningless: it is dominated by the prompt, the
 * machine's mood, which arm happened to run first, and which build reported the numbers. UPLIFT is
 * the metric — and an uplift is a RATIO, which means a pairing has to exist before any ratio may be
 * computed at all. Every rule below exists because breaking it produced a number that had to be
 * withdrawn.
 *
 * Those rules were previously enforced by four separate benchmark scripts, each re-implementing the
 * same discipline slightly differently, which is how one of them ended up comparing an acceptance
 * figure on gfx1151 against one on gfx1100 that used a different denominator and concluding the
 * hardware had collapsed. This module is the single place they live, and it is PURE — it takes
 * numbers and returns verdicts, opens no socket, and reads no clock. A driver process supplies the
 * measurements.
 *
 * The four things it refuses to do, because each one is a withdrawn result:
 *
 *   1. Report a scalar uplift.  `summarizeByContentClass` returns `overall: null` and a sentence
 *      saying why, ALWAYS — even when every content class agrees. A per-target uplift number only
 *      ever described the prompt mix it was computed over: on one unchanged machine, code prompts
 *      ran 1.57x-3.65x and prose ~1.0 or slightly slower.
 *   2. Call a difference real when the paired ratios straddle 1.0.  That means the arms swapped
 *      places between rounds; the honest reading is "no measured difference", not a smaller one.
 *   3. Compare two acceptance rates whose denominators differ.  One build reports
 *      `accepted/(steps x 16)`; another reports `accepted/emitted`. Measured with the same prompt
 *      and the same 36 completion tokens on both: one returned `accept_rate: 0.515625` and the other
 *      returned `accept_rate: 32.0`. The second is a COUNT.
 *   4. Pool samples from different prompts, or from different content classes, into one range.
 *
 * And the rule that governs failures: A FAILED ARM IS NOT A SLOW ARM. A timeout, a transport error
 * or a refusal must never enter the arithmetic as a large duration or a zero rate — it voids its
 * PAIR and is counted in `droppedPairs`. See `pairPerPrompt`.
 *
 * Nothing here is speculative-decode-specific except the acceptance section. The arm machinery is
 * "two configurations of one server, measured against each other", which is equally a drafter
 * on/off comparison, a flag sweep, or two endpoints on one machine.
 */

// ─── Content classes ──────────────────────────────────────────────────────────

/**
 * What kind of text a prompt makes the model emit.
 *
 * This is load-bearing, not taxonomy for its own sake: acceptance and uplift vary more across
 * content class than across hardware, so a run that reports one number for a target is reporting its
 * own prompt mix under a hardware label.
 */
export type BenchContentClass =
  /** Natural-language sentences and paragraphs. The LOWEST-acceptance class measured. */
  | 'prose'
  /** An enumeration, one item per line. Predictable framing around unpredictable items. */
  | 'list'
  /** Source code, or a continuation of it. */
  | 'code'
  /** A markdown table — heavy fixed structure: pipes, dashes, alignment rows. */
  | 'table'
  /** A JSON document. The HIGHEST-acceptance class measured: quoting, braces and keys are forced. */
  | 'json'
  /** Deliberately uncontrolled, or several classes at once. Never pooled with the five above. */
  | 'mixed'
  /**
   * Nothing is generated: embeddings, envelope/protocol probes, tokenizer edges. Acceptance and
   * decode rate are UNDEFINED here, not zero — such a prompt is excluded from a throughput or
   * acceptance report rather than contributing a 0.
   */
  | 'none';

export const BENCH_CONTENT_CLASSES: readonly BenchContentClass[] = ['prose', 'list', 'code', 'table', 'json', 'mixed', 'none'];

/**
 * The five classes that are comparable TO EACH OTHER: a matched set that differs in output kind and
 * nothing else. `mixed` and `none` are deliberately absent — pooling either back in is how a
 * content-class report turns into the single number this whole axis exists to prevent.
 */
export const COMPARABLE_BENCH_CONTENT_CLASSES: readonly BenchContentClass[] = ['prose', 'list', 'code', 'table', 'json'];

/** `mixed` is the fallback rather than a throw: a caller's own prompt cannot know what class it will provoke. */
export function benchContentClassOf(value: unknown): BenchContentClass {
  return typeof value === 'string' && (BENCH_CONTENT_CLASSES as readonly string[]).includes(value) ? (value as BenchContentClass) : 'mixed';
}

/** True when this class may be compared against another class's number at all. */
export function isComparableBenchClass(c: BenchContentClass): boolean {
  return COMPARABLE_BENCH_CONTENT_CLASSES.includes(c);
}

// ─── Arms ─────────────────────────────────────────────────────────────────────

/**
 * One configuration of one server. Two arms differ ONLY in `params` — same target, same backend,
 * same model, same prompt, same budget. Anything else that differs is a confound, and there is a
 * withdrawn result for each of the obvious ones (a machine that was busy for one arm; a speculative
 * arm that silently offloaded four fewer transformer layers than its baseline).
 */
export interface BenchArm {
  id: string;
  label: string;
  /** WHY this arm exists and what it changes. Required — an unexplained arm is an unreadable result. */
  why: string;
  /** Merged into the request body for this arm. The ONLY thing allowed to differ between arms. */
  params: Record<string, unknown>;
}

/**
 * Parameter values that LOOK like a control arm and are not.
 *
 * A drafter depth of zero is not a documented off switch on any known backend, so a benchmark that
 * uses it as the "off" arm risks comparing speculation against speculation and reporting a bogus
 * 1.0x. Only an explicit mode string, or the absence of the drafter parameter entirely, is a
 * control. The case that was measured, `max_draft: 0` on the retired mlx-dspark runner, silently
 * coerced to `auto`; that engine is gone and so is its entry here.
 */
export const SPEC_OFF_TRAPS: readonly { param: string; value: unknown; why: string }[] = [
  {
    param: 'num_draft',
    value: 0,
    why: 'A drafter depth of zero is not a documented off switch on any known backend; omit the parameter instead.',
  },
];

/**
 * Refuse an "off" arm that is not actually off. Returns the problems rather than throwing, so a
 * caller can report all of them at once.
 */
export function validateControlArm(arm: BenchArm): string[] {
  const problems: string[] = [];
  for (const trap of SPEC_OFF_TRAPS) {
    if (arm.params[trap.param] === trap.value) problems.push(`arm '${arm.id}' sets ${trap.param}: ${JSON.stringify(trap.value)} — ${trap.why}`);
  }
  return problems;
}

// ─── Interleaved scheduling ───────────────────────────────────────────────────

/** One request the runner will make. `warmup: true` slots are dispatched and then discarded. */
export interface ScheduleSlot {
  /** 0-based round. Every round visits every prompt. `-1` marks a warm-up. */
  rep: number;
  promptId: string;
  armId: string;
  /** Position in the whole ordered run — the runner must dispatch in this order and serially. */
  seq: number;
  /** Discarded from analysis. A cold model load otherwise lands entirely in whichever arm ran first. */
  warmup: boolean;
}

export interface ScheduleOptions {
  promptIds: readonly string[];
  arms: readonly BenchArm[];
  /** Rounds after warm-up. Two is the minimum that can produce a spread; three is a sensible default. */
  reps: number;
  /**
   * Flip arm order on odd rounds (A/B then B/A). Default true.
   *
   * One machine's uplift result had to be discounted because its arms were not counterbalanced — the
   * treatment always ran first against a monotonic upward drift, which inflated one prompt's ratio
   * and deflated two others. Alternating arms WITHIN the round keeps them adjacent in time;
   * alternating the ORDER between rounds is what stops a per-round warming trend loading one arm.
   */
  counterbalance?: boolean;
  /** One discarded call per (prompt, arm) at the head of the run. Default true. */
  warmup?: boolean;
}

/**
 * The order the requests must go out in.
 *
 * The shape is: for each round, for each prompt, ALL arms back-to-back. That adjacency is the whole
 * point — a baseline arm measured hours from its comparison arm read 21.9-61.5 tok/s against
 * 88.6-121.8 tok/s for the same model in the same mode, and that ~2x of load drift was published as
 * a 3.50x uplift. Arms adjacent in time see the same machine.
 */
export function interleavedSchedule(opts: ScheduleOptions): ScheduleSlot[] {
  const { promptIds, arms } = opts;
  const reps = Math.max(1, Math.floor(opts.reps));
  const counterbalance = opts.counterbalance !== false;
  const warmup = opts.warmup !== false;
  if (arms.length < 2) throw new Error(`interleavedSchedule needs at least 2 arms, got ${arms.length}`);
  if (promptIds.length === 0) throw new Error('interleavedSchedule needs at least one prompt');

  const slots: ScheduleSlot[] = [];
  let seq = 0;
  if (warmup) {
    // Warm-up is per (prompt, arm) and sits at the head, not interleaved with measurement. It exists
    // to pay the model-load and cache costs once, where they belong to nobody's arm.
    for (const promptId of promptIds) {
      for (const arm of arms) slots.push({ rep: -1, promptId, armId: arm.id, seq: seq++, warmup: true });
    }
  }
  for (let rep = 0; rep < reps; rep++) {
    // Counterbalancing reverses arm order on odd rounds so that "ran first" is not a property of one
    // arm across the run.
    const order = counterbalance && rep % 2 === 1 ? [...arms].reverse() : arms;
    for (const promptId of promptIds) {
      for (const arm of order) slots.push({ rep, promptId, armId: arm.id, seq: seq++, warmup: false });
    }
  }
  return slots;
}

/**
 * Check a schedule against the rules, so a hand-built or reordered one cannot quietly break them.
 * Returns problems rather than throwing — a caller reporting three violations at once is more useful
 * than one that stops at the first.
 */
export function validateSchedule(slots: readonly ScheduleSlot[], armIds: readonly string[]): string[] {
  const problems: string[] = [];
  const measured = slots.filter((s) => !s.warmup);
  if (measured.length === 0) return ['schedule contains no measured slots — every slot is a warm-up'];

  // Warm-ups must precede every measurement: a warm-up in the middle is just an unlabelled sample.
  const lastWarmup = slots.reduce((acc, s, i) => (s.warmup ? i : acc), -1);
  const firstMeasured = slots.findIndex((s) => !s.warmup);
  if (lastWarmup > firstMeasured) problems.push(`a warm-up slot (index ${lastWarmup}) runs after the first measured slot (index ${firstMeasured})`);

  // Arms must be adjacent within a (rep, prompt) cell.
  // Keyed by rep+prompt, but the key is never parsed back apart — the cell carries its own labels,
  // because a prompt id containing the separator would otherwise split into the wrong pieces.
  const cells = new Map<string, { rep: number; promptId: string; slots: ScheduleSlot[] }>();
  for (const s of measured) {
    const key = `${s.rep}::${s.promptId}`;
    const cell = cells.get(key);
    if (cell) cell.slots.push(s);
    else cells.set(key, { rep: s.rep, promptId: s.promptId, slots: [s] });
  }
  for (const { rep, promptId, slots: list } of cells.values()) {
    const seqs = list.map((s) => s.seq).sort((a, b) => a - b);
    const contiguous = seqs.every((v, i) => i === 0 || v === (seqs[i - 1] ?? Number.NaN) + 1);
    if (!contiguous) {
      problems.push(
        `rep ${rep} prompt '${promptId}': arms are not adjacent in time (seq ${seqs.join(', ')}) — this is the sequential-arms failure that produced a bogus 3.50x`,
      );
    }
    const present = new Set(list.map((s) => s.armId));
    const missing = armIds.filter((a) => !present.has(a));
    if (missing.length)
      problems.push(`rep ${rep} prompt '${promptId}': missing arm(s) ${missing.join(', ')} — an unpaired sample cannot become a ratio`);
  }
  return problems;
}

// ─── Serialization ────────────────────────────────────────────────────────────

/**
 * One measurement at a time, per target.
 *
 * A noise-floor check running alongside a benchmark on one machine produced a perfect alternating
 * 5.9 / 16.1 / 5.9 / 15.8 / 5.9 s pattern, which was published as a 3.7x noise floor and was
 * entirely self-inflicted. This is the guard that makes that impossible rather than a rule someone
 * remembers. It is deliberately per-key, because two DIFFERENT machines may be measured at the same
 * time without interfering.
 */
export class SerialGuard {
  #held = new Set<string>();

  /** Throws if `key` is already being measured. The throw is the point: silently queueing hides the mistake. */
  acquire(key: string, what: string): void {
    if (this.#held.has(key)) {
      throw new Error(
        `refusing to start '${what}' on ${key}: a measurement is already running there. Two concurrent measurements on one target corrupt both (see the bogus 3.7x noise floor).`,
      );
    }
    this.#held.add(key);
  }

  release(key: string): void {
    this.#held.delete(key);
  }

  held(): string[] {
    return [...this.#held];
  }
}

// ─── Noise floor ──────────────────────────────────────────────────────────────

/** The same call, this many times. Fewer than this and the floor is a guess. */
export const NOISE_FLOOR_MIN_SAMPLES = 5;

export interface NoiseFloor {
  n: number;
  min: number;
  max: number;
  /** max / min. 1.0 is a perfectly stable machine; one quiet control machine still measured 2.0x on an identical call. */
  spreadRatio: number | null;
  samples: number[];
  /** Whether `n` reached NOISE_FLOOR_MIN_SAMPLES. A floor from 2 samples is reported, and labelled. */
  sufficient: boolean;
  note: string;
}

/**
 * The machine's own variance on an IDENTICAL call. Everything smaller than this is not a finding.
 *
 * Take the samples with the same prompt, same arm, same everything, back to back, before any arm
 * runs. A 1.31x gap inside a 2.0x noise band was once published as "runner A is 31 % slower than
 * runner B"; paired interleaving later gave 0.76-1.03x, i.e. nothing.
 */
export function noiseFloor(samples: readonly number[]): NoiseFloor {
  const usable = samples.filter((v) => Number.isFinite(v) && v > 0);
  if (usable.length === 0) {
    return {
      n: 0,
      min: Number.NaN,
      max: Number.NaN,
      spreadRatio: null,
      samples: [],
      sufficient: false,
      note: 'no usable samples — the noise floor is unmeasured, so no difference can be called real',
    };
  }
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const sufficient = usable.length >= NOISE_FLOOR_MIN_SAMPLES;
  return {
    n: usable.length,
    min,
    max,
    spreadRatio: usable.length >= 2 ? max / min : null,
    samples: [...usable],
    sufficient,
    note: sufficient
      ? `${usable.length} identical calls spanned ${min.toFixed(3)}-${max.toFixed(3)} (${(max / min).toFixed(3)}x)`
      : `only ${usable.length} identical call(s) — ${NOISE_FLOOR_MIN_SAMPLES} are needed; treat this floor as a lower bound on the real one`,
  };
}

// ─── Samples and pairing ──────────────────────────────────────────────────────

/**
 * One measured request. `value` is whatever quantity is being compared — tokens/sec, or a duration.
 * Which one it is lives in `PairOptions.higherIsBetter`, once, rather than being implied per call
 * site, because getting it backwards silently inverts every verdict in the report.
 */
export interface BenchSample {
  rep: number;
  promptId: string;
  contentClass: BenchContentClass;
  armId: string;
  /**
   * Null when the request failed. A FAILED ARM IS NOT A SLOW ARM: the caller must pass null here for
   * a timeout, a transport error or a refusal, never the elapsed time before the abort and never a
   * zero rate. A failed sample voids its PAIR, never just itself.
   */
  value: number | null;
  /** Carried through to the report so a reader can see the raw evidence. */
  tokens?: number | null;
  durationMs?: number | null;
  ttftMs?: number | null;
  error?: string | null;
}

export interface PairOptions {
  /** The arm whose value goes on top of the ratio — normally the treatment (drafter ON). */
  numeratorArmId: string;
  /** The control arm. */
  denominatorArmId: string;
  /** True for a rate (tok/s), false for a duration. Determines what a ratio above 1 MEANS. */
  higherIsBetter: boolean;
  /** The target's measured floor, as a spread ratio. Null = unmeasured, and then nothing can be called real. */
  noiseFloorRatio?: number | null;
}

export type PairVerdict = 'faster' | 'slower' | 'no-measured-difference' | 'unresolved';

export interface PromptPairResult {
  promptId: string;
  contentClass: BenchContentClass;
  /** One ratio per round. NEVER pooled with another prompt's. */
  ratios: number[];
  min: number | null;
  max: number | null;
  median: number | null;
  /** True when the round-to-round spread crosses 1.0: the arms swapped places between rounds. */
  straddlesOne: boolean;
  /** True when the whole ratio band sits inside the machine's own measured variance. */
  insideNoise: boolean;
  /**
   * THIS prompt's own within-arm spread — the larger of the two arms' max/min on this prompt alone.
   *
   * Measured, not assumed: a negative control on a 1B model with both arms IDENTICAL produced
   * within-arm spreads of 1.029x on the code prompt and 1.497x on the table prompt in the same run.
   * A single global floor taken from one prompt therefore understates the variance on every other
   * prompt, and it made that negative control report two false "slower" verdicts — on a machine
   * measured against ITSELF. The strongest real result on record uses the same correction: its four
   * ratios are reported as clearing "a true within-cell noise of 1.005-1.015x", not a global one.
   */
  withinArmFloor: number | null;
  /** The floor actually used: the larger of the global floor and this prompt's within-arm spread. */
  effectiveFloor: number | null;
  verdict: PairVerdict;
  why: string;
  /** Every raw sample, both arms, in round order. Reporting the median alone hides the spread. */
  numerator: (number | null)[];
  denominator: (number | null)[];
  /** Pairs dropped because one side failed. A pair, not a sample — an unpaired value is not a ratio. */
  droppedPairs: number;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  if (s.length % 2) return s[mid] ?? null;
  const lo = s[mid - 1];
  const hi = s[mid];
  return lo != null && hi != null ? (lo + hi) / 2 : null;
}

/**
 * Per-prompt paired ratios, and a verdict for each. THE function this module exists for.
 *
 * Two invariants, both of which have cost a withdrawn result:
 *
 *   · A ratio requires a PAIR. Both arms must have produced a usable value in the SAME round, on the
 *     SAME prompt. There is no fallback to "the other arm's average" and no cross-round pairing.
 *   · A failed arm voids the pair. It is counted in `droppedPairs` and contributes no ratio. It must
 *     never arrive as a large duration or a zero rate, because a timeout rendered as a slow sample
 *     manufactures an uplift out of an outage.
 *
 * "Per-prompt" is not a nicety either. Speculation is prompt-dominated: on one model on one machine
 * the same drafter state produced 218 tok/s on boilerplate and 34.3 on a repetitive count — a 6.4x
 * spread from prompt choice alone. Pooling those into a range describes the mix, and the mix was
 * chosen by whoever wrote the script.
 */
export function pairPerPrompt(samples: readonly BenchSample[], opts: PairOptions): PromptPairResult[] {
  const byPrompt = new Map<string, BenchSample[]>();
  for (const s of samples) {
    const list = byPrompt.get(s.promptId);
    if (list) list.push(s);
    else byPrompt.set(s.promptId, [s]);
  }

  const floor = opts.noiseFloorRatio && Number.isFinite(opts.noiseFloorRatio) && opts.noiseFloorRatio > 1 ? opts.noiseFloorRatio : null;
  const results: PromptPairResult[] = [];

  for (const [promptId, list] of byPrompt) {
    const reps = [...new Set(list.map((s) => s.rep))].sort((a, b) => a - b);
    const ratios: number[] = [];
    const numerator: (number | null)[] = [];
    const denominatorVals: (number | null)[] = [];
    let dropped = 0;
    for (const rep of reps) {
      const n = list.find((s) => s.rep === rep && s.armId === opts.numeratorArmId);
      const d = list.find((s) => s.rep === rep && s.armId === opts.denominatorArmId);
      numerator.push(n?.value ?? null);
      denominatorVals.push(d?.value ?? null);
      // The pairing gate. A missing arm, a failed arm (value null) or a zero denominator drops the
      // whole round — never half of it, and never a substituted number.
      if (n?.value == null || d?.value == null || d.value === 0) {
        dropped++;
        continue;
      }
      // A duration ratio is inverted so that "> 1 means the treatment arm won" holds for both kinds
      // of quantity. Doing this once here is why no call site can get the direction backwards.
      ratios.push(opts.higherIsBetter ? n.value / d.value : d.value / n.value);
    }

    const contentClass = list[0]?.contentClass ?? 'mixed';
    const min = ratios.length ? Math.min(...ratios) : null;
    const max = ratios.length ? Math.max(...ratios) : null;
    const straddlesOne = min != null && max != null && min <= 1 && max >= 1;

    // This prompt's OWN variance, taken from the run's own samples: each arm's max/min on this
    // prompt, whichever is wider. An arm compared against itself cannot beat its own spread, so any
    // effect inside it is the machine.
    const armSpread = (armId: string): number | null => {
      const vals = list.filter((sm) => sm.armId === armId && sm.value != null && sm.value > 0).map((sm) => sm.value as number);
      return vals.length >= 2 ? Math.max(...vals) / Math.min(...vals) : null;
    };
    const spreads = [armSpread(opts.numeratorArmId), armSpread(opts.denominatorArmId)].filter((v): v is number => v != null && v > 1);
    const withinArmFloor = spreads.length ? Math.max(...spreads) : null;
    // The floor a verdict is held to. Taking the LARGER of the two is the conservative choice, and
    // conservative is the right direction: this whole module exists because differences got called
    // real that were not.
    const effectiveFloor = floor != null && withinArmFloor != null ? Math.max(floor, withinArmFloor) : (floor ?? withinArmFloor);
    const lo = effectiveFloor == null ? null : 1 / effectiveFloor;
    const hi = effectiveFloor;
    // Three positions relative to the noise band, not two. `insideNoise` is the whole band within it;
    // `touchesNoise` is a band with one foot in it, which is neither a result nor a non-result — it
    // is an underpowered measurement, and saying so is more honest than rounding it to either.
    const insideNoise = lo != null && hi != null && min != null && max != null && min >= lo && max <= hi;
    const touchesNoise = lo != null && hi != null && min != null && max != null && !insideNoise && min <= hi && max >= lo;

    let verdict: PairVerdict;
    let why: string;
    if (ratios.length === 0) {
      verdict = 'unresolved';
      why = `no complete pairs (${dropped} dropped because one arm failed) — an unpaired sample is not a ratio, and a failed arm is not a slow arm`;
    } else if (ratios.length < 2) {
      verdict = 'unresolved';
      why = `n=${ratios.length} after warm-up exclusion — one ratio has no round-to-round spread, and a spread is what tells a result from the machine`;
    } else if (straddlesOne) {
      verdict = 'no-measured-difference';
      why = `per-prompt round spread ${fixed(min)}-${fixed(max)} crosses 1.0 — the arms swapped places between rounds, so the honest reading is no difference rather than a smaller one`;
    } else if (insideNoise) {
      verdict = 'no-measured-difference';
      why = `spread ${fixed(min)}-${fixed(max)} lies inside this prompt's noise band of ${fixed(lo)}-${fixed(hi)}x (floor ${fixed(effectiveFloor)}x: ${
        withinArmFloor != null && effectiveFloor === withinArmFloor ? "this prompt's own within-arm spread" : 'the identical-call floor'
      })`;
    } else if (touchesNoise) {
      verdict = 'unresolved';
      why = `spread ${fixed(min)}-${fixed(max)} has one foot inside this prompt's noise band of ${fixed(lo)}-${fixed(hi)}x — part of the effect is indistinguishable from the machine, so this is underpowered rather than a result. More rounds, or a longer generation.`;
    } else if (min != null && min > 1) {
      verdict = 'faster';
      why = `every round favoured '${opts.numeratorArmId}' (${fixed(min)}-${fixed(max)}x)${
        effectiveFloor == null
          ? ', but no noise floor was measured — treat the magnitude as provisional'
          : `, entirely outside this prompt's ${fixed(effectiveFloor)}x noise band`
      }`;
    } else {
      verdict = 'slower';
      why = `every round favoured '${opts.denominatorArmId}' (${fixed(min)}-${fixed(max)}x)${
        effectiveFloor == null
          ? ', but no noise floor was measured — treat the magnitude as provisional'
          : `, entirely outside this prompt's ${fixed(effectiveFloor)}x noise band`
      }`;
    }

    results.push({
      promptId,
      contentClass,
      ratios,
      min,
      max,
      median: median(ratios),
      straddlesOne,
      insideNoise,
      withinArmFloor,
      effectiveFloor,
      verdict,
      why,
      numerator,
      denominator: denominatorVals,
      droppedPairs: dropped,
    });
  }
  return results.sort((a, b) => a.promptId.localeCompare(b.promptId));
}

// ─── Content-class grouping, and the aggregate that is never produced ─────────

export interface ContentClassGroup {
  contentClass: BenchContentClass;
  /** True when this class may be compared against another class at all. */
  comparable: boolean;
  prompts: PromptPairResult[];
  /** The band across the prompts IN THIS CLASS ONLY. Null when no prompt in it resolved. */
  min: number | null;
  max: number | null;
  verdicts: Record<PairVerdict, number>;
  note: string;
}

export interface ContentClassSummary {
  byClass: ContentClassGroup[];
  /**
   * ALWAYS null. Not "null when the classes disagree" — always.
   *
   * This is the module's one structural refusal. A per-target uplift scalar is the most expensive
   * mistake available here: acceptance on one unchanged machine spans 6.2 %-82.9 % by content class,
   * and uplift over the same axis runs 1.57x-3.65x on code against ~1.0 or a small slowdown on
   * prose. Any mean over that is a description of the prompt mix wearing a hardware label. Making
   * the field exist and be null is deliberate — a caller reaching for it finds a sentence explaining
   * why instead of silently computing its own.
   */
  overall: null;
  overallWithheld: string;
  /** True when the classes do not agree on direction — the case the scalar would have hidden. */
  classesDisagree: boolean;
}

export function summarizeByContentClass(results: readonly PromptPairResult[]): ContentClassSummary {
  const byClass = new Map<BenchContentClass, PromptPairResult[]>();
  for (const r of results) {
    const list = byClass.get(r.contentClass);
    if (list) list.push(r);
    else byClass.set(r.contentClass, [r]);
  }

  const groups: ContentClassGroup[] = [];
  for (const [contentClass, prompts] of byClass) {
    const resolved = prompts.filter((p) => p.min != null && p.max != null);
    const verdicts: Record<PairVerdict, number> = { faster: 0, slower: 0, 'no-measured-difference': 0, unresolved: 0 };
    for (const p of prompts) verdicts[p.verdict]++;
    const min = resolved.length ? Math.min(...resolved.map((p) => p.min as number)) : null;
    const max = resolved.length ? Math.max(...resolved.map((p) => p.max as number)) : null;
    groups.push({
      contentClass,
      comparable: isComparableBenchClass(contentClass),
      prompts: [...prompts].sort((a, b) => a.promptId.localeCompare(b.promptId)),
      min,
      max,
      verdicts,
      note: isComparableBenchClass(contentClass)
        ? `${prompts.length} prompt(s) in this class; the band below spans this class only`
        : `${prompts.length} prompt(s); '${contentClass}' is not commensurate with the five measured classes and must not be pooled with them`,
    });
  }
  groups.sort((a, b) => a.contentClass.localeCompare(b.contentClass));

  const directions = new Set(
    groups
      .filter((g) => g.comparable)
      .flatMap((g) => g.prompts.map((p) => p.verdict))
      .filter((v) => v === 'faster' || v === 'slower'),
  );
  return {
    byClass: groups,
    overall: null,
    overallWithheld:
      'withheld by design. Content class is the dominant variable: on one unchanged machine acceptance ran 6.2 %-82.9 % and uplift 1.57x-3.65x on code against ~1.0 on prose. Any single number over these classes reports the prompt mix, not the target. Read the per-class bands.',
    classesDisagree: directions.size > 1,
  };
}

// ─── Acceptance rate, and the denominator that makes it uninterpretable ───────

/**
 * WHICH acceptance is being reported. Two builds print a field called `accept_rate` and mean
 * different things by it; comparing them produced a conclusion that had to be withdrawn.
 */
export type AcceptanceDenominator =
  /** `accepted_tree_nodes / (steps x 16)`. Algebraically `(avg_commit - 1)/16`, structurally capped, and NOT a classical accepted/proposed rate. */
  | 'tree-nodes-over-steps-x16'
  /** `accepted / emitted`. Algebraically `1 - 1/avg_commit`. */
  | 'accepted-over-emitted'
  /** A true accepted/proposed rate, per draft position or cumulative — MTP counters, llama.cpp draft counters. */
  | 'accepted-over-proposed'
  | 'unknown';

export interface AcceptanceProfile {
  id: string;
  denominator: AcceptanceDenominator;
  /** True when the field ships a raw COUNT that a naive reader will render as a percentage. */
  emitsCountNotRate: boolean;
  why: string;
}

/**
 * The profiles, each carrying the evidence that established it.
 *
 * `lucebox-rocm` is the dangerous one: its `usage.accept_rate` is a raw count. Measured with the
 * same prompt and the same 36 completion tokens on both builds — the gfx1100 build came back with
 * `accept_rate: 32.0` and the gfx1151 build with `accept_rate: 0.515625`. Anyone reading the first
 * as a percentage gets 3200 %.
 */
export const ACCEPTANCE_PROFILES: Record<string, AcceptanceProfile> = {
  'lucebox-rocm-7.2': {
    id: 'lucebox-rocm-7.2',
    denominator: 'tree-nodes-over-steps-x16',
    emitsCountNotRate: false,
    why: 'gfx1151 builds report accepted_tree_nodes / (steps x 16). In all 22 logged requests examined, proposals = steps x 16 exactly and accepted = tokens - steps +/- 1, so the figure reduces to (avg_commit - 1)/16 — a restatement of commits-per-step, structurally capped at 1/16 per unaccepted node. It is not an accepted/proposed rate and does not compare to one.',
  },
  'lucebox-rocm': {
    id: 'lucebox-rocm',
    denominator: 'accepted-over-emitted',
    emitsCountNotRate: true,
    why: 'The gfx1100 build reports accepted/emitted, algebraically 1 - 1/avg_commit, and never logs a proposal count — so the true accepted/proposed rate is not recoverable from it. Its `usage.accept_rate` field is a raw COUNT: measured at 32.0 against 36 completion tokens. Read as a percentage it inflates by ~100x.',
  },
  'ollama-mtp': {
    id: 'ollama-mtp',
    denominator: 'accepted-over-proposed',
    emitsCountNotRate: false,
    why: "Ollama's built-in MTP head reports a true accepted/proposed rate, cumulative and per draft position (measured 91.0 % at depth 1 falling to 43.6 % at depth 8). Comparable to another accepted/proposed figure at the SAME draft depth, and to nothing else — a pooled scalar cannot tell a bad drafter from a good one run too deep.",
  },
  'llama-cpp-draft': {
    id: 'llama-cpp-draft',
    denominator: 'accepted-over-proposed',
    emitsCountNotRate: false,
    why: 'llama.cpp draft counters (n_accept / n_drafted) are a true accepted/proposed rate at the configured n_max. Same rule: comparable only at equal depth.',
  },
  unknown: {
    id: 'unknown',
    denominator: 'unknown',
    emitsCountNotRate: false,
    why: 'No profile matched this response shape. The number is recorded and is comparable to nothing until someone establishes what its denominator is — which is exactly the state that produced the gfx1151 acceptance-collapse claim.',
  },
};

const UNKNOWN_ACCEPTANCE_PROFILE: AcceptanceProfile = ACCEPTANCE_PROFILES.unknown as AcceptanceProfile;

export interface AcceptanceReading {
  /** The value exactly as the server sent it. Never rescaled in place. */
  raw: number | null;
  /** Where it was found, e.g. `usage.accept_rate`. */
  field: string | null;
  /** A 0..1 rate when one can be derived; null when the raw is a count with no denominator to divide by. */
  rate: number | null;
  denominator: AcceptanceDenominator;
  profile: string;
  /** True when `raw` is a count. A count above 1.0 is the tell, and it is checked as well as declared. */
  isCount: boolean;
  /** Two readings may be compared only when this string matches. */
  comparableKey: string;
  note: string;
}

/** Read a dotted path out of a parsed body. */
function pick(body: unknown, path: string): unknown {
  let cur: unknown = body;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Which build answered, from the SHAPE of its usage block.
 *
 * A measured discriminator, not a guess: the `:rocm` build returned `usage.spec_decode_ran` plus
 * `timings.prefilled_tokens` / `cache_hit` / `effective_prompt_tokens`, and the `:rocm-7.2` build
 * returned none of those while still returning `accept_rate` and `timings.decode_ms`. A caller that
 * knows which build it is talking to should pass the profile rather than rely on this.
 */
export function detectAcceptanceProfile(body: unknown): AcceptanceProfile {
  const usage = pick(body, 'usage');
  if (usage && typeof usage === 'object') {
    const u = usage as Record<string, unknown>;
    if ('spec_decode_ran' in u || pick(body, 'usage.timings.prefilled_tokens') !== undefined)
      return ACCEPTANCE_PROFILES['lucebox-rocm'] as AcceptanceProfile;
    if ('accept_rate' in u && pick(body, 'usage.timings.decode_ms') !== undefined)
      return ACCEPTANCE_PROFILES['lucebox-rocm-7.2'] as AcceptanceProfile;
  }
  // Native routes report draft counters at the top level rather than under usage.
  if (pick(body, 'draft_accepted') !== undefined || pick(body, 'n_accept') !== undefined)
    return ACCEPTANCE_PROFILES['llama-cpp-draft'] as AcceptanceProfile;
  return UNKNOWN_ACCEPTANCE_PROFILE;
}

const ACCEPTANCE_FIELDS = [
  'usage.accept_rate',
  'usage.acceptance_rate',
  'usage.timings.accept_rate',
  'timings.accept_rate',
  'accept_rate',
  'draft_accept_rate',
  'accepted_ratio',
];

/**
 * Pull the acceptance figure out of a response and label it with what it actually means.
 *
 * The labelling is the feature. A bare number here is worse than no number: a whole investigation
 * went into a 12.8 % that was one prose generation compared against a 72 % computed with a different
 * denominator on different silicon.
 */
export function readAcceptance(body: unknown, opts?: { profile?: AcceptanceProfile | string; completionTokens?: number | null }): AcceptanceReading {
  const profile =
    typeof opts?.profile === 'string'
      ? ((ACCEPTANCE_PROFILES[opts.profile] ?? UNKNOWN_ACCEPTANCE_PROFILE) as AcceptanceProfile)
      : (opts?.profile ?? detectAcceptanceProfile(body));

  let raw: number | null = null;
  let field: string | null = null;
  for (const path of ACCEPTANCE_FIELDS) {
    const v = pick(body, path);
    if (typeof v === 'number' && Number.isFinite(v)) {
      raw = v;
      field = path;
      break;
    }
  }
  if (raw == null) {
    return {
      raw: null,
      field: null,
      rate: null,
      denominator: profile.denominator,
      profile: profile.id,
      isCount: false,
      comparableKey: `${profile.id}::none`,
      note: 'this response reported no acceptance figure — absent, not zero',
    };
  }

  // A "rate" above 1.0 is a count whatever the profile says. Checking the value as well as trusting
  // the profile is what catches a build nobody has characterised yet.
  const isCount = profile.emitsCountNotRate || raw > 1;
  const reportedTokens = pick(body, 'usage.completion_tokens');
  const emitted = opts?.completionTokens ?? (typeof reportedTokens === 'number' ? reportedTokens : null);
  let rate: number | null = null;
  let note: string;
  if (!isCount) {
    rate = raw;
    note = `${(raw * 100).toFixed(1)} % under denominator '${profile.denominator}'. ${profile.why}`;
  } else if (typeof emitted === 'number' && emitted > 0 && profile.denominator === 'accepted-over-emitted') {
    rate = raw / emitted;
    note = `raw ${raw} is a COUNT, not a rate — normalised to ${((raw / emitted) * 100).toFixed(1)} % against ${emitted} emitted tokens. ${profile.why}`;
  } else {
    note = `raw ${raw} is a COUNT with no denominator available in this response — it cannot be turned into a rate here, and must never be rendered as a percentage. ${profile.why}`;
  }

  return {
    raw,
    field,
    rate,
    denominator: profile.denominator,
    profile: profile.id,
    isCount,
    // The comparability key deliberately includes the denominator, not the machine or the hardware:
    // two gfx1151 targets on different build tags are NOT comparable, and a gfx1151 and a gfx1100
    // target on the same tag would be.
    comparableKey: `${profile.id}::${profile.denominator}`,
    note,
  };
}

/**
 * The number of tokens committed per speculative step, recovered from whichever denominator the
 * build happens to report. THE build-independent quantity.
 *
 * This is what makes two builds comparable at all. The two build denominators are algebraically
 * related to avg_commit and to nothing else:
 *
 *     gfx1151 `:rocm-7.2`   raw = (avg_commit - 1) / 16      ->  avg_commit = raw * 16 + 1
 *     gfx1100 `:rocm`       raw = 1 - 1 / avg_commit         ->  avg_commit = 1 / (1 - raw)
 *
 * Returns null for a denominator whose algebra is not established — a true accepted/proposed rate
 * does not determine avg_commit without the draft depth, and guessing one is how the acceptance
 * collapse that was not there got claimed.
 */
export function avgCommitFrom(reading: AcceptanceReading): number | null {
  const rate = reading.rate;
  if (rate == null || !Number.isFinite(rate)) return null;
  if (reading.denominator === 'tree-nodes-over-steps-x16') return rate * 16 + 1;
  if (reading.denominator === 'accepted-over-emitted') return rate >= 1 ? null : 1 / (1 - rate);
  return null;
}

export interface AcceptanceConversion {
  /** The figure expressed on the target denominator, or null when the algebra does not reach it. */
  value: number | null;
  avgCommit: number | null;
  why: string;
}

/**
 * Express one build's acceptance figure on another build's denominator.
 *
 * The conversion is the ONLY honest way to put a gfx1151 number next to a gfx1100 one, and it is
 * what dissolved the "acceptance collapse": applying the gfx1100 formula to the gfx1151 avg_commit
 * of 3.52 gives 1 - 1/3.52 = 71.6 %, which is the gfx1100 build's own figure to three significant
 * figures.
 *
 * Corroborated again on the five content-class prompts, converting the gfx1151 readings onto the
 * gfx1100 denominator against the gfx1100 build's own measurements of the same five prompts:
 *
 *     prose  69.3 % vs 63.7 %      list 72.9 % vs 69.0 %      code 88.2 % vs 86.0 %
 *     table  82.6 % vs 85.0 %      json 90.2 % vs 88.3 %
 *
 * Five prompts, two architectures, every pair within ~6 points — while the RAW figures differ by
 * more than 4x. The drafting is not different; the denominators are. (Caveat that travels with it:
 * the two machines served different model ids, so this is corroboration and not a controlled
 * comparison.)
 */
export function convertAcceptance(reading: AcceptanceReading, to: AcceptanceDenominator): AcceptanceConversion {
  if (reading.denominator === to) return { value: reading.rate, avgCommit: avgCommitFrom(reading), why: 'already on that denominator' };
  const avgCommit = avgCommitFrom(reading);
  if (avgCommit == null || avgCommit <= 1) {
    return {
      value: null,
      avgCommit,
      why: `cannot recover commits-per-step from denominator '${reading.denominator}' — a true accepted/proposed rate does not determine it without the draft depth, and guessing is what produced the acceptance-collapse claim`,
    };
  }
  if (to === 'accepted-over-emitted')
    return { value: 1 - 1 / avgCommit, avgCommit, why: `via commits-per-step ${avgCommit.toFixed(3)}: 1 - 1/avg_commit` };
  if (to === 'tree-nodes-over-steps-x16')
    return { value: (avgCommit - 1) / 16, avgCommit, why: `via commits-per-step ${avgCommit.toFixed(3)}: (avg_commit - 1)/16` };
  return { value: null, avgCommit, why: `no established algebra onto '${to}'` };
}

/**
 * May these two acceptance figures be put next to each other?
 *
 * This is the guard for the exact mistake: 12.8 % on gfx1151 against 72 % on gfx1100 looked like a
 * hardware collapse and was two different metrics. Applying the gfx1100 formula to the gfx1151
 * avg_commit of 3.52 gives 1 - 1/3.52 = 71.6 %, i.e. the gfx1100 figure to three significant
 * figures — the drafters were performing identically.
 */
export function acceptanceComparable(a: AcceptanceReading, b: AcceptanceReading): { ok: boolean; why: string } {
  if (a.raw == null || b.raw == null) return { ok: false, why: 'one side reported no acceptance figure at all' };
  if (a.denominator === 'unknown' || b.denominator === 'unknown') {
    return {
      ok: false,
      why: "at least one side's denominator is unknown — recording it is fine, comparing it is how the acceptance-collapse claim happened",
    };
  }
  if (a.comparableKey !== b.comparableKey) {
    // Not merely refused — told what WOULD make it comparable, when the algebra reaches that far.
    const converted = convertAcceptance(a, b.denominator);
    const route =
      converted.value != null && a.rate != null
        ? ` Convert first: ${(a.rate * 100).toFixed(1)} % on '${a.denominator}' is ${(converted.value * 100).toFixed(1)} % on '${b.denominator}' (${converted.why}), and THAT may be compared.`
        : ` ${converted.why}`;
    return {
      ok: false,
      why: `different denominators: '${a.denominator}' (${a.profile}) vs '${b.denominator}' (${b.profile}). These are different metrics. Comparing 12.8 % from the first against 72 % from the second produced a "gfx1151 acceptance collapse" that was a denominator artifact — the same drafting, expressed two ways.${route}`,
    };
  }
  return { ok: true, why: `both figures use '${a.denominator}' from profile '${a.profile}'` };
}

// ─── Throughput, TTFT and decode ──────────────────────────────────────────────

export interface RateSpread {
  n: number;
  min: number | null;
  max: number | null;
  median: number | null;
  /** Every sample, in order. Report the raw samples, never the median alone. */
  samples: number[];
  spreadRatio: number | null;
  note: string;
}

export function rateSpread(samples: readonly (number | null | undefined)[]): RateSpread {
  const usable = samples.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (usable.length === 0) return { n: 0, min: null, max: null, median: null, samples: [], spreadRatio: null, note: 'no usable samples' };
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  return {
    n: usable.length,
    min,
    max,
    median: median(usable),
    samples: [...usable],
    spreadRatio: usable.length >= 2 ? max / min : null,
    note:
      usable.length >= 2
        ? `${usable.length} samples, ${min.toFixed(3)}-${max.toFixed(3)} (${(max / min).toFixed(3)}x)`
        : 'one sample — a point, not a range',
  };
}

export interface DecodeSplit {
  /** Time to the first token. Queue wait plus prefill; nothing to do with decode speed. */
  ttftMs: number | null;
  /** Wall time spent generating after the first token. */
  decodeMs: number | null;
  /** Tokens per second over the DECODE window only — the number people mean by "how fast is it". */
  decodeTokensPerSec: number | null;
  /** End-to-end rate, which mixes prefill in. Kept because it is what most reports quote. */
  endToEndTokensPerSec: number | null;
  /** Where the split came from. Engine numbers are immune to client-side timing noise; prefer them. */
  source: 'engine' | 'client' | 'none';
  note: string;
}

/**
 * Separate queue wait and prefill from generation.
 *
 * Prefer the server's own timings when it reports them. Some builds return `timings.prefill_ms`,
 * `timings.decode_ms` and `timings.decode_tokens_per_sec`, and the strongest speculative result on
 * record — ~1.75x on one gfx1100 machine — was confirmed by `decode_ms` moving by the same factor as
 * the client-side rate, independently. When the server reports nothing, a streamed TTFT plus wall
 * time gives the same split with more noise; when neither exists, this says so rather than inventing
 * one.
 */
export function decodeSplit(input: {
  durationMs?: number | null;
  ttftMs?: number | null;
  completionTokens?: number | null;
  /** The server's own `usage.timings` block, when it sent one. */
  engineTimings?: Record<string, unknown> | null;
}): DecodeSplit {
  const t = input.engineTimings ?? null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  // Some runners report milliseconds under `prefill_ms` / `decode_ms`; Ollama's native route reports
  // NANOSECONDS under `prompt_eval_duration` / `eval_duration`. Both are the engine's own clock and
  // both beat client wall time — the only reason to prefer one is that it is there.
  const ns = (v: unknown): number | null => {
    const n = num(v);
    return n == null ? null : n / 1e6;
  };
  const enginePrefill = num(t?.prefill_ms) ?? ns(t?.prompt_eval_duration);
  const engineDecode = num(t?.decode_ms) ?? ns(t?.eval_duration);
  const engineRate = num(t?.decode_tokens_per_sec);
  const tokens = typeof input.completionTokens === 'number' && input.completionTokens > 0 ? input.completionTokens : null;
  const wall = typeof input.durationMs === 'number' && input.durationMs > 0 ? input.durationMs : null;
  const endToEnd = tokens != null && wall != null ? (tokens / wall) * 1000 : null;

  if (enginePrefill != null || engineDecode != null || engineRate != null) {
    const rate = engineRate ?? (engineDecode != null && engineDecode > 0 && tokens != null ? (tokens / engineDecode) * 1000 : null);
    return {
      ttftMs: enginePrefill,
      decodeMs: engineDecode,
      decodeTokensPerSec: rate,
      endToEndTokensPerSec: endToEnd,
      source: 'engine',
      note: "from the server's own timings block — immune to client-side scheduling noise, and the cross-check that independently confirmed the strongest speculative result on record",
    };
  }
  if (wall != null && input.ttftMs != null && input.ttftMs >= 0 && input.ttftMs <= wall) {
    const decodeMs = wall - input.ttftMs;
    return {
      ttftMs: input.ttftMs,
      decodeMs,
      decodeTokensPerSec: tokens != null && decodeMs > 0 ? (tokens / decodeMs) * 1000 : null,
      endToEndTokensPerSec: endToEnd,
      source: 'client',
      note: 'client-side: TTFT from the first stream frame, decode as the remainder of wall time. Noisier than the engine block, and the only option on a backend that reports no timings.',
    };
  }
  return {
    ttftMs: null,
    decodeMs: null,
    decodeTokensPerSec: null,
    endToEndTokensPerSec: endToEnd,
    source: 'none',
    note: 'no TTFT available — this request was not streamed and the server reported no timings, so prefill and decode cannot be separated. The end-to-end rate mixes them.',
  };
}

// ─── Determinism ──────────────────────────────────────────────────────────────

/** Whether byte-identical output is a legitimate expectation for this (engine, arm, target). */
export type LosslessExpectation = 'lossless-expected' | 'not-lossless' | 'unknown';

/**
 * Backends whose speculative path has been OBSERVED not to be output-lossless.
 *
 * Membership is a measurement, not a reading of the textbook algorithm. The textbook version is
 * lossless; these builds are not, and assuming otherwise is exactly the kind of assumption this
 * module exists to keep out of results.
 */
export const NOT_LOSSLESS_BACKENDS: ReadonlySet<string> = new Set(['lucebox']);

export interface DeterminismContext {
  backend: string;
  /** True when the drafter/speculation arm is the one being probed. */
  speculative: boolean;
  /**
   * Declared by the CALLER, from its own negative control: this target's plain autoregressive path
   * differs from itself at temperature 0.
   *
   * This exists because at least one machine behaves that way, and on such a target a mismatch is
   * not even attributable to speculation — the control arm cannot be hashed as a gate either. It is
   * a caller-supplied observation rather than a hardcoded list because it is a property of a
   * specific machine, and this module never holds a list of specific machines.
   */
  nondeterministicAtTemperatureZero?: boolean;
  /** Optional label for the target, used only in the explanation text. */
  label?: string;
}

/**
 * What a hash mismatch would MEAN here — which is the whole reason this is not an assertion.
 *
 * Two observed facts make output-hash equality unusable as a general correctness gate:
 *   · speculative decoding is not output-lossless on some builds, so a mismatch between two spec-arm
 *     calls is the build working as built; and
 *   · some machines' plain autoregressive path is nondeterministic against ITSELF at temperature 0.
 *
 * Everything else is `unknown`: no build here has had losslessness verified, and asserting it
 * because the textbook algorithm is lossless would be an assumption dressed as a test.
 */
export function determinismExpectation(ctx: DeterminismContext): { expectation: LosslessExpectation; why: string } {
  const label = ctx.label ?? 'this target';
  if (NOT_LOSSLESS_BACKENDS.has(ctx.backend)) {
    return {
      expectation: 'not-lossless',
      why: `speculative decoding is not output-lossless on ${ctx.backend} builds — differing bytes between two identical greedy calls is a property of the build, not a defect`,
    };
  }
  if (ctx.nondeterministicAtTemperatureZero && !ctx.speculative) {
    return {
      expectation: 'not-lossless',
      why: `${label}'s plain autoregressive path was observed to be nondeterministic against itself at temperature 0 — the control arm there cannot be hashed as a gate either`,
    };
  }
  return {
    expectation: 'unknown',
    why: `no losslessness claim has been verified for ${ctx.backend} on ${label}. A mismatch is recorded as an observation about the build, not graded as a failure — verifying it is a separate experiment.`,
  };
}

export interface DeterminismResult {
  n: number;
  distinct: number;
  stable: boolean;
  expectation: LosslessExpectation;
  verdict: 'stable' | 'finding' | 'expected-nondeterminism' | 'insufficient';
  /**
   * Whether this should turn a run red. FALSE for `expected-nondeterminism` and for `unknown`
   * builds — the distinction that keeps getting lost: a mismatch on a build that was never lossless
   * is a finding to record, not a test that failed.
   */
  isTestFailure: boolean;
  why: string;
  hashes: string[];
}

/**
 * A stable, dependency-free content hash. FNV-1a 64-bit rendered hex.
 *
 * Deliberately not a crypto hash: this compares two strings that came from one machine minutes
 * apart, and reaching for node:crypto would make this module non-pure for no gain in the property
 * that matters (equal input, equal digest).
 */
export function hashOutput(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h = (h ^ BigInt(text.charCodeAt(i))) & mask;
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

export function determinismVerdict(input: { texts: readonly string[]; expectation: LosslessExpectation; why?: string }): DeterminismResult {
  const hashes = input.texts.map(hashOutput);
  const distinct = new Set(hashes).size;
  const stable = distinct <= 1;
  const base = { n: hashes.length, distinct, stable, expectation: input.expectation, hashes };

  if (hashes.length < 2) {
    return {
      ...base,
      verdict: 'insufficient',
      isTestFailure: false,
      why: `only ${hashes.length} sample — determinism needs at least two identical calls to compare`,
    };
  }
  if (stable) {
    return {
      ...base,
      verdict: 'stable',
      isTestFailure: false,
      why:
        input.expectation === 'not-lossless'
          ? `${hashes.length} identical greedy calls produced byte-identical output even though this build is not output-lossless — worth recording, since it means nothing forced a divergence on these samples`
          : `${hashes.length} identical greedy calls produced byte-identical output`,
    };
  }
  if (input.expectation === 'not-lossless') {
    return {
      ...base,
      verdict: 'expected-nondeterminism',
      isTestFailure: false,
      why: `${distinct} distinct outputs from ${hashes.length} identical greedy calls. This is a FINDING, not a failing test: ${input.why ?? 'this build is not output-lossless'}. Output-hash equality cannot be used as a correctness gate here.`,
    };
  }
  if (input.expectation === 'lossless-expected') {
    return {
      ...base,
      verdict: 'finding',
      isTestFailure: true,
      why: `${distinct} distinct outputs from ${hashes.length} identical greedy calls on a build that is expected to be output-lossless — a real defect`,
    };
  }
  return {
    ...base,
    verdict: 'finding',
    isTestFailure: false,
    why: `${distinct} distinct outputs from ${hashes.length} identical greedy calls. ${input.why ?? 'Losslessness is unverified for this build'}, so this is recorded as an observation about the build rather than graded as a failure.`,
  };
}

// ─── Report shaping ───────────────────────────────────────────────────────────

export interface BenchReport {
  /** Caller-supplied label for what was measured. */
  target: string;
  backend: string;
  model: string;
  arms: { id: string; label: string; params: Record<string, unknown> }[];
  noiseFloor: NoiseFloor;
  perPrompt: PromptPairResult[];
  byContentClass: ContentClassSummary;
  acceptance: { armId: string; promptId: string; reading: AcceptanceReading }[];
  determinism: { promptId: string; result: DeterminismResult }[];
  throughput: { armId: string; promptId: string; spread: RateSpread; decode: DecodeSplit | null }[];
  caveats: string[];
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const fmt = (v: number | null | undefined, d = 3) => (v == null ? '—' : v.toFixed(d));
const fixed = (v: number | null | undefined, d = 3) => (v == null ? '—' : v.toFixed(d));

/**
 * A plain-text report. Per prompt, per class, with every raw sample, and no line anywhere that
 * offers a single number for the run.
 */
export function renderReport(r: BenchReport): string {
  const out: string[] = [];
  out.push(`target ${r.target} · backend ${r.backend} · model ${r.model}`);
  out.push(`arms: ${r.arms.map((a) => `${a.id}=${JSON.stringify(a.params)}`).join('  vs  ')}`);
  out.push(`noise floor: ${r.noiseFloor.note}`);
  out.push('');
  out.push(`${pad('prompt', 30)}${pad('class', 8)}${pad('n', 4)}${pad('min', 9)}${pad('max', 9)}${pad('median', 9)}verdict`);
  for (const p of r.perPrompt) {
    out.push(
      `${pad(p.promptId, 30)}${pad(p.contentClass, 8)}${pad(String(p.ratios.length), 4)}${pad(fmt(p.min), 9)}${pad(fmt(p.max), 9)}${pad(fmt(p.median), 9)}${p.verdict}`,
    );
    out.push(`  ${p.why}`);
    out.push(`  raw ratios: [${p.ratios.map((v) => v.toFixed(3)).join(', ')}]`);
    out.push(`  numerator:   [${p.numerator.map((v) => (v == null ? '—' : v.toFixed(2))).join(', ')}]`);
    out.push(`  denominator: [${p.denominator.map((v) => (v == null ? '—' : v.toFixed(2))).join(', ')}]`);
    if (p.droppedPairs > 0) out.push(`  ${p.droppedPairs} pair(s) dropped: one arm failed, and a failed arm is not a slow arm`);
  }
  out.push('');
  out.push('per content class (never pooled across classes):');
  for (const g of r.byContentClass.byClass) {
    out.push(`  ${pad(g.contentClass, 8)} ${pad(`${fmt(g.min)}-${fmt(g.max)}`, 18)} ${g.note}`);
  }
  out.push(`  overall: WITHHELD — ${r.byContentClass.overallWithheld}`);
  if (r.byContentClass.classesDisagree) out.push('  NOTE: the classes disagree on direction. A scalar would have hidden that entirely.');
  if (r.acceptance.length) {
    out.push('');
    out.push('acceptance (each figure carries its denominator; do not compare across denominators):');
    // The denominator note is the important part and it is LONG, so it is printed once per profile
    // rather than once per row — a live run once emitted the same 400-character explanation 20 times
    // and buried the five numbers it was explaining. Rows are deduplicated by (prompt, arm, raw): a
    // repeated identical reading across rounds is one fact, not four.
    const seen = new Set<string>();
    const profiles = new Map<string, string>();
    for (const a of r.acceptance) {
      profiles.set(a.reading.profile, ACCEPTANCE_PROFILES[a.reading.profile]?.why ?? a.reading.note);
      const key = `${a.promptId}::${a.armId}::${a.reading.raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rate = a.reading.rate == null ? 'not expressible as a rate here' : `${(a.reading.rate * 100).toFixed(1)} %`;
      out.push(
        `  ${pad(a.promptId, 26)}${pad(a.armId, 6)}raw=${pad(String(a.reading.raw ?? '—'), 12)}${pad(rate, 10)}${a.reading.isCount ? '(raw is a COUNT)' : ''} [${a.reading.denominator}]`,
      );
    }
    for (const [id, why] of profiles) {
      out.push(`  denominator '${id}': ${why}`);
    }
  }
  if (r.determinism.length) {
    out.push('');
    out.push('determinism:');
    for (const d of r.determinism) out.push(`  ${pad(d.promptId, 26)}${pad(d.result.verdict, 26)}${d.result.why}`);
  }
  if (r.throughput.length) {
    out.push('');
    out.push('throughput (tok/s, every sample shown) and TTFT/decode split:');
    for (const t of r.throughput) {
      out.push(`  ${pad(t.promptId, 26)}${pad(t.armId, 10)}${t.spread.note}  [${t.spread.samples.map((v) => v.toFixed(2)).join(', ')}]`);
      if (t.decode)
        out.push(
          `    ttft ${fmt(t.decode.ttftMs, 1)}ms · decode ${fmt(t.decode.decodeMs, 1)}ms · decode ${fmt(t.decode.decodeTokensPerSec, 2)} tok/s (${t.decode.source})`,
        );
    }
  }
  if (r.caveats.length) {
    out.push('');
    out.push('caveats:');
    for (const c of r.caveats) out.push(`  · ${c}`);
  }
  return out.join('\n');
}

/**
 * The structural minimum a prompt must expose to be scheduled in a paired benchmark.
 *
 * Deliberately not the full prompt type: this module holds no prompt bank, and a caller with a
 * richer prompt object satisfies this shape structurally.
 */
export interface BenchablePrompt {
  id: string;
  contentClass: string;
  /** Copies dispatched simultaneously. 1 = an ordinary queued item; >1 is a deliberate burst. */
  fanout: number;
}

/**
 * Prompts a benchmark may pair, and the ones it must not.
 *
 * An embedding or an envelope probe generates nothing, so it has no decode rate and no acceptance —
 * including one contributes a zero to a rate that should have excluded it.
 */
export function benchablePrompts<T extends BenchablePrompt>(prompts: readonly T[]): { usable: T[]; excluded: { id: string; why: string }[] } {
  const usable: T[] = [];
  const excluded: { id: string; why: string }[] = [];
  for (const p of prompts) {
    const cls = benchContentClassOf(p.contentClass);
    if (cls === 'none') {
      excluded.push({
        id: p.id,
        why: "content class 'none' — nothing is generated, so decode rate and acceptance are undefined here rather than zero",
      });
    } else if (p.fanout > 1) {
      excluded.push({
        id: p.id,
        why: `fanout ${p.fanout} — a burst measures the scheduler, and firing one during a paired measurement is exactly the self-inflicted contention SerialGuard forbids`,
      });
    } else {
      usable.push(p);
    }
  }
  return { usable, excluded };
}
