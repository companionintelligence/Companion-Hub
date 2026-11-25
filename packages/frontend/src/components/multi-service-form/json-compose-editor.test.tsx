import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// CodeMirror needs layout jsdom does not have. The editor validates its first value on mount without it.
vi.mock('@uiw/react-codemirror', () => ({ default: () => <div data-testid="codemirror" /> }));

import { JsonComposeEditor } from './json-compose-editor';
import { useMultiServiceStore } from '@/stores/multiServiceStore';

const renderReport = (service: Record<string, unknown>) => {
  act(() => {
    useMultiServiceStore.getState().setServices([{ _id: 'web-id', isMain: true, internalPort: 80, ...service } as never]);
    useMultiServiceStore.setState({ overrides: undefined } as never);
  });

  render(<JsonComposeEditor onChange={vi.fn()} />);

  return screen.getByTestId('json-compose-editor-error').querySelector('pre')?.textContent ?? '';
};

describe('JsonComposeEditor error box', () => {
  it("drops the validator's emoji with their skin tone, so nothing is left after the caret", () => {
    const report = renderReport({ name: 'web', image: 5 });

    expect(report).toContain('^  type must be string');
    // The validator points with 👈🏽. Stripping the hand alone left its skin tone (U+1F3FD), drawn as a square.
    expect(report).not.toMatch(/\p{Extended_Pictographic}|\p{Emoji_Modifier}/u);
  });

  it("drops the validator's emoji with its variation selector on a missing property", () => {
    const report = renderReport({ name: 'web' });

    // The validator flags a missing property with ☹️, which carries U+FE0F.
    expect(report).toContain('^  image is missing here!');
    expect(report).not.toMatch(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F/u);
  });

  it("drops the validator's emoji on an unexpected property", () => {
    const report = renderReport({ name: 'web', image: 'nginx:alpine', extra: 1 });

    expect(report).toContain('^^^^^^^  extra is not expected to be here!');
    expect(report).not.toMatch(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F/u);
  });

  it("keeps the emoji and symbols in the user's own JSON", () => {
    const report = renderReport({ name: 'web 👍🏽 acme® app', image: 5 });

    expect(report).toContain('"name": "web 👍🏽 acme® app"');
    expect(report).toContain('^  type must be string');
  });
});
