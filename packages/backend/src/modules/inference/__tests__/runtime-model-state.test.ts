import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `GET /api/inference/models/runtime` must not claim a model is `loaded`.
 *
 * Every backend hardcodes `InferenceModel.loaded = true` in `listModels()` — it means
 * "in this engine's inventory", i.e. on disk. `ModelState`, the lifecycle vocabulary
 * used elsewhere in this module, spends `loaded` on the RESIDENT state and `pulled` on
 * the on-disk one, so reporting inventory as `loaded` asserted residency nothing had
 * measured.
 *
 * Measured on a live fleet node: the route reported 11/11 `loaded` while the engine's
 * own `/api/ps` reported zero models resident.
 *
 * Asserted against the source text rather than by invoking the controller: the claim
 * being defended is which WORD this route puts on the wire, and a test that imported
 * the mapping would restate it instead of checking it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

describe('runtime model state vocabulary', () => {
  it('reports inventory as "available", never as "loaded"', () => {
    const controller = readFileSync(resolve(HERE, '../inference.controller.ts'), 'utf-8');
    const mapping = /state:\s*model\.loaded\s*\?\s*'([a-z]+)'\s*:\s*'([a-z]+)'/.exec(controller);

    expect(mapping).not.toBeNull();
    expect(mapping?.[1]).toBe('available');
    expect(mapping?.[2]).toBe('unknown');
  });

  it('every backend still hardcodes `loaded`, which is why the word may not be forwarded', () => {
    // If a backend ever derives `loaded` from a real residency probe, this test should
    // fail and the mapping above can be revisited — that is the point of pinning it.
    const backends = ['ollama.backend.ts', 'mtplx.backend.ts', 'dspark.backend.ts'];
    const hardcoded = backends.filter((file) => readFileSync(resolve(HERE, '../backends', file), 'utf-8').includes('loaded: true'));

    expect(hardcoded).toEqual(backends);
  });
});
