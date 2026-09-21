/**
 * The matrix's one guarantee: every (engine x dimension) cell is either COVERED — by bank entries
 * that really do target that engine, or by a named probe — or SKIPPED with a sourced reason. There
 * is no third state, and the tests below are the thing that makes that true rather than aspirational.
 *
 * The failure the module exists to prevent is absence, which is invisible by construction: a driver
 * dropped from a bank entry's `backends` array produces no row at all, and a results file cannot
 * distinguish "never asked" from "asked and had nothing to say". So the ledger is asserted to add up
 * both ways — no gaps, and no skip claiming a driver cannot do something the bank in fact asks it.
 */

import { INFERENCE_BACKEND_TYPES, type InferenceBackendType } from '@ci-hub/common/types';
import { describe, expect, it } from 'vitest';
import { SPEC_OFF_TRAPS } from '../bench-ab';
import {
  CONFORMANCE_DIMENSIONS,
  CONFORMANCE_DIMENSION_IDS,
  type ConformancePrompt,
  DIMENSION_BANK_IDS,
  DIMENSION_PROBES,
  DIMENSION_SKIPS,
  OLLAMA_SPEC_MIN_VERSION,
  SPEC_DECODE,
  THINKING_SUPPRESSION,
  compareVersions,
  conformanceCell,
  conformanceMatrix,
  coverageSummary,
  driverMatrix,
  matrixGaps,
  ollamaSpecGate,
  staleSkips,
} from '../driver-conformance';
import { LLM_PROMPT_BANK } from '../prompt-bank';

/** The shipped bank, reduced to what the matrix reads. */
const BANK: ConformancePrompt[] = LLM_PROMPT_BANK.map((p) => ({ id: p.id, backends: p.backends as readonly InferenceBackendType[] }));

describe('the ledger adds up', () => {
  it('no cell is silently absent — matrixGaps is empty against the shipped bank', () => {
    const gaps = matrixGaps(BANK).map((c) => `${c.backend}/${c.dimension}`);
    expect(gaps).toEqual([]);
  });

  it('covered + skipped accounts for every dimension, on every engine', () => {
    // The arithmetic IS the guarantee: if these three ever fail to sum, a cell fell out of the
    // report rather than being explained in it.
    const summary = coverageSummary(BANK);
    for (const backend of INFERENCE_BACKEND_TYPES) {
      const row = summary[backend];
      expect(row.covered + row.skipped + row.gap, `${backend} does not account for every dimension`).toBe(CONFORMANCE_DIMENSION_IDS.length);
      expect(row.gap, `${backend} has unexplained cells`).toBe(0);
      expect(row.covered, `${backend} is asked nothing at all`).toBeGreaterThan(0);
    }
    expect(conformanceMatrix(BANK)).toHaveLength(INFERENCE_BACKEND_TYPES.length * CONFORMANCE_DIMENSION_IDS.length);
  });

  it('every skipped cell carries a reason, and every covered cell carries its evidence', () => {
    for (const cell of conformanceMatrix(BANK)) {
      if (cell.status === 'skipped') {
        expect(cell.reason, `${cell.backend}/${cell.dimension} is skipped with no reason`).toBeTruthy();
        // A vague skip is worse than no skip — it prints a confident claim with nothing behind it.
        expect((cell.reason ?? '').length, `${cell.backend}/${cell.dimension} skip reason is too thin to check`).toBeGreaterThan(40);
      } else {
        expect(cell.bankPromptIds.length > 0 || cell.probe !== null, `${cell.backend}/${cell.dimension} is covered by nothing`).toBe(true);
      }
    }
  });

  it('no skip claims an engine cannot do something the bank actually asks it', () => {
    // A stale skip is louder than a gap and worse: it prints "this engine cannot do X" over a row
    // that ran and passed.
    expect(staleSkips(BANK)).toEqual([]);
  });

  it('dropping a driver from a bank entry turns the cell into a GAP, not into silence', () => {
    // The regression in miniature. `openai-chat` is the one dimension with no legitimate skip, so
    // removing its bank coverage must surface — a matrix that quietly reported five engines instead
    // of six is exactly the reading failure this module was written for.
    const narrowed = BANK.map((p) =>
      DIMENSION_BANK_IDS['openai-chat'].includes(p.id) ? { ...p, backends: p.backends.filter((b) => b !== 'vllm') } : p,
    );
    const gaps = matrixGaps(narrowed);
    expect(gaps.map((c) => `${c.backend}/${c.dimension}`)).toContain('vllm/openai-chat');
    expect(coverageSummary(narrowed).vllm.gap).toBe(1);
  });

  it('a skip left behind by a widened backends array is reported as stale', () => {
    // The opposite drift: an engine gains a route, the bank entry is widened, and the old "cannot do
    // this" reason stays. `native-chat` is skipped for everything but ollama.
    const widened: ConformancePrompt[] = BANK.map((p) => (p.id === 'ollama-native-chat' ? { ...p, backends: [...p.backends, 'mtplx'] } : p));
    const stale = staleSkips(widened);
    expect(stale.map((s) => `${s.backend}/${s.dimension}`)).toContain('mtplx/native-chat');
    expect(stale.find((s) => s.backend === 'mtplx')?.bankPromptIds).toContain('ollama-native-chat');
  });

  it('an empty bank leaves only what this module itself declares', () => {
    // Proves coverage is read from the prompts passed in rather than baked in: with no bank at all,
    // every remaining covered cell must be backed by a probe this file declares.
    for (const cell of conformanceMatrix([])) {
      if (cell.status === 'covered') expect(cell.probe, `${cell.backend}/${cell.dimension} claims coverage with no bank and no probe`).toBeTruthy();
      expect(cell.bankPromptIds).toEqual([]);
    }
  });

  it('a cell covered by the bank ignores its declared skip rather than suppressing coverage', () => {
    // Order matters inside conformanceCell: coverage wins, and the conflict surfaces via staleSkips.
    const cell = conformanceCell('ollama', 'native-chat', BANK);
    expect(cell.status).toBe('covered');
    expect(cell.reason).toBeNull();
  });

  it('every dimension declares why it exists, and the id list matches the table', () => {
    expect(CONFORMANCE_DIMENSION_IDS).toEqual(CONFORMANCE_DIMENSIONS.map((d) => d.id));
    expect(new Set(CONFORMANCE_DIMENSION_IDS).size).toBe(CONFORMANCE_DIMENSION_IDS.length);
    for (const d of CONFORMANCE_DIMENSIONS) expect(d.why.length, `dimension '${d.id}' has no rationale`).toBeGreaterThan(40);
    // Every dimension must be reachable by the resolver, or its column is dead.
    expect(Object.keys(DIMENSION_BANK_IDS).sort()).toEqual([...CONFORMANCE_DIMENSION_IDS].sort());
  });

  it('probes and skips only name dimensions that exist', () => {
    const known = new Set<string>(CONFORMANCE_DIMENSION_IDS);
    for (const key of Object.keys(DIMENSION_PROBES)) expect(known.has(key), `probe declared for unknown dimension '${key}'`).toBe(true);
    for (const key of Object.keys(DIMENSION_SKIPS)) expect(known.has(key), `skip declared for unknown dimension '${key}'`).toBe(true);
  });

  it('openai-chat is never skipped on any engine — the dimension with no legitimate excuse', () => {
    for (const backend of INFERENCE_BACKEND_TYPES) {
      expect(conformanceCell(backend, 'openai-chat', BANK).status, `${backend} is excused from the one shared route`).toBe('covered');
    }
    expect(driverMatrix('ollama', BANK)).toHaveLength(CONFORMANCE_DIMENSION_IDS.length);
  });
});

describe('SPEC_DECODE', () => {
  it('describes every engine, each with sourced evidence', () => {
    expect(Object.keys(SPEC_DECODE).sort()).toEqual([...INFERENCE_BACKEND_TYPES].sort());
    for (const backend of INFERENCE_BACKEND_TYPES) {
      const row = SPEC_DECODE[backend];
      expect(row.backend).toBe(backend);
      // An unsourced claim is a guess, and this whole table exists because guesses from vendor docs
      // got two of these rows wrong. An 'unmeasured' row is held to this too: saying nobody has run
      // the engine is itself a claim about the fleet, and it has to say so at length.
      expect(row.evidence.length, `${backend} states a capability with no evidence`).toBeGreaterThan(60);
      // ...but only a row that claims a capability must name the switch. An 'unmeasured' row that
      // named one would be the guess the table refuses; naming none is the whole content of it.
      if (row.capable === 'unmeasured') {
        expect(row.toggleOn, `${backend} is unmeasured but names a toggle anyway`).toBeNull();
        expect(row.offArm, `${backend} is unmeasured but names an off arm anyway`).toBeNull();
        expect(row.observable, `${backend} is unmeasured but claims something is observable`).toBeNull();
        continue;
      }
      expect(row.toggleOn ?? row.offArm, `${backend} names no way to change the speculative state`).toBeTruthy();
    }
  });

  it('exactly two of the "off" switches do not actually turn speculation off', () => {
    // The headline claim of the module, asserted as a count so a third trap cannot be added without
    // the docs above it being reread — and so neither of these two can quietly be deleted.
    const traps = INFERENCE_BACKEND_TYPES.filter((b) => SPEC_DECODE[b].falseOffArm !== null);
    expect(traps.sort()).toEqual(['dspark', 'lemonade']);
    // dspark's is a false OFF: the parameter is silently coerced, so the control arm speculates too.
    expect(SPEC_DECODE.dspark.falseOffArm).toMatch(/max_draft/);
    expect(SPEC_DECODE.dspark.falseOffArm).toMatch(/coerced/i);
    // lemonade's is the mirror image — a false ON that loads a drafter and never drafts a token.
    expect(SPEC_DECODE.lemonade.falseOffArm).toMatch(/false ON/);
  });

  it("the benchmark's control-arm traps and the capability table name the same parameter", () => {
    // Two files that must not drift: bench-ab refuses an arm that sets the parameter dspark coerces.
    expect(SPEC_OFF_TRAPS.map((t) => t.param)).toContain('max_draft');
    const maxDraft = SPEC_OFF_TRAPS.find((t) => t.param === 'max_draft');
    expect(maxDraft?.value).toBe(0);
    expect(SPEC_DECODE.dspark.falseOffArm).toContain(maxDraft?.param ?? 'unreachable');
  });

  it('separates "can be toggled" from "can be observed"', () => {
    // The asymmetry is the reason `reach` and `observable` are different fields: an engine that
    // cannot be toggled by a request can still report, per completion, whether the drafter ran.
    expect(SPEC_DECODE.lucebox.reach).toBe('launch-flag');
    expect(SPEC_DECODE.lucebox.observable).toBeTruthy();
    // vLLM is the one engine that was DRIVEN and says nothing read-only, which is why its cell is a
    // sourced skip. The unmeasured engines skip too, but for a weaker reason, and the two must not
    // be allowed to read as the same finding — so they are asserted apart.
    expect(SPEC_DECODE.vllm.capable).not.toBe('unmeasured');
    expect(SPEC_DECODE.vllm.observable).toBeNull();
    expect(conformanceCell('vllm', 'spec-decode-capability', BANK).status).toBe('skipped');
    const unmeasured = INFERENCE_BACKEND_TYPES.filter((b) => SPEC_DECODE[b].capable === 'unmeasured');
    for (const backend of unmeasured) {
      const cell = conformanceCell(backend, 'spec-decode-capability', BANK);
      expect(cell.status, `${backend} spec-decode cell`).toBe('skipped');
      expect(cell.reason, `${backend} skips without saying it is unmeasured`).toMatch(/not measured/i);
    }
    // Every engine that was driven and does answer gets a probe rather than a skip.
    for (const backend of INFERENCE_BACKEND_TYPES.filter((b) => b !== 'vllm' && !unmeasured.includes(b))) {
      expect(conformanceCell(backend, 'spec-decode-capability', BANK).status, `${backend} spec-decode cell`).toBe('covered');
    }
  });

  it('an engine togglable from an ordinary request keeps its off arm in the request too', () => {
    for (const backend of INFERENCE_BACKEND_TYPES) {
      const row = SPEC_DECODE[backend];
      if (row.reach === 'request-param') expect(row.offArm, `${backend} can be turned on by a request but not off by one`).toBeTruthy();
    }
  });
});

describe('THINKING_SUPPRESSION', () => {
  it('names the spelling that works and the spelling that answers 200 and does nothing', () => {
    // The trap the table exists for: copying the ollama override to mtplx reproduces a run where the
    // entire token budget goes to hidden reasoning and nothing in the response says so.
    expect(THINKING_SUPPRESSION.mtplx.works).toMatch(/enable_thinking/);
    expect(THINKING_SUPPRESSION.mtplx.silentNoOp).toMatch(/reasoning_effort/);
    expect(THINKING_SUPPRESSION.ollama.works).toMatch(/reasoning_effort/);
  });

  it('never lists one spelling as both working and a no-op, and always says where that was established', () => {
    for (const backend of INFERENCE_BACKEND_TYPES) {
      const row = THINKING_SUPPRESSION[backend];
      expect(row.backend).toBe(backend);
      expect(row.evidence.length, `${backend} suppression claim has no evidence`).toBeGreaterThan(40);
      if (row.works && row.silentNoOp) expect(row.works).not.toBe(row.silentNoOp);
    }
  });
});

describe('the ollama version gate', () => {
  it('compares version parts numerically, not lexicographically', () => {
    // '0.9.0' sorts after '0.30.8' as text and before it as a version. Getting this backwards would
    // report an old build as capable.
    expect(compareVersions('0.9.0', '0.30.8')).toBe(-1);
    expect(compareVersions('0.30.8', '0.30.8')).toBe(0);
    expect(compareVersions('0.33.3', '0.30.8')).toBe(1);
    expect(compareVersions('v0.30.8', '0.30.8')).toBe(0);
    expect(compareVersions('0.31', '0.30.8')).toBe(1);
    // A pre-release suffix is ignored rather than ranked below the release, so a build labelled
    // `-rc1` at the gate version reads as capable. The gate's caveat is what covers the rest.
    expect(compareVersions('0.30.8-rc1', '0.30.8')).toBe(0);
    expect(ollamaSpecGate('0.30.8-rc1').gate).toBe('capable');
  });

  it('is inclusive at the gate and reports too-old below it', () => {
    expect(ollamaSpecGate(OLLAMA_SPEC_MIN_VERSION).gate).toBe('capable');
    expect(ollamaSpecGate('0.30.7').gate).toBe('too-old');
    expect(ollamaSpecGate('0.33.3').gate).toBe('capable');
  });

  it('an absent version is unknown, never capable', () => {
    for (const v of [null, undefined, '']) {
      const verdict = ollamaSpecGate(v);
      expect(verdict.gate).toBe('unknown');
      expect(verdict.version).toBeNull();
    }
  });

  it('always carries the caveat that clearing the gate is not proof of activation', () => {
    // A build two minor versions past this gate was measured silently discarding every drafter
    // option. A verdict without the caveat would report success for work the engine never did.
    for (const v of [null, '0.30.7', '0.33.3']) {
      expect(ollamaSpecGate(v).caveat).toMatch(/BUILD GATE ONLY/);
    }
  });
});
