import { fireEvent, render, screen, waitFor } from '@/tests/test-utils';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Input } from './Input';

describe('Input', () => {
  it('should render without errors', () => {
    // arrange
    const { container } = render(<Input name="test-input" />);

    // assert
    expect(container).toBeTruthy();
  });

  it('should render the label if provided', () => {
    // arrange
    render(<Input name="test-input" label="Test Label" />);
    const input = screen.getByLabelText('Test Label');

    // assert
    expect(input).toBeInTheDocument();
  });

  it('should render the placeholder if provided', () => {
    // arrange
    render(<Input name="test-input" placeholder="Test Placeholder" />);

    // assert
    const input = screen.getByPlaceholderText('Test Placeholder');
    expect(input).toBeInTheDocument();
  });

  it('should render the error message if provided', () => {
    // arrange
    render(<Input name="test-input" error="Test Error" />);

    // assert
    const error = screen.getByText('Test Error');
    expect(error).toBeInTheDocument();
  });

  it('should call onChange when the input value is changed', async () => {
    // arrange
    const onChange = vi.fn();
    render(<Input name="test-input" label="Test Label" onChange={onChange} />);
    const input = screen.getByLabelText('Test Label');

    // act
    fireEvent.change(input, { target: { value: 'changed' } });

    // assert
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it('should call onBlur when the input is blurred', async () => {
    // arrange
    const onBlur = vi.fn();
    render(<Input name="test-input" label="Test Label" onBlur={onBlur} />);
    const input = screen.getByLabelText('Test Label');

    // act
    fireEvent.blur(input);

    // assert
    await waitFor(() => expect(onBlur).toHaveBeenCalledTimes(1));
  });

  it('should set the input type if provided', () => {
    // arrange
    render(<Input name="test-input" label="Test Label" type="password" />);
    const input = screen.getByLabelText('Test Label') as HTMLInputElement;

    // assert
    expect(input.type).toBe('password');
  });

  it('should set the input value if provided', () => {
    // arrange
    render(<Input name="test-input" label="Test Label" value="Test Value" onChange={vi.fn()} />);
    const input = screen.getByLabelText('Test Label') as HTMLInputElement;

    // assert
    expect(input.value).toBe('Test Value');
  });

  it('should apply the isInvalid prop to the input element', () => {
    // arrange
    render(<Input name="test-input" label="Test Label" isInvalid />);
    const input = screen.getByLabelText('Test Label');

    // assert
    expect(input).toHaveClass('border-destructive');
  });

  it('should apply the disabled prop to the input element', () => {
    // arrange
    render(<Input name="test-input" label="Test Label" disabled />);

    // assert
    const input = screen.getByLabelText('Test Label');
    expect(input).toBeDisabled();
  });

  it('should set the input name attribute if provided', () => {
    // arrange
    render(<Input name="test-input" label="Test Label" />);
    const input = screen.getByLabelText('Test Label');

    // assert
    expect(input).toHaveAttribute('name', 'test-input');
  });

  it('should set the input id attribute if provided', () => {
    // arrange
    render(<Input name="test-input" label="Test Label" />);
    const input = screen.getByLabelText('Test Label');

    // assert
    expect(input).toHaveAttribute('id', 'test-input');
  });

  it('should set the input ref if provided', () => {
    // arrange
    const ref = React.createRef<HTMLInputElement>();
    render(<Input name="test-input" label="Test Label" ref={ref} />);
    const input = screen.getByLabelText('Test Label');

    // assert
    expect(input).toEqual(ref.current);
  });

  it('should set the input type attribute to "text" if not provided or if an invalid value is provided', () => {
    // arrange
    render(<Input name="test-input" label="Test Label" />);
    const input = screen.getByLabelText('Test Label') as HTMLInputElement;

    // assert
    expect(input.type).toBe('text');
  });

  it('should set the input placeholder attribute if provided', () => {
    // arrange
    render(<Input name="test-input" label="Test Label" placeholder="Test Placeholder" />);
    const input = screen.getByLabelText('Test Label');

    // assert
    expect(input).toHaveAttribute('placeholder', 'Test Placeholder');
  });

  it('should keep children overlaid on the field when an error is shown', () => {
    render(
      <Input name="test-input" error="Test Error">
        <button type="button" className="absolute inset-y-0 right-1">
          Copy
        </button>
      </Input>,
    );

    const field = screen.getByRole('textbox');
    const overlay = screen.getByRole('button', { name: 'Copy' });
    const error = screen.getByText('Test Error');

    expect(overlay.parentElement).toContainElement(field);
    expect(overlay.parentElement).not.toContainElement(error);
    expect(overlay.parentElement).toHaveClass('relative');
  });
  describe('assistive technology', () => {
    it('marks the field invalid and ties the error message to it', () => {
      render(<Input name="email" label="Email" error="Enter a valid address" />);

      const input = screen.getByRole('textbox', { name: 'Email' });
      const message = screen.getByRole('alert');

      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(message).toHaveTextContent('Enter a valid address');
      expect(input.getAttribute('aria-describedby')).toContain(message.id);
    });

    it('ties the help text to the field', () => {
      render(<Input name="email" label="Email" helpText="We never share it" />);

      const input = screen.getByRole('textbox', { name: 'Email' });

      expect(input).toHaveAccessibleDescription('We never share it');
      expect(input).not.toHaveAttribute('aria-invalid');
    });

    it('keeps a describedby the caller supplied alongside the generated ones', () => {
      render(<Input name="email" label="Email" error="Enter a valid address" aria-describedby="email-note" />);

      expect(screen.getByRole('textbox', { name: 'Email' }).getAttribute('aria-describedby')).toMatch(/^email-note /);
    });

    it('describes the field by its help text and its error together', () => {
      render(<Input name="email" label="Email" helpText="We never share it" error="Enter a valid address" />);

      expect(screen.getByRole('textbox', { name: 'Email' })).toHaveAccessibleDescription('We never share it Enter a valid address');
    });
  });
});
