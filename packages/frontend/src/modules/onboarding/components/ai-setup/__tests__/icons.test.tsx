import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModelIcon } from '../icons';

/**
 * Every creator currently present in the backend catalog (packages/backend/src/modules/inference/catalog/curated-models.ts)
 * must resolve to a specific mark, not silently fall back to the generic cube — otherwise every model
 * from that lab renders as an indistinguishable placeholder in the picker.
 */
const CATALOG_CREATORS = [
  'Google',
  'Alibaba',
  'NVIDIA',
  'DeepSeek',
  'OpenAI',
  'Mistral',
  'Meta',
  'Z AI',
  'MiniMax',
  'Poolside',
  'Deep Reinforce',
  'Liquid AI',
  'Cohere',
  'Thinking Machines',
  'Google (community)',
];

function iconHtml(creator: string | undefined) {
  const { container } = render(
    <ModelIcon model={{ id: 'zzz-unmatched-id', displayName: 'Zzz Unmatched Name', modality: 'llm', metadata: creator ? { creator } : undefined }} />,
  );
  return container.innerHTML;
}

describe('ModelIcon', () => {
  const cubeFallbackHtml = iconHtml(undefined);

  it('renders the generic cube for a model with no creator and a non-matching name', () => {
    expect(cubeFallbackHtml.length).toBeGreaterThan(0);
  });

  it.each(CATALOG_CREATORS)('resolves a specific mark for creator "%s" (not the generic cube fallback)', (creator) => {
    const html = iconHtml(creator);
    expect(html.length).toBeGreaterThan(0);
    expect(html).not.toBe(cubeFallbackHtml);
  });

  it('is case-insensitive on creator matching', () => {
    expect(iconHtml('z ai')).toBe(iconHtml('Z AI'));
    expect(iconHtml('POOLSIDE')).toBe(iconHtml('Poolside'));
  });

  it('falls back to a name-based match for community variants sharing a base model family', () => {
    // "Google (community)" fine-tunes still key off the exact creator string, but a Gemma-family
    // model with no creator metadata at all should still resolve via the MODEL_BRAND name regex.
    const { container } = render(
      <ModelIcon model={{ id: 'gemma4-26b-think', displayName: 'Gemma 4 26B Think', modality: 'llm', metadata: undefined }} />,
    );
    expect(container.innerHTML).not.toBe(cubeFallbackHtml);
  });

  it('falls back to the embedding glyph (not the cube) for an unmatched embedding model', () => {
    const { container } = render(
      <ModelIcon model={{ id: 'zzz-embed', displayName: 'Zzz Embed', modality: 'embedding', metadata: { creator: 'Nomic' } }} />,
    );
    expect(container.innerHTML).not.toBe(cubeFallbackHtml);
  });
});
