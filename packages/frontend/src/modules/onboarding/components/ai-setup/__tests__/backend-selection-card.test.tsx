import { fireEvent, render, screen } from '@testing-library/react';
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

  describe('speculative runners', () => {
    const checkbox = (type: string) => screen.getByTestId(`backend-option-${type}`).querySelector('input') as HTMLInputElement;

    it('render as checkboxes inside the group while regular engines stay radios', () => {
      render(<BackendSelectionCard recommended="ollama" available={[...available]} selected="ollama" onSelect={vi.fn()} />);

      expect(screen.getByTestId('backend-option-speculative-group')).toContainElement(screen.getByTestId('backend-option-lucebox'));
      expect(checkbox('lucebox').type).toBe('checkbox');
      expect(checkbox('dspark').type).toBe('checkbox');
      expect(checkbox('ollama').type).toBe('radio');
    });

    // A speculative runner replaces the chat engine, so unticking it has to land on a regular one.
    it('return to the previously selected engine when unticked', () => {
      const withVllm = [...available, { type: 'vllm', running: false, healthy: false } as const];
      const onSelect = vi.fn();
      const { rerender } = render(<BackendSelectionCard recommended="ollama" available={withVllm} selected="vllm" onSelect={onSelect} />);

      fireEvent.click(checkbox('lucebox'));
      expect(onSelect).toHaveBeenLastCalledWith('lucebox');

      rerender(<BackendSelectionCard recommended="ollama" available={withVllm} selected="lucebox" onSelect={onSelect} />);
      expect(checkbox('lucebox').checked).toBe(true);
      fireEvent.click(checkbox('lucebox'));
      expect(onSelect).toHaveBeenLastCalledWith('vllm');
    });

    it('fall back to the recommended engine when a speculative runner was selected from the start', () => {
      const onSelect = vi.fn();
      render(<BackendSelectionCard recommended="ollama" available={[...available]} selected="lucebox" onSelect={onSelect} />);

      fireEvent.click(checkbox('lucebox'));
      expect(onSelect).toHaveBeenLastCalledWith('ollama');
    });
  });
});
