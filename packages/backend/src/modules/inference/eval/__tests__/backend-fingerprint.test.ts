/**
 * Who is answering the shared :8000.
 *
 * The verdict is built from three cheap GETs and every wrong answer here is silent — the walk
 * completes either way, it just attributes rows to a backend that is not installed. The expensive
 * boundary is not "which of the three" (they are driven identically); it is "one of the three" vs
 * "not an LLM server at all", so that is where most of these tests sit.
 */

import { describe, expect, it } from 'vitest';
import { type SharedPortProbe, fingerprintSharedPort, openAiModelIds, openAiModelOwner } from '../backend-fingerprint';

const NOTHING: SharedPortProbe = { models: null, version: null, health: null };
const modelsBody = (owner?: string) => ({ data: [{ id: 'a-model', ...(owner ? { owned_by: owner } : {}) }] });

describe('the server names itself', () => {
  it('owned_by beats every route-shape heuristic', () => {
    // The heuristics below cannot tell lucebox from mtplx when both answer only /v1/models, so an
    // engine that names itself must not be fingerprinted at all.
    const verdict = fingerprintSharedPort({ ...NOTHING, models: { status: 200, body: modelsBody('omlx') } });
    expect(verdict).toEqual({ kind: 'match', backend: 'omlx', via: 'GET /v1/models (owned_by=omlx)' });
  });

  it('does not invent a backend for a name nothing in the table claims', () => {
    expect(fingerprintSharedPort({ ...NOTHING, models: { status: 200, body: modelsBody('dflash') } })).toMatchObject({
      kind: 'none',
    });
  });

  it('lets owned_by outrank a /version that would otherwise say vllm', () => {
    const verdict = fingerprintSharedPort({
      models: { status: 200, body: modelsBody('omlx') },
      version: { status: 200, body: { version: '0.1.0' } },
      health: { status: 200, body: { status: 'ok' } },
    });
    expect(verdict).toMatchObject({ kind: 'match', backend: 'omlx' });
  });

  it('leaves an unknown owner unidentified', () => {
    const verdict = fingerprintSharedPort({ ...NOTHING, models: { status: 200, body: modelsBody('some-other-vendor') } });
    expect(verdict.kind).toBe('none');
  });
});

describe('the three probe shapes', () => {
  it('a /version carrying a version field is vLLM', () => {
    expect(fingerprintSharedPort({ ...NOTHING, version: { status: 200, body: { version: '0.11.2' } } })).toEqual({
      kind: 'match',
      backend: 'vllm',
      via: 'GET /version',
    });
  });

  it('a 200 on /version with no version field is not vLLM', () => {
    // Status alone is not evidence anywhere in this module.
    const verdict = fingerprintSharedPort({ ...NOTHING, version: { status: 200, body: { build: 'x' } } });
    expect(verdict).toEqual({ kind: 'none', reason: null });
  });

  it('/health plus a model list that does not name itself stays unidentified', () => {
    const verdict = fingerprintSharedPort({
      models: { status: 200, body: { data: [] } },
      version: null,
      health: { status: 200, body: { status: 'ok' } },
    });
    expect(verdict.kind).toBe('none');
  });

  it('/v1/models alone, with no owner, stays unidentified', () => {
    const verdict = fingerprintSharedPort({ ...NOTHING, models: { status: 200, body: modelsBody() } });
    expect(verdict.kind).toBe('none');
  });

  it('a guarded /v1/models is not treated as a named engine', () => {
    for (const status of [401, 403]) {
      expect(fingerprintSharedPort({ ...NOTHING, models: { status } }).kind).toBe('none');
      expect(fingerprintSharedPort({ ...NOTHING, models: { status }, health: { status: 200 } }).kind).toBe('none');
    }
  });

  it('nothing answering is a clean negative with no reason to report', () => {
    expect(fingerprintSharedPort(NOTHING)).toEqual({ kind: 'none', reason: null });
    expect(fingerprintSharedPort({ models: { status: 404 }, version: { status: 404 }, health: { status: 404 } })).toEqual({
      kind: 'none',
      reason: null,
    });
  });
});

describe('a healthy port that is not one of ours', () => {
  it('a 200 on /health with a 404 on /v1/models is NOT a backend', () => {
    // The regression: under a /health-alone rule an unrelated service owning :8000 became "lucebox
    // with 0 models" on every probe, which then swallowed the honest "lucebox is not reachable here"
    // row. The reason is written into the skip, not swallowed.
    const verdict = fingerprintSharedPort({ models: { status: 404 }, version: null, health: { status: 200, body: { status: 'ok' } } });
    expect(verdict.kind).toBe('none');
    expect(verdict.kind === 'none' && verdict.reason).toMatch(/HTTP 404/);
    expect(verdict.kind === 'none' && verdict.reason).toMatch(/NOT an LLM backend/);
  });

  it('a 200 on /v1/models carrying a non-OpenAI body is NOT a backend either', () => {
    // Same regression arriving through a 200: a single-page-app catch-all route answers 200 with its
    // own HTML index. Shape, not status, is what proves the route.
    const verdict = fingerprintSharedPort({
      models: { status: 200, body: '<!doctype html><title>some app</title>' },
      version: null,
      health: { status: 200, body: { status: 'ok' } },
    });
    expect(verdict.kind).toBe('none');
    expect(verdict.kind === 'none' && verdict.reason).toMatch(/non-OpenAI body/);
  });

  it('a healthy port with no models response at all reports that it never answered', () => {
    const verdict = fingerprintSharedPort({ ...NOTHING, health: { status: 200 } });
    expect(verdict.kind === 'none' && verdict.reason).toMatch(/no response/);
  });

  it('a bare 200 on /v1/models with no health route is not a backend', () => {
    // Without the shape check, any web app on a swept port becomes "mtplx with 0 models".
    expect(fingerprintSharedPort({ ...NOTHING, models: { status: 200, body: { ok: true } } })).toEqual({ kind: 'none', reason: null });
  });
});

describe('body readers', () => {
  it('openAiModelIds pulls ids and drops blanks, never throwing on a foreign body', () => {
    expect(openAiModelIds({ data: [{ id: 'a' }, { id: '' }, {}, { id: 'b' }] })).toEqual(['a', 'b']);
    expect(openAiModelIds(null)).toEqual([]);
    expect(openAiModelIds('<html>')).toEqual([]);
    expect(openAiModelIds({ data: 'nope' })).toEqual([]);
  });

  it('openAiModelOwner lowercases and trims, and is empty when absent', () => {
    expect(openAiModelOwner({ data: [{ owned_by: '  MTPLX ' }] })).toBe('mtplx');
    expect(openAiModelOwner({ data: [{ owned_by: 42 }] })).toBe('');
    expect(openAiModelOwner({ data: [] })).toBe('');
    expect(openAiModelOwner(undefined)).toBe('');
  });
});
