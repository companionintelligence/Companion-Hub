import { fireEvent, render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { PasswordInput } from './PasswordInput';

describe('PasswordInput', () => {
  const getField = () => screen.getByLabelText('Password');

  it('should mask the value until the toggle is pressed', () => {
    // arrange
    render(<PasswordInput name="password" label="Password" />);

    // assert
    expect(getField()).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(getField()).toHaveAttribute('type', 'text');

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(getField()).toHaveAttribute('type', 'password');
  });

  it('should keep what the user typed when visibility flips', () => {
    // arrange
    render(<PasswordInput name="password" label="Password" />);

    // act
    fireEvent.change(getField(), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    // assert
    expect(getField()).toHaveValue('hunter2');
  });

  it('should not let a caller override the masking', () => {
    // `type` is Omit-ed from the props, so this needs a cast to compile — which is the
    // point. The type stops the honest caller; this pins the runtime guarantee for the
    // ones it cannot see, so a stray `type` can never unmask the field.
    // arrange
    const sneaky = { type: 'text' } as Record<string, unknown>;
    render(<PasswordInput name="password" label="Password" {...sneaky} />);

    // assert
    expect(getField()).toHaveAttribute('type', 'password');
  });

  it('should disable the toggle alongside the field', () => {
    // arrange
    render(<PasswordInput name="password" label="Password" disabled />);

    // assert
    expect(getField()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
  });

  it('should not submit the surrounding form when toggled', () => {
    // arrange
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput name="password" label="Password" />
      </form>,
    );

    // act
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    // assert
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('should match the toggle height to the field size', () => {
    // The suffix button butts against the input, so a mismatched height reads as a
    // broken control rather than a smaller one.
    // arrange
    const { rerender } = render(<PasswordInput name="password" label="Password" />);

    // assert
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveClass('h-11');

    rerender(<PasswordInput name="password" label="Password" size="sm" />);
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveClass('h-8');
  });
});
