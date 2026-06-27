import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppStoreSearchInput } from './app-store-search-input';

describe('AppStoreSearchInput', () => {
  it('calls onChange when typing', () => {
    const onChange = vi.fn();
    render(<AppStoreSearchInput value="" onChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText('Search apps...'), { target: { value: 'n8n' } });

    expect(onChange).toHaveBeenCalledWith('n8n');
  });

  it('shows a clear button when there is text and clears on click', () => {
    const onChange = vi.fn();
    render(<AppStoreSearchInput value="n8n" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('hides the clear button when the input is empty', () => {
    render(<AppStoreSearchInput value="" onChange={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });
});
