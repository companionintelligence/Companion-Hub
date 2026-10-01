import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

// Minimal link stub so asChild tests don't need a full router context
const FakeLink = ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
  <a href={href} className={className}>
    {children}
  </a>
);

describe('Button component', () => {
  it('should render without crashing', () => {
    render(<Button>Click me</Button>);
  });

  it('should render children correctly', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('should apply className prop correctly', () => {
    // arrange
    render(<Button className="test-class">Click me</Button>);
    const button = screen.getByRole('button');

    // assert
    expect(button).toHaveClass('test-class');
  });

  it('should disable button when disabled prop is true', () => {
    // arrange
    render(<Button disabled>Click me</Button>);
    const button = screen.getByRole('button');

    // assert
    expect(button).toBeDisabled();
  });

  it('should set type correctly', () => {
    // arrange
    render(<Button type="submit">Click me</Button>);
    const button = screen.getByRole('button');

    // assert
    expect(button).toHaveAttribute('type', 'submit');
  });

  it('should call onClick callback when clicked', () => {
    // arrange
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click me</Button>);
    const button = screen.getByRole('button');

    // act
    fireEvent.click(button);

    // assert
    expect(onClick).toHaveBeenCalled();
  });

  describe('asChild', () => {
    it('renders a single child element without crashing (regression: React.Children.only)', () => {
      // @radix-ui/react-slot v1.2.4 throws "React.Children.only expected to receive a single
      // React element child" when Slot receives more than one child. This test ensures the
      // Button asChild path forwards exactly one child to Slot.
      expect(() =>
        render(
          <Button asChild>
            <FakeLink href="/login">Back to Login</FakeLink>
          </Button>,
        ),
      ).not.toThrow();
    });

    it('renders the child element as the root node', () => {
      render(
        <Button asChild>
          <FakeLink href="/login">Back to Login</FakeLink>
        </Button>,
      );
      const link = screen.getByRole('link', { name: 'Back to Login' });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '/login');
    });

    it('applies Button class variants to the child element', () => {
      render(
        <Button asChild className="custom-class">
          <FakeLink href="/login">Back to Login</FakeLink>
        </Button>,
      );
      const link = screen.getByRole('link', { name: 'Back to Login' });
      expect(link).toHaveClass('custom-class');
    });
  });
  it('announces itself as busy while loading, and only then', () => {
    const { rerender } = render(<Button loading>Save</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button')).toBeDisabled();

    rerender(<Button>Save</Button>);
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy');
  });
});
