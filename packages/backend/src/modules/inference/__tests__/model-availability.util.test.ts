import { describe, expect, it } from 'vitest';
import type { CuratedModel } from '@ci-hub/common/types';
import { isCuratedModelInstalled, isOllamaTagForModel, resolveInstalledCatalogIds } from '../model-availability.util';

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
});
