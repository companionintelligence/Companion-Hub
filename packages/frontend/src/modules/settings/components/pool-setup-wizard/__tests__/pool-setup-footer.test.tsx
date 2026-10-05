import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PoolSetupFooter } from '../pool-setup-footer';

const labels = (footer: HTMLElement) => [...footer.children].map((child) => child.textContent);

describe('PoolSetupFooter', () => {
  it('renders its children in the order given, so the primary action, written last, is the last thing in the bar', () => {
    render(
      <PoolSetupFooter>
        <button type="button">Back</button>
        <button type="button">Rescan</button>
        <button type="button">Send 2 requests</button>
      </PoolSetupFooter>,
    );

    const footer = screen.getByTestId('pool-setup-footer');

    expect(labels(footer)).toEqual(['Back', 'Rescan', 'Send 2 requests']);
    expect(footer.lastElementChild).toHaveTextContent('Send 2 requests');
  });

  it('keeps the reading order in the document for assistive technology and the Tab key, while a phone shows the primary action first', () => {
    render(
      <PoolSetupFooter>
        <button type="button">Back</button>
        <button type="button">Done</button>
      </PoolSetupFooter>,
    );

    const classes = screen.getByTestId('pool-setup-footer').className;

    // The move is a CSS `order` on the last button, so the DOM, and with it the Tab order, stays as written.
    expect(classes).toContain('[&>button:last-child]:max-sm:order-first');
    expect(labels(screen.getByTestId('pool-setup-footer'))).toEqual(['Back', 'Done']);
  });

  it('sticks to the bottom of the dialog, so the button that moves you forward never scrolls away', () => {
    render(
      <PoolSetupFooter>
        <button type="button">Done</button>
      </PoolSetupFooter>,
    );

    expect(screen.getByTestId('pool-setup-footer')).toHaveClass('sticky', 'bottom-0');
  });

  it('merges an extra class without dropping its own', () => {
    render(
      <PoolSetupFooter className="extra">
        <button type="button">Done</button>
      </PoolSetupFooter>,
    );

    expect(screen.getByTestId('pool-setup-footer')).toHaveClass('extra', 'sticky');
  });

  it('renders a bar with a single action, and a bar with none, without error', () => {
    const { rerender } = render(
      <PoolSetupFooter>
        <button type="button">Done</button>
      </PoolSetupFooter>,
    );
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();

    rerender(<PoolSetupFooter>{null}</PoolSetupFooter>);

    expect(screen.getByTestId('pool-setup-footer')).toBeEmptyDOMElement();
  });
});
