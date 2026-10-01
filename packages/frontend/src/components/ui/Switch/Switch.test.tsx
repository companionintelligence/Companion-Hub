import { fireEvent, render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './Switch';

describe('Switch', () => {
  it('renders the label', () => {
    // arrange
    const label = 'Test Label';
    render(<Switch label={label} />);

    // assert
    expect(screen.getByRole('switch', { name: label })).toBeInTheDocument();
  });

  it('renders the className', () => {
    // arrange
    const className = 'test-class';
    render(<Switch className={className} />);
    const switchContainer = screen.getByRole('switch').parentElement;

    // assert
    expect(switchContainer).toHaveClass(className);
  });

  it('renders the checked state', () => {
    // arrange
    render(<Switch checked onChange={vi.fn()} />);
    const checkbox = screen.getByRole('switch');

    // assert
    expect(checkbox).toBeChecked();
  });

  it('triggers onChange event when clicked', () => {
    // arrange
    const onChange = vi.fn();
    render(<Switch onCheckedChange={onChange} />);
    const checkbox = screen.getByRole('switch');

    // act
    fireEvent.click(checkbox);

    // assert
    expect(onChange).toHaveBeenCalled();
  });

  it('triggers onBlur event when blurred', () => {
    // arrange
    const onBlur = vi.fn();
    render(<Switch onBlur={onBlur} />);
    const checkbox = screen.getByRole('switch');

    // act
    fireEvent.blur(checkbox);

    // assert
    expect(onBlur).toHaveBeenCalled();
  });

  it('should change the checked state when clicked', () => {
    // arrange
    render(<Switch onChange={vi.fn()} />);
    const checkbox = screen.getByRole('switch');

    // act
    fireEvent.click(checkbox);

    // assert
    expect(checkbox).toBeChecked();
  });
  describe('accessible name', () => {
    it('is the visible label, not the name attribute', () => {
      render(<Switch name="follow-logs" label="Follow logs" />);

      expect(screen.getByRole('switch', { name: 'Follow logs' })).toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: 'follow-logs' })).toBeNull();
    });

    it('falls back to the name for a switch with no label', () => {
      render(<Switch name="follow-logs" />);

      expect(screen.getByRole('switch', { name: 'follow-logs' })).toBeInTheDocument();
    });

    it('is the label when the switch has no name either', () => {
      render(<Switch label="Anonymous switch" />);

      expect(screen.getByRole('switch', { name: 'Anonymous switch' })).toBeInTheDocument();
    });

    it('gives two switches without names two distinct labels', () => {
      render(
        <>
          <Switch label="First" />
          <Switch label="Second" />
        </>,
      );

      expect(screen.getByRole('switch', { name: 'First' })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Second' })).toBeInTheDocument();
    });
  });
});
