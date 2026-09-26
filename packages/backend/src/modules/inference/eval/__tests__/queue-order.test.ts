/**
 * One defect in two parts, both silent, both about a backend that contributes nothing to a results
 * file with no row saying so.
 *
 *   ORDER      one FIFO per host, appended endpoint after endpoint, makes coverage a function of
 *              position: a run read ten minutes in showed every row of the first backend, a couple
 *              of the second and none of the third, all three healthy the whole time.
 *   ACCOUNTING an endpoint the probe DID find is not "missing", so it earns no absent-skip row. If
 *              the run's prompt selection then names none of that backend, it vanishes entirely.
 */

import { describe, expect, it } from 'vitest';
import { type BackendTagged, endpointCoverageSkip, interleaveByBackend } from '../queue-order';
import { LLM_BACKENDS, LLM_PROMPT_BANK, presetPromptIds, resolvePromptSelection } from '../prompt-bank';

interface Item extends BackendTagged {
  id: string;
}

/** The queue shape that produced the defect: three backends on one host, appended one after another. */
function starvedQueue(): Item[] {
  const items: Item[] = [];
  for (const [backend, n] of [
    ['ollama', 57],
    ['mtplx', 36],
    ['dspark', 36],
  ] as const) {
    for (let i = 0; i < n; i++) items.push({ backend, id: `${backend}#${i}` });
  }
  return items;
}

describe('round-robin across backends', () => {
  it('every backend is measured in the first rank, not after the ones before it drain', () => {
    // The regression itself: the last-appended backend used to be item 94 of 129, so partial
    // progress said 100% of one backend and 0% of another.
    const queued = interleaveByBackend(starvedQueue());
    expect(queued.slice(0, 3).map((i) => i.backend)).toEqual(['ollama', 'mtplx', 'dspark']);
    for (const backend of ['ollama', 'mtplx', 'dspark']) {
      const at = queued.findIndex((i) => i.backend === backend);
      expect(at, `${backend} first appears at ${at}`).toBeLessThan(3);
    }
  });

  it('partial progress stays proportional at every prefix', () => {
    // The property the interleave exists for: read the queue at any point and each backend's share
    // of what has run is within one item of every other backend's.
    const queued = interleaveByBackend(starvedQueue());
    for (const cut of [3, 12, 60, 100]) {
      const seen = new Map<string, number>();
      for (const item of queued.slice(0, cut)) seen.set(item.backend, (seen.get(item.backend) ?? 0) + 1);
      const counts = [...seen.values()];
      expect(Math.max(...counts) - Math.min(...counts), `unbalanced after ${cut} items`).toBeLessThanOrEqual(1);
    }
  });

  it('loses no work and reorders nothing within a backend', () => {
    const before = starvedQueue();
    const after = interleaveByBackend(before);
    expect(after).toHaveLength(before.length);
    expect(new Set(after.map((i) => i.id))).toEqual(new Set(before.map((i) => i.id)));
    for (const backend of ['ollama', 'mtplx', 'dspark']) {
      const lane = (list: Item[]) => list.filter((i) => i.backend === backend).map((i) => i.id);
      expect(lane(after), `${backend} lost its own order`).toEqual(lane(before));
    }
  });

  it('leaves a single-backend queue byte-identical', () => {
    // A host running one endpoint must be completely unaffected by the fairness rule.
    const one: Item[] = [
      { backend: 'ollama', id: 'a' },
      { backend: 'ollama', id: 'b' },
      { backend: 'ollama', id: 'c' },
    ];
    expect(interleaveByBackend(one)).toEqual(one);
    expect(interleaveByBackend([])).toEqual([]);
  });

  it('drains uneven lanes to the end rather than stopping at the shortest', () => {
    const queued = interleaveByBackend([
      { backend: 'a', id: 'a1' },
      { backend: 'a', id: 'a2' },
      { backend: 'a', id: 'a3' },
      { backend: 'b', id: 'b1' },
    ]);
    expect(queued.map((i) => i.id)).toEqual(['a1', 'b1', 'a2', 'a3']);
  });

  it('orders lanes by first appearance, so the result is deterministic', () => {
    const queued = interleaveByBackend([
      { backend: 'z', id: 'z1' },
      { backend: 'a', id: 'a1' },
      { backend: 'z', id: 'z2' },
      { backend: 'a', id: 'a2' },
    ]);
    expect(queued.map((i) => i.id)).toEqual(['z1', 'a1', 'z2', 'a2']);
  });
});

describe('accounting for an endpoint with nothing to ask it', () => {
  it('an endpoint with applicable prompts gets no skip — it speaks for itself', () => {
    const applicable = LLM_PROMPT_BANK.filter((p) => (p.backends as readonly string[]).includes('omlx')).length;
    expect(applicable).toBeGreaterThan(0);
    expect(
      endpointCoverageSkip({ endpoint: 'host.local:8100', backend: 'omlx', via: 'configuration', selected: LLM_PROMPT_BANK.length, applicable }),
    ).toBeNull();
  });

  it('a discovered endpoint no selected prompt targets produces a REASON, never silence', () => {
    // Not hypothetical: the shipped `embeddings` preset names no dspark entry, because dspark serves
    // no embedding route. Discovered (so no absent-skip row) and unmatched (so no work row) is how a
    // backend disappears from a results file entirely.
    const selected = resolvePromptSelection(presetPromptIds('embeddings')).prompts;
    const note = endpointCoverageSkip({ endpoint: 'host.local:8100', backend: 'omlx', via: 'discovery', selected: selected.length, applicable: 0 });
    expect(note).toBeTruthy();
    expect(note).toContain('omlx');
    expect(note).toContain('host.local:8100');
    expect(note).toContain('discovery');
    expect(note).toContain(`0 of the ${selected.length} selected`);
    expect(note).toMatch(/not a failure/);
  });

  it('every backend the tool can drive is reachable by the default whole-bank selection', () => {
    // A backend with no bank entry at all could never produce a row, which the skip row above would
    // then have to explain on every single run.
    for (const backend of LLM_BACKENDS) {
      const applicable = LLM_PROMPT_BANK.filter((p) => p.backends.includes(backend)).length;
      expect(applicable, `${backend} has no bank entry at all`).toBeGreaterThan(0);
    }
  });
});
