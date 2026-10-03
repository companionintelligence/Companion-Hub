import type { CuratedModel } from '@ci-hub/common/types';
import { render, screen } from '@testing-library/react';
import { OtherModels } from './model-selection-card';

function model(id: string, parameterScale: number): CuratedModel {
  return {
    id,
    backend: 'ollama',
    backendModelId: id,
    modality: 'llm',
    purpose: 'general',
    displayName: id,
    description: '',
    parameterScale,
    requirements: {
      minVramMb: 1,
      recommendedVramMb: 1,
      minRamMb: 1,
      diskMb: 1,
      gpuVendors: ['cpu'],
      npuRequired: false,
      minTier: 'low',
    },
    runtime: {
      contextWindow: 1,
      maxTokens: 1,
      reasoning: false,
      input: ['text'],
      pinnedByDefault: false,
      memoryFootprintMb: 1,
    },
    tiers: { high: 'available', medium: 'available', low: 'available', cpuOnly: 'available' },
  };
}

it('names each size group with the cutoff the filter already uses', () => {
  render(
    <OtherModels
      recommendedModels={[]}
      availableModels={[model('at-14', 14), model('just-over-14', 14.1), model('at-70', 70), model('over-70', 70.1)]}
      installedCatalogIds={[]}
      selectedModelIds={[]}
      onToggleModel={() => undefined}
    />,
  );

  const small = screen.getByTestId('other-group-small');
  const medium = screen.getByTestId('other-group-medium');
  const large = screen.getByTestId('other-group-large');

  expect(small.textContent).toContain('14B and under');
  expect(medium.textContent).toContain('over 14B up to 70B');
  expect(large.textContent).toContain('over 70B');
  expect(small.querySelector('span:last-child')?.textContent).toBe('1');
  expect(medium.querySelector('span:last-child')?.textContent).toBe('2');
  expect(large.querySelector('span:last-child')?.textContent).toBe('1');
});
