import { fireEvent, render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { Slider } from './Slider';

// Polyfill ResizeObserver for Radix UI
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('Slider', () => {
  it('renders the label and value readout', () => {
    render(<Slider label="CPU limit" valueLabel="1.5 cores" name="cpuLimit" min={0} max={4} step={0.1} value={[1.5]} />);

    expect(screen.getByText('CPU limit')).toBeInTheDocument();
    expect(screen.getByText('1.5 cores')).toBeInTheDocument();
  });

  it('renders the className', () => {
    const className = 'test-class';
    const { container } = render(<Slider className={className} name="cpuLimit" min={0} max={4} value={[1]} />);

    expect(container.firstChild).toHaveClass(className);
  });

  it('renders the caption', () => {
    render(<Slider caption="Default: 2.0 cores" name="cpuLimit" min={0} max={4} value={[1]} />);

    expect(screen.getByText('Default: 2.0 cores')).toBeInTheDocument();
  });

  it('exposes the slider role with the field name as the accessible name', () => {
    render(<Slider label="CPU limit" name="cpuLimit" min={0} max={4} value={[1]} />);

    expect(screen.getByRole('slider', { name: 'cpuLimit' })).toBeInTheDocument();
  });

  it('triggers onValueChange when the thumb is moved via keyboard', () => {
    const onValueChange = vi.fn();
    render(<Slider label="CPU limit" name="cpuLimit" min={0} max={4} step={0.5} value={[1]} onValueChange={onValueChange} />);

    const thumb = screen.getByRole('slider', { name: 'cpuLimit' });
    thumb.focus();
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });

    expect(onValueChange).toHaveBeenCalledWith([1.5]);
  });

  it('does not respond to interaction when disabled', () => {
    render(<Slider label="CPU limit" name="cpuLimit" min={0} max={4} value={[1]} disabled />);

    expect(screen.getByRole('slider', { name: 'cpuLimit' })).toHaveAttribute('data-disabled');
  });
});
