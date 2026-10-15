import { fireEvent, render, screen } from '@/tests/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeBaseSelector } from './theme-base-selector';

// Polyfill ResizeObserver for Radix UI
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const field = () => screen.getByRole('combobox');

afterEach(() => {
  delete document.body.dataset.bsThemeBase;
});

describe('ThemeBaseSelector', () => {
  it('lists every base theme', () => {
    render(<ThemeBaseSelector value="gray" onChange={vi.fn()} />);
    fireEvent.click(field());

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Slate', 'Gray', 'Zinc', 'Neutral', 'Stone']);
  });

  it('applies the base theme picked to the page and reports it', () => {
    const onChange = vi.fn();
    render(<ThemeBaseSelector value="gray" onChange={onChange} />);
    fireEvent.click(field());
    fireEvent.click(screen.getByRole('option', { name: 'Zinc' }));

    expect(document.body.dataset.bsThemeBase).toBe('zinc');
    expect(onChange).toHaveBeenCalledWith('zinc');
  });
});
