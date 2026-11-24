import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// CodeMirror needs layout jsdom does not have. The editor validates its first value on mount without it.
vi.mock('@uiw/react-codemirror', () => ({ default: () => <div data-testid="codemirror" /> }));

import { JsonComposeEditor } from './json-compose-editor';
import { useMultiServiceStore } from '@/stores/multiServiceStore';

describe('JsonComposeEditor error box', () => {
  it("drops the validator's emoji with their skin tone, so nothing is left after the caret", () => {
    act(() => {
      useMultiServiceStore.getState().setServices([{ _id: 'web-id', name: 'web', image: 5 as unknown as string, isMain: true, internalPort: 80 }]);
    });

    render(<JsonComposeEditor onChange={vi.fn()} />);

    const report = screen.getByTestId('json-compose-editor-error').querySelector('pre')?.textContent ?? '';
    expect(report).toContain('^  type must be string');
    // The validator points with 👈🏽. Stripping the hand alone left its skin tone (U+1F3FD), drawn as a square.
    expect(report).not.toMatch(/\p{Extended_Pictographic}|\p{Emoji_Modifier}/u);
  });
});
