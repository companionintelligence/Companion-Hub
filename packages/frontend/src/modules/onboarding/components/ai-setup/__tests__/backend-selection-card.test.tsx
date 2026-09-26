import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BackendSelectionCard } from '../backend-selection-card';

const available = [
  { type: 'ollama' as const, running: true, healthy: true },
  { type: 'omlx' as const, running: false, healthy: false },
  { type: 'vllm' as const, running: false, healthy: false },
  { type: 'lemonade' as const, running: false, healthy: false },
];

describe('BackendSelectionCard', () => {
  it('omits engines that do not run on this machine', () => {
    render(
      <BackendSelectionCard
        recommended="ollama"
        available={available}
        selected="ollama"
        onSelect={vi.fn()}
        hiddenTypes={['omlx', 'vllm', 'lemonade']}
      />,
    );

    expect(screen.getByTestId('backend-option-ollama')).toBeInTheDocument();
    expect(screen.queryByTestId('backend-option-omlx')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backend-option-vllm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backend-option-lemonade')).not.toBeInTheDocument();
  });

  it('keeps a hidden engine visible while it is the current selection', () => {
    render(<BackendSelectionCard recommended="ollama" available={available} selected="omlx" onSelect={vi.fn()} hiddenTypes={['omlx', 'vllm']} />);

    expect(screen.getByTestId('backend-option-omlx').querySelector('input') as HTMLInputElement).toBeChecked();
    expect(screen.queryByTestId('backend-option-vllm')).not.toBeInTheDocument();
  });
});
