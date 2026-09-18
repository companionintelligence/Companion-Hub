import { describe, expect, it } from 'vitest';
import type { CuratedModel } from '@ci-hub/common/types';
import { isCuratedModelInstalled, isOllamaTagForCatalogModel, isOllamaTagForModel, resolveInstalledCatalogIds } from '../model-availability.util';

const model = {
  id: 'hermes4-70b',
  backendModelId: 'hermes4:70b',
} as CuratedModel;

describe('model-availability.util', () => {
  it('matches exact and tagged Ollama names', () => {
    expect(isOllamaTagForModel('hermes4:70b', 'hermes4:70b')).toBe(true);
    expect(isOllamaTagForModel('hermes4:70b-q4_K_M', 'hermes4:70b')).toBe(true);
    expect(isOllamaTagForModel('phi4-mini', 'hermes4:70b')).toBe(false);
  });

  it('detects installed catalog models from Ollama tags', () => {
    expect(isCuratedModelInstalled(model, ['hermes4:70b'])).toBe(true);
    expect(isCuratedModelInstalled(model, ['other:8b'])).toBe(false);
    expect(isCuratedModelInstalled(model, [], true)).toBe(true);
  });

  it('resolves installed catalog ids from a catalog slice', () => {
    const catalog = [model, { id: 'phi-4-mini', backendModelId: 'phi4-mini' } as CuratedModel];
    expect(resolveInstalledCatalogIds(catalog, ['hermes4:70b-q4_K_M'])).toEqual(['hermes4-70b']);
  });

  describe('longest match against the catalog', () => {
    const plain = { id: 'qwen3-8-27b', backendModelId: 'qwen3.8:27b' } as CuratedModel;
    const mtp = { id: 'qwen3-8-27b-mtp', backendModelId: 'qwen3.8:27b-mtp-q4_K_M' } as CuratedModel;
    const nomic = { id: 'nomic-embed-text', backendModelId: 'nomic-embed-text' } as CuratedModel;
    const nomicV2 = { id: 'nomic-embed-text-v2-moe', backendModelId: 'nomic-embed-text-v2-moe' } as CuratedModel;
    const catalog = [plain, mtp, nomic, nomicV2];
    const ids = catalog.map((m) => m.backendModelId);

    it('does not credit a tag to a shorter row when a longer row spells that tag out', () => {
      expect(isOllamaTagForCatalogModel('qwen3.8:27b-mtp-q4_K_M', 'qwen3.8:27b', ids)).toBe(false);
      expect(isOllamaTagForCatalogModel('qwen3.8:27b-mtp-q4_K_M', 'qwen3.8:27b-mtp-q4_K_M', ids)).toBe(true);
      expect(isOllamaTagForCatalogModel('nomic-embed-text-v2-moe', 'nomic-embed-text', ids)).toBe(false);
    });

    it('keeps quant-suffix tolerance for tags no catalog row spells out', () => {
      expect(isOllamaTagForCatalogModel('qwen3.8:27b-q4_K_M', 'qwen3.8:27b', ids)).toBe(true);
      expect(isOllamaTagForCatalogModel('qwen3.8:27b', 'qwen3.8:27b', ids)).toBe(true);
      expect(isOllamaTagForCatalogModel('nomic-embed-text:latest', 'nomic-embed-text', ids)).toBe(true);
    });

    it('reports only the MTP row installed when only the MTP tag is pulled', () => {
      expect(resolveInstalledCatalogIds(catalog, ['qwen3.8:27b-mtp-q4_K_M', 'nomic-embed-text:latest'])).toEqual([
        'qwen3-8-27b-mtp',
        'nomic-embed-text',
      ]);
      expect(isCuratedModelInstalled(plain, ['qwen3.8:27b-mtp-q4_K_M'], false, ids)).toBe(false);
      expect(isCuratedModelInstalled(mtp, ['qwen3.8:27b-mtp-q4_K_M'], false, ids)).toBe(true);
    });

    it('takes the exclusion set from the full catalog when the slice omits the longer row', () => {
      // A tier filter can drop the MTP row from the slice while the plain row survives;
      // the plain row must still not claim the MTP tag.
      expect(resolveInstalledCatalogIds([plain], ['qwen3.8:27b-mtp-q4_K_M'], undefined, ids)).toEqual([]);
      // Without the full set the slice can only see itself, and the legacy prefix rule applies.
      expect(resolveInstalledCatalogIds([plain], ['qwen3.8:27b-mtp-q4_K_M'])).toEqual(['qwen3-8-27b']);
    });

    it('still honours a tracked pull regardless of tag shape', () => {
      expect(isCuratedModelInstalled(plain, [], true, ids)).toBe(true);
    });
  });
});
