/**
 * The A/B methodology, asserted as properties rather than as arithmetic.
 *
 * The one that matters most: an uplift ratio is computed ONLY from a genuine pair — both arms
 * producing a usable value, in the same round, on the same prompt. A FAILED ARM IS NOT A SLOW ARM.
 * A timeout rendered as a large duration or a zero rate manufactures an uplift out of an outage, so
 * a failed sample must void its pair and contribute no ratio at all.
 */

import { describe, expect, it } from 'vitest';
import {
  type BenchArm,
  type BenchSample,
  NOISE_FLOOR_MIN_SAMPLES,
  type PairOptions,
  SPEC_OFF_TRAPS,
  SerialGuard,
  benchablePrompts,
  determinismExpectation,
  determinismVerdict,
  hashOutput,
  interleavedSchedule,
  noiseFloor,
  pairPerPrompt,
  summarizeByContentClass,
  validateControlArm,
  validateSchedule,
} from '../bench-ab';

const ARMS: BenchArm[] = [
  { id: 'on', label: 'drafter on', why: 'the treatment: speculation enabled through a request parameter', params: { generation_mode: 'mtp' } },
  { id: 'off', label: 'baseline', why: 'the control: an explicit non-speculative mode', params: { generation_mode: 'ar' } },
];

const PAIR: PairOptions = { numeratorArmId: 'on', denominatorArmId: 'off', higherIsBetter: true };

function sample(rep: number, armId: string, value: number | null, extra: Partial<BenchSample> = {}): BenchSample {
  return { rep, promptId: 'p1', contentClass: 'code', armId, value, ...extra };
}

describe('a ratio requires a genuine pair', () => {
  it('a timeout produces NO ratio rather than a bad one', () => {
    // The whole methodology in one test. The failed arm arrives with value null and a long elapsed
    // time attached; if that elapsed time ever became the sample, the surviving arm would look
    // enormously faster and an outage would be published as an uplift.
    const [result] = pairPerPrompt(
      [sample(0, 'on', 120), sample(0, 'off', 100), sample(1, 'on', null, { durationMs: 60_000, error: 'request timeout' }), sample(1, 'off', 100)],
      PAIR,
    );
    expect(result.ratios).toEqual([1.2]);
    expect(result.droppedPairs).toBe(1);
    // The raw evidence is still reported — dropped, not hidden.
    expect(result.numerator).toEqual([120, null]);
    expect(result.denominator).toEqual([100, 100]);
  });

  it('every round failing leaves an unresolved verdict that says why', () => {
    const [result] = pairPerPrompt([sample(0, 'on', null), sample(0, 'off', 100), sample(1, 'on', null), sample(1, 'off', 100)], PAIR);
    expect(result.ratios).toEqual([]);
    expect(result.median).toBeNull();
    expect(result.verdict).toBe('unresolved');
    expect(result.why).toMatch(/a failed arm is not a slow arm/);
    expect(result.droppedPairs).toBe(2);
  });

  it('never pairs across rounds', () => {
    // Each arm succeeded once, in different rounds. Two usable numbers, zero pairs.
    const [result] = pairPerPrompt([sample(0, 'on', 120), sample(0, 'off', null), sample(1, 'on', null), sample(1, 'off', 100)], PAIR);
    expect(result.ratios).toEqual([]);
    expect(result.droppedPairs).toBe(2);
    expect(result.verdict).toBe('unresolved');
  });

  it('drops a round whose control arm is missing entirely', () => {
    const [result] = pairPerPrompt([sample(0, 'on', 120), sample(0, 'off', 100), sample(1, 'on', 130)], PAIR);
    expect(result.ratios).toEqual([1.2]);
    expect(result.droppedPairs).toBe(1);
  });

  it('drops a zero denominator instead of dividing by it', () => {
    const [result] = pairPerPrompt([sample(0, 'on', 120), sample(0, 'off', 0), sample(1, 'on', 120), sample(1, 'off', 100)], PAIR);
    expect(result.ratios).toEqual([1.2]);
    expect(result.droppedPairs).toBe(1);
    expect(result.ratios.every(Number.isFinite)).toBe(true);
  });

  it('one surviving pair is unresolved — a single ratio has no spread to read', () => {
    const [result] = pairPerPrompt([sample(0, 'on', 200), sample(0, 'off', 100)], PAIR);
    expect(result.ratios).toEqual([2]);
    expect(result.verdict).toBe('unresolved');
    expect(result.why).toMatch(/n=1/);
  });
});

describe('direction is decided once, not per call site', () => {
  it('inverts a duration so that "above 1" always means the treatment won', () => {
    const durations = [sample(0, 'on', 50), sample(0, 'off', 100), sample(1, 'on', 50), sample(1, 'off', 100)];
    const rate = pairPerPrompt(durations, { ...PAIR, higherIsBetter: true })[0];
    const duration = pairPerPrompt(durations, { ...PAIR, higherIsBetter: false })[0];
    expect(rate.ratios).toEqual([0.5, 0.5]);
    expect(rate.verdict).toBe('slower');
    expect(duration.ratios).toEqual([2, 2]);
    expect(duration.verdict).toBe('faster');
  });
});

describe('a verdict is held against the machine, not against 1.0', () => {
  it('a band that crosses 1.0 is no measured difference, not a small one', () => {
    const [result] = pairPerPrompt([sample(0, 'on', 105), sample(0, 'off', 100), sample(1, 'on', 95), sample(1, 'off', 100)], {
      ...PAIR,
      noiseFloorRatio: 1.01,
    });
    expect(result.straddlesOne).toBe(true);
    expect(result.verdict).toBe('no-measured-difference');
  });

  it('a band inside the noise floor is no measured difference', () => {
    const [result] = pairPerPrompt([sample(0, 'on', 103), sample(0, 'off', 100), sample(1, 'on', 104), sample(1, 'off', 100)], {
      ...PAIR,
      noiseFloorRatio: 1.5,
    });
    expect(result.insideNoise).toBe(true);
    expect(result.verdict).toBe('no-measured-difference');
  });

  it("uses THIS prompt's own within-arm spread when it is wider than the global floor", () => {
    // A negative control with both arms identical produced very different within-arm spreads on
    // different prompts in one run, and a single global floor made it report false "slower"
    // verdicts on a machine measured against itself.
    const [result] = pairPerPrompt([sample(0, 'on', 100), sample(0, 'off', 60), sample(1, 'on', 150), sample(1, 'off', 100)], {
      ...PAIR,
      noiseFloorRatio: 1.01,
    });
    expect(result.withinArmFloor).toBeCloseTo(1.6666, 3);
    expect(result.effectiveFloor).toBe(result.withinArmFloor);
    expect(result.verdict).toBe('no-measured-difference');
  });

  it('a band with one foot in the noise is underpowered, not a result', () => {
    // Three positions relative to the band, not two. Rounding this case to either answer would be
    // less honest than saying the measurement cannot decide.
    const [result] = pairPerPrompt([sample(0, 'on', 104), sample(0, 'off', 100), sample(1, 'on', 130), sample(1, 'off', 100)], {
      ...PAIR,
      noiseFloorRatio: 1.1,
    });
    expect(result.insideNoise).toBe(false);
    expect(result.verdict).toBe('unresolved');
    expect(result.why).toMatch(/underpowered/);
  });

  it('calls a clean win when every round clears the band', () => {
    const [result] = pairPerPrompt([sample(0, 'on', 175), sample(0, 'off', 100), sample(1, 'on', 180), sample(1, 'off', 100)], {
      ...PAIR,
      noiseFloorRatio: 1.05,
    });
    expect(result.verdict).toBe('faster');
    expect(result.min).toBeGreaterThan(1);
    expect(result.median).toBeCloseTo(1.775, 3);
  });

  it('labels a magnitude provisional when no noise floor was measured', () => {
    const [result] = pairPerPrompt([sample(0, 'on', 175), sample(0, 'off', 100), sample(1, 'on', 175), sample(1, 'off', 100)], PAIR);
    expect(result.effectiveFloor).toBeNull();
    expect(result.verdict).toBe('faster');
    expect(result.why).toMatch(/no noise floor was measured/);
  });
});

describe('prompts are never pooled', () => {
  it('keeps one result per prompt, sorted, with its own ratios', () => {
    // Speculation is prompt-dominated — the same engine state can differ several-fold between two
    // prompts, so a pooled range describes whoever chose the mix.
    const results = pairPerPrompt(
      [
        { rep: 0, promptId: 'b-json', contentClass: 'json', armId: 'on', value: 200 },
        { rep: 0, promptId: 'b-json', contentClass: 'json', armId: 'off', value: 100 },
        { rep: 1, promptId: 'b-json', contentClass: 'json', armId: 'on', value: 210 },
        { rep: 1, promptId: 'b-json', contentClass: 'json', armId: 'off', value: 100 },
        { rep: 0, promptId: 'a-prose', contentClass: 'prose', armId: 'on', value: 50 },
        { rep: 0, promptId: 'a-prose', contentClass: 'prose', armId: 'off', value: 100 },
        { rep: 1, promptId: 'a-prose', contentClass: 'prose', armId: 'on', value: 52 },
        { rep: 1, promptId: 'a-prose', contentClass: 'prose', armId: 'off', value: 100 },
      ],
      { ...PAIR, noiseFloorRatio: 1.02 },
    );
    expect(results.map((r) => r.promptId)).toEqual(['a-prose', 'b-json']);
    expect(results[0].verdict).toBe('slower');
    expect(results[1].verdict).toBe('faster');
  });
});

describe('the aggregate that is never produced', () => {
  it('withholds a single overall uplift by construction', () => {
    // Not "null when the classes disagree" — always null, with the reason attached, so a caller
    // reaching for it finds a sentence rather than computing its own mean.
    const summary = summarizeByContentClass(
      pairPerPrompt(
        [
          { rep: 0, promptId: 'code', contentClass: 'code', armId: 'on', value: 300 },
          { rep: 0, promptId: 'code', contentClass: 'code', armId: 'off', value: 100 },
          { rep: 1, promptId: 'code', contentClass: 'code', armId: 'on', value: 310 },
          { rep: 1, promptId: 'code', contentClass: 'code', armId: 'off', value: 100 },
          { rep: 0, promptId: 'prose', contentClass: 'prose', armId: 'on', value: 60 },
          { rep: 0, promptId: 'prose', contentClass: 'prose', armId: 'off', value: 100 },
          { rep: 1, promptId: 'prose', contentClass: 'prose', armId: 'on', value: 62 },
          { rep: 1, promptId: 'prose', contentClass: 'prose', armId: 'off', value: 100 },
        ],
        { ...PAIR, noiseFloorRatio: 1.02 },
      ),
    );
    expect(summary.overall).toBeNull();
    expect(summary.overallWithheld).toMatch(/withheld by design/);
    expect(summary.classesDisagree).toBe(true);
    expect(summary.byClass.map((g) => g.contentClass)).toEqual(['code', 'prose']);
    for (const group of summary.byClass) expect(group.comparable).toBe(true);
  });

  it('marks mixed and none as not commensurate with the five measured classes', () => {
    const summary = summarizeByContentClass(
      pairPerPrompt(
        [
          { rep: 0, promptId: 'x', contentClass: 'mixed', armId: 'on', value: 120 },
          { rep: 0, promptId: 'x', contentClass: 'mixed', armId: 'off', value: 100 },
        ],
        PAIR,
      ),
    );
    const mixed = summary.byClass.find((g) => g.contentClass === 'mixed');
    expect(mixed?.comparable).toBe(false);
    expect(mixed?.note).toMatch(/must not be pooled/);
    // One class in one direction is not a disagreement.
    expect(summary.classesDisagree).toBe(false);
  });
});

describe('control arms that are not actually off', () => {
  it('refuses a drafter depth of zero as a control', () => {
    // A depth of zero is not a documented off switch, so the "control" may speculate too and the
    // run would report a bogus ~1.0x. The case that was measured was the retired mlx-dspark's
    // `max_draft: 0`, which it silently coerced to `auto`.
    const problems = validateControlArm({ id: 'off', label: 'bad control', why: 'fixture', params: { num_draft: 0 } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/num_draft/);
    expect(problems[0]).toMatch(/omit the parameter/);
  });

  it('reports every trap at once rather than stopping at the first', () => {
    const everyTrap = Object.fromEntries(SPEC_OFF_TRAPS.map((trap) => [trap.param, trap.value]));
    const problems = validateControlArm({ id: 'off', label: 'bad control', why: 'fixture', params: everyTrap });
    expect(problems).toHaveLength(SPEC_OFF_TRAPS.length);
  });

  it('accepts an explicit baseline mode, and does not fire on a non-zero depth', () => {
    expect(validateControlArm(ARMS[1])).toEqual([]);
    expect(validateControlArm({ id: 'on', label: 'treatment', why: 'fixture', params: { num_draft: 6 } })).toEqual([]);
  });
});

describe('the schedule', () => {
  it('puts the arms back-to-back inside every (round, prompt) cell', () => {
    // Adjacency is the point: arms measured hours apart see different machines, and one such run's
    // load drift was published as a large uplift.
    const slots = interleavedSchedule({ promptIds: ['p1', 'p2'], arms: ARMS, reps: 2 });
    expect(
      validateSchedule(
        slots,
        ARMS.map((a) => a.id),
      ),
    ).toEqual([]);
    const cell = slots.filter((s) => !s.warmup && s.rep === 0 && s.promptId === 'p1').map((s) => s.seq);
    expect(Math.max(...cell) - Math.min(...cell)).toBe(1);
  });

  it('counterbalances arm order between rounds', () => {
    // Alternating WITHIN the round keeps arms adjacent; alternating the ORDER between rounds is what
    // stops "ran first" being a property of one arm across the whole run.
    const slots = interleavedSchedule({ promptIds: ['p1'], arms: ARMS, reps: 2, warmup: false });
    expect(slots.filter((s) => s.rep === 0).map((s) => s.armId)).toEqual(['on', 'off']);
    expect(slots.filter((s) => s.rep === 1).map((s) => s.armId)).toEqual(['off', 'on']);
    const fixed = interleavedSchedule({ promptIds: ['p1'], arms: ARMS, reps: 2, warmup: false, counterbalance: false });
    expect(fixed.filter((s) => s.rep === 1).map((s) => s.armId)).toEqual(['on', 'off']);
  });

  it('pays the cold-load cost in warm-ups at the head, one per (prompt, arm)', () => {
    const slots = interleavedSchedule({ promptIds: ['p1', 'p2'], arms: ARMS, reps: 1 });
    const warmups = slots.filter((s) => s.warmup);
    expect(warmups).toHaveLength(4);
    expect(warmups.every((s) => s.rep === -1)).toBe(true);
    expect(Math.max(...warmups.map((s) => s.seq))).toBeLessThan(Math.min(...slots.filter((s) => !s.warmup).map((s) => s.seq)));
  });

  it('catches a reordered schedule that separates the arms in time', () => {
    const slots = interleavedSchedule({ promptIds: ['p1', 'p2'], arms: ARMS, reps: 1, warmup: false });
    // Sort by arm: all of one arm, then all of the other — the sequential-arms failure.
    const resequenced = [...slots].sort((a, b) => a.armId.localeCompare(b.armId)).map((s, i) => ({ ...s, seq: i }));
    const problems = validateSchedule(
      resequenced,
      ARMS.map((a) => a.id),
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/not adjacent in time/);
  });

  it('catches an unpaired cell', () => {
    const slots = interleavedSchedule({ promptIds: ['p1'], arms: ARMS, reps: 1, warmup: false }).filter((s) => s.armId !== 'off');
    expect(validateSchedule(slots, ['on', 'off']).join(' ')).toMatch(/missing arm\(s\) off/);
  });

  it('rejects a schedule that is all warm-up, and a run with fewer than two arms', () => {
    expect(validateSchedule([{ rep: -1, promptId: 'p1', armId: 'on', seq: 0, warmup: true }], ['on'])).toEqual([
      'schedule contains no measured slots — every slot is a warm-up',
    ]);
    expect(() => interleavedSchedule({ promptIds: ['p1'], arms: [ARMS[0]], reps: 1 })).toThrow(/at least 2 arms/);
    expect(() => interleavedSchedule({ promptIds: [], arms: ARMS, reps: 1 })).toThrow(/at least one prompt/);
  });
});

describe('serialization', () => {
  it('throws rather than queueing a second measurement on one target', () => {
    // Silently queueing hides the mistake; a concurrent measurement on one machine produced a
    // perfect alternating pattern that was published as a noise floor and was self-inflicted.
    const guard = new SerialGuard();
    guard.acquire('target-a', 'uplift run');
    expect(() => guard.acquire('target-a', 'noise floor')).toThrow(/already running/);
    // Two different machines may be measured at once without interfering.
    expect(() => guard.acquire('target-b', 'uplift run')).not.toThrow();
    guard.release('target-a');
    expect(() => guard.acquire('target-a', 'uplift run')).not.toThrow();
    expect(guard.held().sort()).toEqual(['target-a', 'target-b']);
  });
});

describe('noise floor', () => {
  it('reports the spread and whether there were enough identical calls to trust it', () => {
    const thin = noiseFloor([1, 2]);
    expect(thin.sufficient).toBe(false);
    expect(thin.spreadRatio).toBe(2);
    expect(thin.note).toMatch(new RegExp(`${NOISE_FLOOR_MIN_SAMPLES} are needed`));
    const full = noiseFloor([1, 1.1, 1.2, 1.05, 1.15]);
    expect(full.sufficient).toBe(true);
    expect(full.n).toBe(5);
  });

  it('refuses to call anything real when nothing usable was measured', () => {
    const none = noiseFloor([0, -1, Number.NaN, Number.POSITIVE_INFINITY]);
    expect(none.n).toBe(0);
    expect(none.spreadRatio).toBeNull();
    expect(none.note).toMatch(/no difference can be called real/);
    expect(noiseFloor([2]).spreadRatio).toBeNull();
  });
});

describe('which prompts a benchmark may pair at all', () => {
  it('excludes prompts that generate nothing and prompts that fan out', () => {
    // An embedding or envelope probe has no decode rate — including one contributes a zero to a
    // rate that should have excluded it; a burst measures the scheduler and creates contention.
    const { usable, excluded } = benchablePrompts([
      { id: 'code', contentClass: 'code', fanout: 1 },
      { id: 'embed', contentClass: 'none', fanout: 1 },
      { id: 'burst', contentClass: 'prose', fanout: 6 },
    ]);
    expect(usable.map((p) => p.id)).toEqual(['code']);
    expect(excluded.map((e) => e.id).sort()).toEqual(['burst', 'embed']);
    expect(excluded.find((e) => e.id === 'embed')?.why).toMatch(/rather than zero/);
  });
});

describe('determinism', () => {
  it('does not grade a mismatch as a failure on a build that was never output-lossless', () => {
    const { expectation, why } = determinismExpectation({ backend: 'lucebox', speculative: true });
    expect(expectation).toBe('not-lossless');
    const verdict = determinismVerdict({ texts: ['alpha', 'beta'], expectation, why });
    expect(verdict.verdict).toBe('expected-nondeterminism');
    expect(verdict.isTestFailure).toBe(false);
  });

  it('grades a mismatch as a real defect only where losslessness was actually established', () => {
    const verdict = determinismVerdict({ texts: ['alpha', 'beta'], expectation: 'lossless-expected' });
    expect(verdict.verdict).toBe('finding');
    expect(verdict.isTestFailure).toBe(true);
  });

  it('records an unverified build as an observation rather than a red run', () => {
    const { expectation } = determinismExpectation({ backend: 'ollama', speculative: true });
    expect(expectation).toBe('unknown');
    const verdict = determinismVerdict({ texts: ['alpha', 'beta'], expectation });
    expect(verdict.isTestFailure).toBe(false);
  });

  it("treats a caller's own negative control as authoritative for the control arm", () => {
    // A machine whose plain autoregressive path differs from itself at temperature 0 cannot have its
    // control arm hashed as a gate either. It is caller-supplied because it is a property of one
    // machine, and this module holds no list of machines.
    const { expectation } = determinismExpectation({ backend: 'ollama', speculative: false, nondeterministicAtTemperatureZero: true });
    expect(expectation).toBe('not-lossless');
  });

  it('needs two samples before it says anything', () => {
    const verdict = determinismVerdict({ texts: ['alpha'], expectation: 'lossless-expected' });
    expect(verdict.verdict).toBe('insufficient');
    expect(verdict.isTestFailure).toBe(false);
  });

  it('hashes equal input to an equal 16-hex digest', () => {
    expect(hashOutput('alpha')).toBe(hashOutput('alpha'));
    expect(hashOutput('alpha')).not.toBe(hashOutput('alphb'));
    expect(hashOutput('')).toMatch(/^[0-9a-f]{16}$/);
  });
});
