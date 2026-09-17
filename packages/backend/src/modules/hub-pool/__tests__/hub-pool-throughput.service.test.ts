import { describe, expect, it } from 'vitest';
import {
  HubPoolThroughputService,
  MAX_ADVERTISED_THROUGHPUT,
  THROUGHPUT_FORGET_AFTER_MS,
  THROUGHPUT_HALF_LIFE_MS,
  THROUGHPUT_HOLD_MS,
  MAX_PREFILL_GROWTH,
  THROUGHPUT_MIN_PROMPT_TOKENS,
  evidenceWeight,
  effectivePrefillPoint,
  mergeDecode,
  mergePrefillEvidence,
  missesBudget,
  predictPrefill,
  prefillBand,
  prefillPointsOf,
  readAdvertisedThroughput,
  type PrefillBandEvidence,
  type PrefillPoint,
  type PrefillPrediction,
  type SourcedPrefillPoint,
} from '../hub-pool-throughput.service';

const NOW = 1_800_000_000_000;
const MODEL = 'qwen3-coder:30b';
const FZZY = { nodeKey: 'fzzy', backend: 'ollama', model: MODEL } as const;

/** A point measured at `tokensPerSec` on a prompt of `promptTokens`, `ageMs` ago. */
function point(promptTokens: number, tokensPerSec: number, options: { ageMs?: number; deadline?: boolean } = {}): SourcedPrefillPoint {
  return { msPerToken: 1000 / tokensPerSec, promptTokens, deadline: options.deadline ?? false, at: NOW - (options.ageMs ?? 0), source: 'observed' };
}

describe('prefillBand', () => {
  it('starts at THROUGHPUT_MIN_PROMPT_TOKENS and doubles', () => {
    expect(prefillBand(THROUGHPUT_MIN_PROMPT_TOKENS - 1)).toBeNull();
    expect(prefillBand(4_096)).toBe(0);
    expect(prefillBand(8_191)).toBe(0);
    expect(prefillBand(8_192)).toBe(1);
    // The fleet's two turns: fzzy served ~10.6k and could not start ~46k.
    expect(prefillBand(10_600)).toBe(1);
    expect(prefillBand(46_000)).toBe(3);
  });

  it('puts everything past the last edge in the last band, and nonsense in none', () => {
    expect(prefillBand(10_000_000)).toBe(7);
    expect(prefillBand(Number.NaN)).toBeNull();
    expect(prefillBand(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('prefill band evidence', () => {
  const slow: PrefillPoint = { msPerToken: 20, promptTokens: 46_000, deadline: true, at: NOW };
  const cacheHit = (at: number): PrefillPoint => ({ msPerToken: 0.5, promptTokens: 46_500, deadline: false, at });

  it('lets slower evidence replace the band at once', () => {
    const slower = { msPerToken: 25, promptTokens: 40_000, deadline: false, at: NOW + 1_000 };

    expect(mergePrefillEvidence({ slow, recent: null }, slower, NOW + 1_000)).toEqual({ slow: slower, recent: null });
  });

  it('holds fresh slow evidence against a run of fast cache-hit turns', () => {
    let evidence: PrefillBandEvidence = { slow, recent: null };
    for (let turn = 1; turn <= 10; turn += 1) {
      evidence = mergePrefillEvidence(evidence, cacheHit(NOW + turn * 30_000), NOW + turn * 30_000);
    }
    const reading = effectivePrefillPoint(evidence, NOW + 300_000);

    // Ten turns weigh what the last one does, and the deadline is still inside its hold: it reads
    // exactly as it was recorded, which is what keeps a deadline recorded AT its budget from reading
    // as just inside it.
    expect(reading).toEqual(slow);
  });

  it('holds through THROUGHPUT_HOLD_MS, then gives way to a faster sample as it decays: halfway one half-life later', () => {
    const evidence = mergePrefillEvidence({ slow, recent: null }, { ...cacheHit(NOW + 60_000), msPerToken: 2 }, NOW + 60_000);

    expect(effectivePrefillPoint(evidence, NOW + THROUGHPUT_HOLD_MS)?.msPerToken).toBe(20);
    expect(effectivePrefillPoint(evidence, NOW + THROUGHPUT_HOLD_MS + THROUGHPUT_HALF_LIFE_MS)?.msPerToken).toBeCloseTo(11, 6);
    expect(effectivePrefillPoint(evidence, NOW + THROUGHPUT_HOLD_MS + 2 * THROUGHPUT_HALF_LIFE_MS)?.msPerToken).toBeCloseTo(6.5, 6);
  });

  it('reads as the recent sample once the slow evidence is forgotten, and as nothing once both are', () => {
    const recentAt = NOW + THROUGHPUT_HALF_LIFE_MS;
    const evidence: PrefillBandEvidence = { slow, recent: { ...cacheHit(recentAt), msPerToken: 2 } };

    expect(effectivePrefillPoint(evidence, NOW + THROUGHPUT_FORGET_AFTER_MS)).toEqual({ ...cacheHit(recentAt), msPerToken: 2 });
    expect(effectivePrefillPoint(evidence, recentAt + THROUGHPUT_FORGET_AFTER_MS)).toBeNull();
  });

  it('starts over from a sample slower than the band currently reads', () => {
    const decayed = { slow, recent: { ...cacheHit(NOW), msPerToken: 2 } };
    const at = NOW + THROUGHPUT_HOLD_MS + 2 * THROUGHPUT_HALF_LIFE_MS; // reads 6.5 ms/token here
    const next = { msPerToken: 8, promptTokens: 46_000, deadline: false, at };

    expect(mergePrefillEvidence(decayed, next, at)).toEqual({ slow: next, recent: null });
  });
});

describe('mergeDecode', () => {
  it('is a mean whose older samples count for less', () => {
    const first = mergeDecode(undefined, 10, NOW);
    const second = mergeDecode(first, 20, NOW + THROUGHPUT_HALF_LIFE_MS);

    // (10 * 0.5 + 20) / (1 * 0.5 + 1)
    expect(second.tokensPerSecSum / second.weight).toBeCloseTo(50 / 3, 6);
  });
});

describe('predictPrefill', () => {
  it('never reads a larger prompt back onto a smaller one', () => {
    // A slower rate at a larger size says little about a smaller prompt, so it is not applied at all.
    expect(predictPrefill([point(46_000, 40)], 10_600, NOW)).toBeNull();
    // At or below the measured size there is nothing to read forward: the measurement stands flat.
    expect(predictPrefill([point(46_000, 40)], 36_000, NOW)).toMatchObject({ predictedMs: 900_000, extrapolated: false });
  });

  it('uses the slowest applicable evidence from either source', () => {
    const advertisedFast = { ...point(46_000, 496), source: 'advertised' as const };
    const observedDeadline = point(46_000, 50, { deadline: true });

    expect(predictPrefill([advertisedFast, observedDeadline], 46_000, NOW)).toEqual({
      predictedMs: 920_000,
      tokensPerSec: 50,
      fromPromptTokens: 46_000,
      extrapolated: false,
      deadline: true,
      source: 'observed',
    });
  });

  /**
   * Reading a measurement forward is what places the FIRST long turn correctly. The fleet numbers are
   * the test: fzzy read a 10.6k-token prompt at ~123 tok/s and then could not start a ~46k one inside
   * 922 s, while beta-max's GPU `qwen3.6:27b` barely slowed at all (192 → 157 tok/s over 47k).
   */
  describe('reading a measurement forward', () => {
    it("demotes fzzy's 46k turn from its 10.6k measurement alone, before any deadline was missed", () => {
      const prediction = predictPrefill([point(10_600, 123)], 46_000, NOW);

      // 4.34x the prompt, so the whole growth factor applies: ~123 tok/s read forward as ~41.
      expect(prediction).toMatchObject({ tokensPerSec: 123, fromPromptTokens: 10_600, extrapolated: true });
      expect(prediction?.predictedMs).toBe(Math.round((46_000 / 123) * 1000 * MAX_PREFILL_GROWTH));
      expect(missesBudget(prediction as NonNullable<typeof prediction>, 920_000)).toBe(true);
    });

    it('leaves a GPU node alone at the same prompt, because its measured rate has the headroom', () => {
      // beta-max at 8k tokens, where its 27B is still near 190 tok/s.
      const prediction = predictPrefill([point(8_000, 190)], 46_000, NOW);

      expect(prediction?.extrapolated).toBe(true);
      expect(missesBudget(prediction as NonNullable<typeof prediction>, 920_000)).toBe(false);
      // The line this draws: three times the 50 tok/s floor the budget is sized from.
      expect(missesBudget(predictPrefill([point(8_000, 149)], 46_000, NOW) as PrefillPrediction, 920_000)).toBe(true);
      expect(missesBudget(predictPrefill([point(8_000, 151)], 46_000, NOW) as PrefillPrediction, 920_000)).toBe(false);
    });

    it('grows in proportion to how much further the prompt is, and stops at MAX_PREFILL_GROWTH', () => {
      const measured = [point(8_000, 100)];

      expect(predictPrefill(measured, 8_000, NOW)?.predictedMs).toBe(80_000);
      expect(predictPrefill(measured, 16_000, NOW)?.predictedMs).toBe(320_000); // 2x the prompt, 2x the cost per token
      // 12x the prompt would be 12x per token; the cap refuses to extrapolate that far.
      expect(predictPrefill(measured, 96_000, NOW)?.predictedMs).toBe(96_000 * 10 * MAX_PREFILL_GROWTH);
    });

    it('reads only the nearest measurement forward, so a direct one is never overruled by a distant guess', () => {
      // 200 tok/s at 5k and 125 tok/s at 40k: the same node, slowing as the prompt grows. Growing the
      // 5k reading 3x would claim ~690 s for 46k; the 40k one is a quarter of a band away.
      const prediction = predictPrefill([point(5_000, 200), point(40_000, 125)], 46_000, NOW);

      expect(prediction).toMatchObject({ fromPromptTokens: 40_000, tokensPerSec: 125, extrapolated: true });
      expect(prediction?.predictedMs).toBe(Math.round((46_000 / 125) * 1000 * (46_000 / 40_000)));
    });

    it('still takes the slowest reading at or below the size as a floor, even against a faster direct one', () => {
      // 50 tok/s at 5k and 125 tok/s at 40k cannot both describe the same engine — per-token cost does
      // not fall as a prompt grows, so the 40k reading is a prefix-cache hit and the floor holds.
      const prediction = predictPrefill([point(5_000, 50), point(40_000, 125)], 46_000, NOW);

      expect(prediction).toMatchObject({ fromPromptTokens: 5_000, tokensPerSec: 50, extrapolated: false });
      expect(prediction?.predictedMs).toBe(46_000 * 20);
    });

    it('keeps the flat floor when it is slower than the reading-forward', () => {
      // The 20k deadline says "at least 40 s per 1k tokens" and the nearest reading grown is under that.
      const prediction = predictPrefill([point(20_000, 25, { deadline: true }), point(40_000, 400)], 44_000, NOW);

      expect(prediction).toMatchObject({ fromPromptTokens: 20_000, deadline: true, extrapolated: false });
      expect(prediction?.predictedMs).toBe(Math.round(44_000 * 40));
    });
  });

  it('is unmeasured below the smallest band, and once evidence is forgotten', () => {
    expect(predictPrefill([point(4_096, 1)], 4_000, NOW)).toBeNull();
    expect(predictPrefill([point(46_000, 20, { ageMs: THROUGHPUT_FORGET_AFTER_MS })], 46_000, NOW)).toBeNull();
    expect(predictPrefill([point(46_000, 20, { ageMs: THROUGHPUT_FORGET_AFTER_MS - 1 })], 46_000, NOW)).not.toBeNull();
  });
});

describe('missesBudget', () => {
  it('treats a deadline replayed at its own size as a miss, and a served sample at the budget as a pass', () => {
    // Same size, so nothing is read forward and the recorded figures stand exactly.
    const budget = 920_000;
    const deadline = predictPrefill([point(46_000, 50, { deadline: true })], 46_000, NOW);
    const served = predictPrefill([point(46_000, 50)], 46_000, NOW);

    expect(deadline?.predictedMs).toBe(budget);
    expect(missesBudget(deadline as NonNullable<typeof deadline>, budget)).toBe(true);
    expect(missesBudget(served as NonNullable<typeof served>, budget)).toBe(false);
  });
});

describe('evidenceWeight', () => {
  it('holds, then halves every half-life', () => {
    expect(evidenceWeight(NOW, NOW)).toBe(1);
    expect(evidenceWeight(NOW, NOW + THROUGHPUT_HOLD_MS)).toBe(1);
    expect(evidenceWeight(NOW, NOW + THROUGHPUT_HOLD_MS + THROUGHPUT_HALF_LIFE_MS)).toBeCloseTo(0.5, 9);
    expect(evidenceWeight(NOW, NOW + THROUGHPUT_HOLD_MS + 2 * THROUGHPUT_HALF_LIFE_MS)).toBeCloseTo(0.25, 9);
  });
});

describe('readAdvertisedThroughput', () => {
  const valid = {
    model: MODEL,
    backend: 'ollama',
    prefill: [{ fromTokens: 32_768, promptTokens: 46_000, tokensPerSec: 50, deadline: true, ageMs: 60_000 }],
    decode: { tokensPerSec: 11.2, ageMs: 60_000 },
  };

  it('keeps a well-formed advert and ages it by how old the snapshot is', () => {
    expect(readAdvertisedThroughput([valid], 30_000)).toEqual([
      {
        model: MODEL,
        backend: 'ollama',
        prefill: [{ fromTokens: 32_768, promptTokens: 46_000, tokensPerSec: 50, deadline: true, ageMs: 90_000 }],
        decode: { tokensPerSec: 11.2, ageMs: 90_000 },
      },
    ]);
  });

  it('recomputes the band from the prompt size instead of trusting the advertised edge', () => {
    const claimsSmallerBand = { ...valid, prefill: [{ ...valid.prefill[0], fromTokens: 4_096 }] };

    expect(readAdvertisedThroughput([claimsSmallerBand], 0)[0]?.prefill[0]?.fromTokens).toBe(32_768);
  });

  it.each([
    ['not an array', { ...valid }],
    ['an unknown backend', [{ ...valid, backend: 'llamafile' }]],
    ['a non-string model', [{ ...valid, model: 42 }]],
    ['a string rate', [{ ...valid, decode: null, prefill: [{ ...valid.prefill[0], tokensPerSec: '50' }] }]],
    ['a zero rate', [{ ...valid, decode: null, prefill: [{ ...valid.prefill[0], tokensPerSec: 0 }] }]],
    ['a negative age', [{ ...valid, decode: null, prefill: [{ ...valid.prefill[0], ageMs: -1 }] }]],
    ['a prompt below the smallest band', [{ ...valid, decode: null, prefill: [{ ...valid.prefill[0], promptTokens: 1_000 }] }]],
    ['a fractional prompt size', [{ ...valid, decode: null, prefill: [{ ...valid.prefill[0], promptTokens: 46_000.5 }] }]],
    ['evidence past its forget time', [{ ...valid, decode: null, prefill: [{ ...valid.prefill[0], ageMs: THROUGHPUT_FORGET_AFTER_MS }] }]],
  ])('drops %s', (_label, raw) => {
    expect(readAdvertisedThroughput(raw, 0)).toEqual([]);
  });

  it('treats an unknown snapshot age as too old to use', () => {
    expect(readAdvertisedThroughput([valid], Number.NaN)).toEqual([]);
  });

  it('keeps the slowest point when a band is advertised twice, and caps the list', () => {
    const twice = { ...valid, prefill: [valid.prefill[0], { ...valid.prefill[0], promptTokens: 40_000, tokensPerSec: 30 }] };
    const many = Array.from({ length: MAX_ADVERTISED_THROUGHPUT + 5 }, (_, index) => ({ ...valid, model: `m${index}` }));

    expect(readAdvertisedThroughput([twice], 0)[0]?.prefill).toEqual([
      { fromTokens: 32_768, promptTokens: 40_000, tokensPerSec: 30, deadline: true, ageMs: 60_000 },
    ]);
    expect(readAdvertisedThroughput(many, 0)).toHaveLength(MAX_ADVERTISED_THROUGHPUT);
  });

  it('turns back into the points it was made from', () => {
    const [estimate] = readAdvertisedThroughput([valid], 0);

    expect(prefillPointsOf(estimate as NonNullable<typeof estimate>, 'advertised', NOW)).toEqual([
      { msPerToken: 20, promptTokens: 46_000, deadline: true, at: NOW - 60_000, source: 'advertised' },
    ]);
  });
});

describe('HubPoolThroughputService', () => {
  it('reports what it recorded, per band, in the shape it advertises', () => {
    const service = new HubPoolThroughputService();
    service.recordPrefill(FZZY, { promptTokens: 10_600, ms: (10_600 / 123) * 1000, deadline: false }, NOW);
    service.recordPrefill(FZZY, { promptTokens: 46_000, ms: 922_000, deadline: true }, NOW);
    service.recordDecode(FZZY, { tokens: 600, ms: 50_000 }, NOW);

    expect(service.estimatesFor('fzzy', NOW + 5_000)).toEqual([
      {
        model: MODEL,
        backend: 'ollama',
        prefill: [
          { fromTokens: 8_192, promptTokens: 10_600, tokensPerSec: 123, deadline: false, ageMs: 5_000 },
          { fromTokens: 32_768, promptTokens: 46_000, tokensPerSec: 49.8, deadline: true, ageMs: 5_000 },
        ],
        decode: { tokensPerSec: 12, ageMs: 5_000 },
      },
    ]);
    expect(service.estimatesFor('core-6', NOW)).toEqual([]);
  });

  it('ignores samples that measure fixed costs rather than speed', () => {
    const service = new HubPoolThroughputService();
    service.recordPrefill(FZZY, { promptTokens: 2_000, ms: 60_000, deadline: false }, NOW);
    service.recordPrefill(FZZY, { promptTokens: 46_000, ms: 0, deadline: false }, NOW);
    service.recordDecode(FZZY, { tokens: 4, ms: 60_000 }, NOW);
    service.recordDecode(FZZY, { tokens: 400, ms: 100 }, NOW);

    expect(service.estimatesFor('fzzy', NOW)).toEqual([]);
  });

  it('keys `name` and `name:latest` as one model, as the inventory does', () => {
    const service = new HubPoolThroughputService();
    service.recordPrefill({ nodeKey: 'fzzy', backend: 'ollama', model: 'llama3.2' }, { promptTokens: 8_000, ms: 80_000, deadline: false }, NOW);

    expect(service.prefillPoints({ nodeKey: 'fzzy', backend: 'ollama', model: 'llama3.2:latest' }, NOW)).toHaveLength(1);
  });

  it('forgets evidence on read once it is past its forget time', () => {
    const service = new HubPoolThroughputService();
    service.recordPrefill(FZZY, { promptTokens: 46_000, ms: 922_000, deadline: true }, NOW);

    expect(service.prefillPoints(FZZY, NOW + THROUGHPUT_FORGET_AFTER_MS - 1)).toHaveLength(1);
    expect(service.prefillPoints(FZZY, NOW + THROUGHPUT_FORGET_AFTER_MS)).toEqual([]);
    expect(service.estimatesFor('fzzy', NOW + THROUGHPUT_FORGET_AFTER_MS)).toEqual([]);
  });

  it('stays bounded, evicting the least recently measured engine first', () => {
    const service = new HubPoolThroughputService();
    for (let index = 0; index < 600; index += 1) {
      service.recordPrefill({ nodeKey: `node-${index}`, backend: 'ollama', model: MODEL }, { promptTokens: 8_000, ms: 1_000, deadline: false }, NOW);
    }

    expect(service.estimatesFor('node-0', NOW)).toEqual([]);
    expect(service.estimatesFor('node-599', NOW)).toHaveLength(1);
  });
});
