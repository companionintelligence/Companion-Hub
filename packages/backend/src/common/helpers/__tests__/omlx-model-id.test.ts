import { describe, expect, it } from 'vitest';
import { omlxModelKey, omlxModelsMatch, servedOmlxId } from '../omlx-model-id';

// The ids below are what oMLX 0.7.3.dev1 listed on GET /v1/models for mlx-community/Llama-3.2-1B-Instruct-4bit, laid out
// each way (the catalog's own row for it is `mlx-community/Llama-3.2-1B-Instruct-4bit`).
const CATALOG = 'mlx-community/Llama-3.2-1B-Instruct-4bit';
const FROM_MODEL_DIR = 'Llama-3.2-1B-Instruct-4bit';
const FROM_HF_CACHE = 'mlx-community--Llama-3.2-1B-Instruct-4bit';
// Another publisher's cache entry of the same name. oMLX lists ids sorted, so this one comes before `mlx-community--`.
const OTHER_PUBLISHER = 'lmstudio-community--Llama-3.2-1B-Instruct-4bit';

describe('omlxModelKey', () => {
  it('gives the catalog spelling, the directory name and the cache id one key', () => {
    const keys = [CATALOG, FROM_MODEL_DIR, FROM_HF_CACHE].map(omlxModelKey);

    expect(new Set(keys)).toEqual(new Set(['llama-3.2-1b-instruct-4bit']));
  });

  it('folds case, which oMLX does when it resolves a request', () => {
    expect(omlxModelKey('MLX-Community--LLAMA-3.2-1B-INSTRUCT-4BIT')).toBe(omlxModelKey(FROM_MODEL_DIR));
  });

  it('drops a provider prefix, which oMLX strips from a request', () => {
    expect(omlxModelKey(`omlx/${FROM_MODEL_DIR}`)).toBe(omlxModelKey(FROM_MODEL_DIR));
  });

  it('keeps models that differ only in what follows the name apart', () => {
    // No prefix tolerance, unlike an Ollama tag: an 8-bit build is not the 4-bit one.
    expect(omlxModelKey('Qwen3-8B-4bit')).not.toBe(omlxModelKey('Qwen3-8B-8bit'));
    expect(omlxModelKey('Qwen3-8B')).not.toBe(omlxModelKey('Qwen3-8B-4bit'));
  });

  it('leaves a name with a version dot, a colon tag or a leading dash alone', () => {
    expect(omlxModelKey('Qwen3.8-27B-oQ4e-fp16-mtp')).toBe('qwen3.8-27b-oq4e-fp16-mtp');
    expect(omlxModelKey('qwen3:8b')).toBe('qwen3:8b');
    expect(omlxModelKey('--odd')).toBe('--odd');
  });

  it('does not compare organizations, so two publishers of one name share a key', () => {
    expect(omlxModelKey(OTHER_PUBLISHER)).toBe(omlxModelKey(FROM_HF_CACHE));
  });
});

describe('omlxModelsMatch', () => {
  it('matches the catalog spelling, the directory name and the cache id of one model, whichever way round', () => {
    for (const [a, b] of [
      [CATALOG, FROM_MODEL_DIR],
      [CATALOG, FROM_HF_CACHE],
      [FROM_MODEL_DIR, FROM_HF_CACHE],
    ] as const) {
      expect(omlxModelsMatch(a, b)).toBe(true);
      expect(omlxModelsMatch(b, a)).toBe(true);
    }
  });

  it('ignores case in the name and the organization', () => {
    expect(omlxModelsMatch('MLX-Community--LLAMA-3.2-1B-INSTRUCT-4BIT', CATALOG)).toBe(true);
  });

  it("does not match another organization's build of the same name", () => {
    expect(omlxModelsMatch(OTHER_PUBLISHER, CATALOG)).toBe(false);
    expect(omlxModelsMatch('lmstudio-community/Llama-3.2-1B-Instruct-4bit', CATALOG)).toBe(false);
    // A directory that happens to be named with `--` carries that as an organization.
    expect(omlxModelsMatch('Foo--Llama-3.2-1B-Instruct-4bit', CATALOG)).toBe(false);
  });

  it('does not match a different name, or a name with something more on it', () => {
    expect(omlxModelsMatch('Llama-3.2-3B-Instruct-4bit', CATALOG)).toBe(false);
    expect(omlxModelsMatch(`${FROM_MODEL_DIR}-DWQ`, CATALOG)).toBe(false);
  });

  it('matches nothing with no name', () => {
    expect(omlxModelsMatch('', '')).toBe(false);
    expect(omlxModelsMatch('mlx-community/', 'mlx-community/')).toBe(false);
  });
});

describe('servedOmlxId', () => {
  it.each([
    ['a model directory (flat or organized)', [FROM_MODEL_DIR], FROM_MODEL_DIR],
    ['the Hugging Face cache', [FROM_HF_CACHE], FROM_HF_CACHE],
    ['a different case, as oMLX resolves a request', ['llama-3.2-1b-instruct-4bit'], 'llama-3.2-1b-instruct-4bit'],
    ['an alias the operator set to the catalog id', [CATALOG], CATALOG],
  ])('finds the model listed from %s, under the spelling it is listed by', (_layout, served, expected) => {
    expect(servedOmlxId(CATALOG, served)).toBe(expected);
  });

  it('finds the model among others', () => {
    const served = ['Qwen3.8-27B-oQ4e-fp16-mtp', 'LiquidAI--LFM2.5-1.2B-Instruct-MLX-bf16', FROM_MODEL_DIR];

    expect(servedOmlxId(CATALOG, served)).toBe(FROM_MODEL_DIR);
  });

  it('prefers the catalog spelling, then the bare name, then the cache spelling, when a listing holds the model twice', () => {
    expect(servedOmlxId(CATALOG, [FROM_HF_CACHE, FROM_MODEL_DIR, CATALOG])).toBe(CATALOG);
    expect(servedOmlxId(CATALOG, [FROM_HF_CACHE, FROM_MODEL_DIR])).toBe(FROM_MODEL_DIR);
    // Exact before case-folded, whatever the listing order.
    expect(servedOmlxId(CATALOG, ['LLAMA-3.2-1B-INSTRUCT-4BIT', FROM_HF_CACHE])).toBe(FROM_HF_CACHE);
    expect(servedOmlxId(CATALOG, ['MLX-COMMUNITY--LLAMA-3.2-1B-INSTRUCT-4BIT', 'llama-3.2-1b-instruct-4bit'])).toBe(
      'MLX-COMMUNITY--LLAMA-3.2-1B-INSTRUCT-4BIT',
    );
  });

  it("finds this organization's cache entry, not another publisher's listed before it", () => {
    expect(servedOmlxId(CATALOG, [OTHER_PUBLISHER, FROM_HF_CACHE])).toBe(FROM_HF_CACHE);
  });

  it("does not find another publisher's build of the same name, nor a directory named for another organization", () => {
    expect(servedOmlxId(CATALOG, [OTHER_PUBLISHER])).toBeNull();
    expect(servedOmlxId(CATALOG, ['someone-else/Llama-3.2-1B-Instruct-4bit', 'Foo--Llama-3.2-1B-Instruct-4bit'])).toBeNull();
  });

  it('finds nothing in a listing of other models, of a longer name, or of none', () => {
    expect(servedOmlxId(CATALOG, ['Llama-3.2-3B-Instruct-4bit', 'mlx-community--Qwen3-8B-4bit'])).toBeNull();
    expect(servedOmlxId(CATALOG, [`${FROM_MODEL_DIR}-DWQ`])).toBeNull();
    expect(servedOmlxId(CATALOG, [])).toBeNull();
  });

  it('does not find a model that oMLX lists only under an alias', () => {
    // `/v1/models` shows the alias in place of the model's own name, so nothing in it can be matched.
    expect(servedOmlxId(CATALOG, ['my-llama-alias'])).toBeNull();
  });

  it('finds nothing for an id with no name', () => {
    expect(servedOmlxId('', [''])).toBeNull();
    expect(servedOmlxId('mlx-community/', ['', 'mlx-community/'])).toBeNull();
  });

  it('accepts any iterable of ids', () => {
    expect(servedOmlxId(CATALOG, new Set([FROM_MODEL_DIR]))).toBe(FROM_MODEL_DIR);
  });
});
