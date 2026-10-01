import { fireEvent, render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { TotpForm } from './totp-form';

describe('TotpForm', () => {
  it('puts the cursor in the first digit so the code can be typed straight away', () => {
    render(<TotpForm onSubmit={vi.fn()} />);

    expect(screen.getAllByRole('textbox')[0]).toHaveFocus();
  });

  it('takes the cursor back to the first digit after a submit, which empties the field', () => {
    const onSubmit = vi.fn();
    render(<TotpForm onSubmit={onSubmit} />);
    const digits = screen.getAllByRole('textbox');

    '123456'.split('').forEach((digit, index) => {
      fireEvent.change(digits[index] as HTMLElement, { target: { value: digit } });
    });
    screen.getByRole('button').focus();
    fireEvent.submit(screen.getByRole('button').closest('form') as HTMLFormElement);

    expect(onSubmit).toHaveBeenCalledWith('123456');
    expect(screen.getAllByRole('textbox')[0]).toHaveFocus();
  });
});
