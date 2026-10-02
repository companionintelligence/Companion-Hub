import { fireEvent, render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './Select';

const KARACHI = '(GMT+5:00) Islamabad, Karachi, Tashkent (PKT)';

function LabeledSelect({ label, value }: { label: string; value: string }) {
  return (
    <Select value={value} onValueChange={vi.fn()}>
      <SelectTrigger label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={value}>{value}</SelectItem>
      </SelectContent>
    </Select>
  );
}

describe('SelectTrigger', () => {
  it('names the closed control from its caption and keeps a long value on one line', () => {
    render(<LabeledSelect label="Timezone" value={KARACHI} />);

    const timezone = screen.getByRole('combobox', { name: 'Timezone' });
    const caption = screen.getByText('Timezone');
    expect(caption.tagName).toBe('LABEL');
    expect(caption).toHaveAttribute('for', timezone.id);
    expect(timezone).toHaveAttribute('aria-labelledby', caption.id);

    const value = timezone.querySelector(':scope > span');
    expect(value).toHaveClass('truncate', 'text-left');
    expect(value).toHaveTextContent(KARACHI);

    fireEvent.click(timezone);
    const option = screen.getByRole('option', { name: KARACHI });
    expect(option).not.toHaveClass('truncate');
    expect(option).toHaveTextContent(KARACHI);
  });

  it('names a second labeled select from its own caption', () => {
    render(<LabeledSelect label="Log level" value="Info" />);

    expect(screen.getByRole('combobox', { name: 'Log level' })).toHaveTextContent('Info');
  });
});
