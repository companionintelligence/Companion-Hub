import { fireEvent, render, screen, userEvent } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { PasswordInput } from './PasswordInput';

const { tooltipAnchors } = vi.hoisted(() => ({ tooltipAnchors: [] as string[] }));

vi.mock('react-tooltip', () => ({
  Tooltip: ({ anchorSelect }: { anchorSelect?: string }) => {
    tooltipAnchors.push(anchorSelect ?? '');
    return null;
  },
}));

describe('PasswordInput', () => {
  const getField = () => screen.getByLabelText('Password');
  // The toggle is named after the field it controls, so match on the state word alone.
  const getToggle = () => screen.getByRole('button', { name: /^Show password/ });
  const getHideToggle = () => screen.getByRole('button', { name: /^Hide password/ });

  it('should mask the value until the toggle is pressed', () => {
    // arrange
    render(<PasswordInput name="password" label="Password" />);

    // assert
    expect(getField()).toHaveAttribute('type', 'password');

    fireEvent.click(getToggle());
    expect(getField()).toHaveAttribute('type', 'text');

    fireEvent.click(getHideToggle());
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

    fireEvent.click(getToggle());

    expect(getField()).toHaveAttribute('type', 'text');
    expect(getField()).toHaveAttribute('spellcheck', 'false');
    expect(getField()).toHaveAttribute('autocapitalize', 'off');
    expect(getField()).toHaveAttribute('autocorrect', 'off');
  });

  it('should keep what the user typed when visibility flips', () => {
    // arrange
    render(<PasswordInput name="password" label="Password" />);

    // act
    fireEvent.change(getField(), { target: { value: 'hunter2' } });
    fireEvent.click(getToggle());

    // assert
    expect(getField()).toHaveValue('hunter2');
  });

  it('should keep focus in the input when the toggle is clicked', async () => {
    // arrange
    render(<PasswordInput name="password" label="Password" />);
    getField().focus();

    // act
    await userEvent.click(getToggle());

    // assert
    expect(getField()).toHaveFocus();
  });

  it('should not let a caller override the masking', () => {
    // `type` is Omit-ed from the props, so this needs a cast to compile — which is the
    // point: this pins the runtime guarantee for the callers the type cannot see.
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
    expect(getToggle()).toBeDisabled();
  });

  it('should point the toggle at its own field', () => {
    // arrange
    render(<PasswordInput name="password" label="Password" />);

    // assert — several of these can share a form, so the label alone does not identify one
    expect(getToggle()).toHaveAttribute('aria-controls', 'password');
  });

  it('should name the toggle after the field it controls', () => {
    // The change-password form stacks three of these. `aria-controls` gives the
    // relationship but not the name, so without this every toggle on that form announces
    // identically and a screen-reader user cannot tell which field they are about to
    // unmask. Matched by exact name, so a bare "Show password" fails these.
    // arrange
    const { rerender } = render(<PasswordInput name="password" label="Current password" />);

    // assert
    expect(screen.getByRole('button', { name: 'Show password: Current password' })).toBeInTheDocument();

    // Those three forms label by placeholder only, which is the case that actually ships.
    rerender(<PasswordInput name="password" placeholder="New password" />);
    expect(screen.getByRole('button', { name: 'Show password: New password' })).toBeInTheDocument();

    // With neither, the bare label — not a dangling separator.
    rerender(<PasswordInput name="password" />);
    expect(screen.getByRole('button', { name: 'Show password' })).toBeInTheDocument();
  });

  it('should anchor the tooltip to the toggle button', () => {
    // The tooltip finds its anchor by class name, so dropping that class from the button
    // detaches it silently — nothing renders differently until someone hovers.
    // arrange
    tooltipAnchors.length = 0;
    render(<PasswordInput name="password" label="Password" />);

    // assert
    const anchorSelect = tooltipAnchors.at(-1);
    expect(anchorSelect).toBeTruthy();
    expect(document.querySelector(String(anchorSelect))).toBe(getToggle());
  });

  it('should leave the error border to the field alone', () => {
    // arrange
    render(<PasswordInput name="password" label="Password" error="Wrong password" />);

    // assert — the toggle is overlaid inside the field and draws no edge of its own, so a
    // second red border around it would read as a stray box sitting on top of the input
    expect(getField()).toHaveClass('border-destructive');
    expect(getToggle()).not.toHaveClass('border-destructive');
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
    fireEvent.click(getToggle());

    // assert
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('should keep the toggle inset inside the field at either size', () => {
    // The toggle is overlaid on the field rather than butted against it, so it tracks the
    // size a step below the field height instead of matching it. `size-8` is what Button's
    // icon variant sets, hence the negative assertions.
    // arrange
    const { rerender } = render(<PasswordInput name="password" label="Password" />);

    // assert
    const defaultToggle = getToggle();
    expect(getField()).toHaveClass('h-9');
    expect(defaultToggle).toHaveClass('size-7');
    expect(defaultToggle).not.toHaveClass('size-8');

    rerender(<PasswordInput name="password" label="Password" size="sm" />);
    const toggle = getToggle();
    expect(getField()).toHaveClass('h-8');
    expect(toggle).toHaveClass('size-6');
    expect(toggle).not.toHaveClass('size-8');
  });

  it('should overlay the toggle so the field keeps the full row width', () => {
    // Appending the toggle beside the input left the field stopping a toggle short of the
    // submit button below it, and gave the button a fill of its own against the field.
    // arrange
    const { container } = render(<PasswordInput name="password" label="Password" />);

    // assert — out of the row's flex flow, so the input is the only thing sizing the row
    const suffix = getToggle().parentElement;
    expect(suffix).toHaveClass('absolute');
    expect(suffix?.parentElement).toHaveClass('relative');
    expect(container.firstElementChild).toHaveClass('[&_input]:rounded-r-md', '[&_input]:pr-9');
  });

  it('should hide the native Edge reveal control without dropping the caller className', () => {
    // Edge draws its own ::-ms-reveal inside password fields, which would sit next to
    // this toggle as a second, uncontrolled unmask affordance. InputGroup puts className
    // on an outer wrapper, so the rule has to reach the input as a descendant.
    // arrange
    const { container } = render(<PasswordInput name="password" label="Password" className="mb-3" />);

    // assert
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveClass('[&_input::-ms-reveal]:hidden', 'mb-3');
    expect(wrapper?.querySelector('input')).toBe(getField());
  });
});
