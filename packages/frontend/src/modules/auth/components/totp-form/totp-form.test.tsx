import { fireEvent, render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { TotpForm } from './totp-form';

describe('TotpForm', () => {
  it('puts the cursor in the first digit so the code can be typed straight away', () => {
    render(<TotpForm onSubmit={vi.fn()} />);

    expect(screen.getAllByRole('textbox')[0]).toHaveFocus();
  });

  it('keeps the code after a submit so a wrong code can be corrected', () => {
    const onSubmit = vi.fn();
    render(<TotpForm onSubmit={onSubmit} />);
    const digits = screen.getAllByRole('textbox');

    '123456'.split('').forEach((digit, index) => {
      fireEvent.change(digits[index] as HTMLElement, { target: { value: digit } });
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Confirm' }).closest('form') as HTMLFormElement);

    expect(onSubmit).toHaveBeenCalledWith('123456');
    expect(digits.map((digit) => (digit as HTMLInputElement).value).join('')).toBe('123456');
  });

  it('goes back without submitting the code', () => {
    const onSubmit = vi.fn();
    const onBack = vi.fn();
    render(<TotpForm onSubmit={onSubmit} onBack={onBack} />);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(onBack).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
