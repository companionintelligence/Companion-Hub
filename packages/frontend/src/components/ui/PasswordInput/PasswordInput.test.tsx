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

  it('should keep browser text assistance off in both states', () => {
    // Revealing makes this a text input, and browsers exempt only type=password from
    // spellcheck — enhanced spellcheck would ship the revealed value to a third party.
    // arrange
    render(<PasswordInput name="password" label="Password" />);

    // assert
    expect(getField()).toHaveAttribute('spellcheck', 'false');
    expect(getField()).toHaveAttribute('autocapitalize', 'off');
    expect(getField()).toHaveAttribute('autocorrect', 'off');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(getField()).toHaveAttribute('type', 'text');
    expect(getField()).toHaveAttribute('spellcheck', 'false');
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
    // broken control rather than a smaller one. `size-8` is also what Button's icon
    // variant sets, so the small case additionally asserts `size-11` is gone —
    // otherwise it would pass even if the size were ignored entirely.
    // arrange
    const { rerender } = render(<PasswordInput name="password" label="Password" />);

    // assert
    const defaultToggle = screen.getByRole('button', { name: 'Show password' });
    expect(defaultToggle).toHaveClass('size-11');
    // Button's icon variant sets size-8; tailwind-merge must drop it rather than leave
    // both and let CSS source order pick the height.
    expect(defaultToggle).not.toHaveClass('size-8');

    rerender(<PasswordInput name="password" label="Password" size="sm" />);
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveClass('size-8');
    expect(toggle).not.toHaveClass('size-11');
  });

  it('should hide the native Edge reveal control without dropping the caller className', () => {
    // Edge draws its own ::-ms-reveal inside password fields, which would sit next to
    // this toggle as a second, uncontrolled unmask affordance. InputGroup puts
    // className on an outer wrapper, so the rule has to reach the input as a
    // descendant — and a caller's own classes must survive the merge.
    // arrange
    const { container } = render(<PasswordInput name="password" label="Password" className="mb-3" />);

    // assert
    const wrapper = container.querySelector('[class*="input::-ms-reveal"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveClass('mb-3');
    expect(wrapper?.querySelector('input')).toBe(getField());
  });
});
