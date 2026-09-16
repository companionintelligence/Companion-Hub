import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BackendSelectionCard } from '../backend-selection-card';

const available = [
  { type: 'ollama', running: true, healthy: true },
  { type: 'dspark', running: false, healthy: false },
  { type: 'mtplx', running: false, healthy: false },
  { type: 'lucebox', running: false, healthy: false },
] as const;

describe('BackendSelectionCard', () => {
  it('omits hidden backends that are not selected', () => {
    render(
      <BackendSelectionCard recommended="ollama" available={[...available]} selected="ollama" onSelect={vi.fn()} hiddenTypes={['dspark', 'mtplx']} />,
    );

    expect(screen.queryByTestId('backend-option-dspark')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backend-option-mtplx')).not.toBeInTheDocument();
    expect(screen.getByTestId('backend-option-lucebox')).toBeInTheDocument();
  });

  // A host whose saved backend is now hidden must still see that choice, or it could never be changed away from.
  it('keeps a hidden backend visible while it is the current selection', () => {
    render(
      <BackendSelectionCard recommended="ollama" available={[...available]} selected="mtplx" onSelect={vi.fn()} hiddenTypes={['dspark', 'mtplx']} />,
    );

    expect(screen.queryByTestId('backend-option-dspark')).not.toBeInTheDocument();
    expect(screen.getByTestId('backend-option-mtplx').querySelector('input') as HTMLInputElement).toBeChecked();
    expect(screen.getByTestId('backend-option-lucebox')).toBeInTheDocument();
  });
});
