/**
 * The bank's selection contract: a preset must NARROW the run.
 *
 * The regression these tests exist for was silent in both directions. A request naming a preset
 * recorded the preset id for the report and never expanded it into prompt ids; because an empty
 * selection means "the whole bank", the run then queued every prompt there is while the
 * acknowledgement echoed the preset back as though it had been honoured. Nothing failed, nothing
 * went red, and a run intended as three prompts became thousands of requests.
 *
 * So the tests below assert the two halves separately: that expansion produces a genuinely smaller
 * set, and that the number a caller is told matches the number that would actually run.
 */

import { describe, expect, it } from 'vitest';
import { GENERATED_BANK_DEFAULT, buildGeneratedPrompts, generatedPromptIds, generatedVariantCapacity } from '../prompt-bank-generated';
import {
  LLM_DEFAULT_PRESET,
  LLM_PROMPT_BANK,
  LLM_PROMPT_PRESETS,
  type LlmPreset,
  type LlmPresetId,
  type LlmPrompt,
  isExpensivePrompt,
  presetPromptIds,
  resolveBackendSelection,
  resolvePromptSelection,
} from '../prompt-bank';

/**
 * What a dispatcher must do with `{ preset }` — expansion first, then resolution against the bank
 * the run is really using. Modelled here rather than imported because the module under test holds
 * the two halves and the historical bug lived in the seam between them.
 */
function resolveRunSelection(
  req: { preset?: LlmPresetId; prompts?: readonly string[] },
  bank: readonly LlmPrompt[] = LLM_PROMPT_BANK,
): { prompts: LlmPrompt[]; unknown: string[] } {
  // Explicit ids win over a preset: they are the more specific request.
  const ids = req.prompts?.length ? req.prompts : req.preset ? presetPromptIds(req.preset) : null;
  return resolvePromptSelection(ids, bank);
}

describe('preset narrowing (regression)', () => {
  it('a preset resolves to strictly fewer prompts than the whole bank', () => {
    // The defect in one assertion: `{ preset: 'latency' }` used to resolve to the full bank.
    const latency = resolveRunSelection({ preset: 'latency' });
    expect(latency.prompts).toHaveLength(3);
    expect(latency.prompts.length).toBeLessThan(LLM_PROMPT_BANK.length);
    expect(latency.prompts.map((p) => p.id).sort()).toEqual(['short-chat', 'stream-completeness', 'stream-ttft']);
  });

  it('narrows against the LARGE bank too — the case that cost days of fleet time', () => {
    // The run that misfired had a generated corpus loaded, so the un-narrowed selection was ~1000
    // prompts rather than ~60. A preset must be a function of the preset, not of the bank size.
    const bigBank = [...LLM_PROMPT_BANK, ...buildGeneratedPrompts(200)];
    const smoke = resolveRunSelection({ preset: 'smoke' }, bigBank);
    expect(smoke.prompts).toHaveLength(1);
    expect(smoke.unknown).toEqual([]);
    expect(bigBank.length).toBeGreaterThan(200);
  });

  it('the count reported back equals the count that would run', () => {
    // The echo carried the same bug one layer up: it was built from the request rather than from the
    // resolved selection, so it reported the whole bank while the run correctly ran one prompt.
    for (const preset of LLM_PROMPT_PRESETS) {
      const resolved = resolveRunSelection({ preset: preset.id });
      const echoed = presetPromptIds(preset.id);
      expect(resolved.prompts.map((p) => p.id).sort()).toEqual([...echoed].sort());
    }
  });

  it('an unexpanded preset would resolve to everything — which is why expansion is not optional', () => {
    // Pinning the default that made the bug invisible. If this ever stops being true the narrowing
    // failure mode changes shape, and the tests above need rereading.
    expect(resolvePromptSelection(null).prompts).toHaveLength(LLM_PROMPT_BANK.length);
    expect(resolvePromptSelection([]).prompts).toHaveLength(LLM_PROMPT_BANK.length);
  });

  it('an unknown preset throws rather than quietly meaning "everything"', () => {
    expect(() => presetPromptIds('latencyy' as LlmPresetId)).toThrow(/unknown preset/i);
    // The throw must name the valid set, so a caller can turn it into an actionable 400.
    expect(() => presetPromptIds('nope' as LlmPresetId)).toThrow(/smoke/);
  });

  it('an unknown prompt id is returned, never silently dropped', () => {
    const { prompts, unknown } = resolvePromptSelection(['short-chat', 'shortchat']);
    expect(unknown).toEqual(['shortchat']);
    expect(prompts.map((p) => p.id)).toEqual(['short-chat']);
  });

  it('explicit prompt ids beat a preset', () => {
    const resolved = resolveRunSelection({ preset: 'all', prompts: ['short-chat'] });
    expect(resolved.prompts.map((p) => p.id)).toEqual(['short-chat']);
  });
});

describe('preset integrity', () => {
  it('every shipped preset expands to a real, non-empty, duplicate-free set', () => {
    for (const preset of LLM_PROMPT_PRESETS) {
      const ids = presetPromptIds(preset.id);
      expect(ids.length, `preset '${preset.id}' expands to nothing`).toBeGreaterThan(0);
      expect(new Set(ids).size, `preset '${preset.id}' repeats a prompt id`).toBe(ids.length);
      for (const id of ids)
        expect(
          LLM_PROMPT_BANK.some((p) => p.id === id),
          `preset '${preset.id}' names unknown prompt '${id}'`,
        ).toBe(true);
    }
  });

  it('a preset naming a prompt the bank no longer has throws instead of running a shorter set', () => {
    const ghost: LlmPreset = {
      id: 'ghost' as LlmPresetId,
      label: 'Ghost',
      why: 'fixture: a preset left pointing at a deleted bank entry',
      promptIds: ['short-chat', 'deleted-entry'],
      includeExpensive: false,
      expensive: false,
    };
    LLM_PROMPT_PRESETS.push(ghost);
    try {
      expect(() => presetPromptIds('ghost' as LlmPresetId)).toThrow(/not in the bank: deleted-entry/);
    } finally {
      LLM_PROMPT_PRESETS.pop();
    }
  });

  it("the 'everything' expansion excludes heavy entries unless the preset opts in", () => {
    // The safety valve: heavy work enters a run only because someone named it.
    const standard = presetPromptIds('standard').map((id) => LLM_PROMPT_BANK.find((p) => p.id === id) as LlmPrompt);
    expect(standard.some(isExpensivePrompt)).toBe(false);
    expect(presetPromptIds('all').sort()).toEqual(LLM_PROMPT_BANK.map((p) => p.id).sort());
    expect(presetPromptIds('all').length).toBeGreaterThan(standard.length);
  });

  it('a preset that runs heavy entries says so, and the default preset never does', () => {
    for (const preset of LLM_PROMPT_PRESETS) {
      const heavy = presetPromptIds(preset.id).some((id) => {
        const p = LLM_PROMPT_BANK.find((e) => e.id === id);
        return p ? isExpensivePrompt(p) : false;
      });
      if (heavy) expect(preset.expensive, `preset '${preset.id}' runs heavy entries without saying so`).toBe(true);
    }
    const dflt = LLM_PROMPT_PRESETS.find((p) => p.id === LLM_DEFAULT_PRESET);
    expect(dflt?.expensive).toBe(false);
  });

  it('resolution returns bank order, not the order ids were requested in', () => {
    // The shape of a run must not depend on how the checkboxes were ticked.
    const forward = resolvePromptSelection(['short-chat', 'stream-ttft']).prompts.map((p) => p.id);
    const reversed = resolvePromptSelection(['stream-ttft', 'short-chat']).prompts.map((p) => p.id);
    expect(reversed).toEqual(forward);
  });
});

describe('backend selection', () => {
  it('null or empty means every backend, and an unknown name is reported', () => {
    expect(resolveBackendSelection(null).backends).toHaveLength(6);
    expect(resolveBackendSelection([]).unknown).toEqual([]);
    const picked = resolveBackendSelection(['ollama', 'nope']);
    expect(picked.backends).toEqual(['ollama']);
    expect(picked.unknown).toEqual(['nope']);
  });
});

describe('generated corpus', () => {
  it('is deterministic — same n, same ids, same text, every time', () => {
    // Last week's numbers only compare to today's if the corpus is byte-stable.
    const a = buildGeneratedPrompts(40);
    const b = buildGeneratedPrompts(40);
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
    expect(a.map((p) => p.input.user)).toEqual(b.map((p) => p.input.user));
  });

  it('produces n distinct ids and a prefix-stable sequence', () => {
    const ids = generatedPromptIds(64);
    expect(ids).toHaveLength(64);
    expect(new Set(ids).size).toBe(64);
    // A shorter request is a prefix of a longer one, so narrowing the corpus does not reshuffle it.
    expect(generatedPromptIds(16)).toEqual(ids.slice(0, 16));
  });

  it('the default corpus size stays under the distinct-body capacity', () => {
    // Past capacity, some node answers the same text twice from a warm cache and the extra rows
    // measure the cache rather than the runner.
    expect(GENERATED_BANK_DEFAULT).toBeLessThanOrEqual(generatedVariantCapacity());
  });

  it('files generated entries as load, never as baseline', () => {
    // Filing them as baseline would sweep a thousand rows into the smoke preset.
    for (const p of buildGeneratedPrompts(30)) {
      expect(p.category).toBe('load');
      expect(p.fanout).toBe(1);
      expect(p.params.temperature).toBe(0);
    }
  });

  it('generated ids never collide with curated ids', () => {
    const curated = new Set(LLM_PROMPT_BANK.map((p) => p.id));
    for (const id of generatedPromptIds(120)) expect(curated.has(id)).toBe(false);
  });
});
