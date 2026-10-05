import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SetupStep } from '../pool-setup-model';
import { PoolSetupStepper } from '../pool-setup-stepper';

const ORDER: SetupStep[] = ['ready', 'find', 'connect', 'approve'];
const LABELS = ['Check', 'Find', 'Connect', 'Approve'];

const items = () => within(screen.getByTestId('pool-setup-stepper')).getAllByRole('listitem');

describe('PoolSetupStepper', () => {
  describe('the list for assistive technology', () => {
    it('is an ordered list named Setup progress with the four steps in order', () => {
      render(<PoolSetupStepper step="find" />);

      const list = screen.getByRole('list', { name: 'Setup progress' });

      expect(list.tagName).toBe('OL');
      expect(list).toHaveAttribute('data-testid', 'pool-setup-stepper');
      // Each item reads its number (or a tick) and its label; the screen-reader words are checked below.
      expect(items().map((item) => item.textContent?.replace(/Completed|Current step/, '').replace(/^\d/, ''))).toEqual(LABELS);
    });

    it.each(ORDER.map((step, index) => [step, index] as const))('marks %s as the current step and every earlier one as complete', (step, index) => {
      render(<PoolSetupStepper step={step} />);

      expect(items().map((item) => item.getAttribute('data-state'))).toEqual(
        ORDER.map((_, position) => (position < index ? 'complete' : position === index ? 'current' : 'upcoming')),
      );
      expect(items().map((item) => item.getAttribute('aria-current'))).toEqual(ORDER.map((_, position) => (position === index ? 'step' : null)));
    });

    it('says Completed and Current step in words, for those who cannot see the tick or the filled number', () => {
      render(<PoolSetupStepper step="connect" />);

      expect(within(items()[0] as HTMLElement).getByText('Completed')).toBeInTheDocument();
      expect(within(items()[1] as HTMLElement).getByText('Completed')).toBeInTheDocument();
      expect(within(items()[2] as HTMLElement).getByText('Current step')).toBeInTheDocument();
      expect(within(items()[3] as HTMLElement).queryByText(/Completed|Current step/)).not.toBeInTheDocument();
    });

    it('is not hidden from assistive technology, and is not interactive', () => {
      render(<PoolSetupStepper step="find" />);

      const list = screen.getByTestId('pool-setup-stepper');

      expect(list).not.toHaveAttribute('aria-hidden');
      expect(within(list).queryByRole('button')).not.toBeInTheDocument();
      expect(within(list).queryByRole('link')).not.toBeInTheDocument();
    });
  });

  describe('the compact look for a phone', () => {
    it.each(ORDER.map((step, index) => [step, index + 1, LABELS[index]] as const))(
      'reads Step N of 4 and the label of the current step: %s',
      (step, number, label) => {
        render(<PoolSetupStepper step={step} />);

        expect(screen.getByTestId('pool-setup-stepper-compact')).toHaveTextContent(`Step ${number} of 4 · ${label}`);
      },
    );

    it('is hidden from assistive technology, so the same progress is not read twice', () => {
      render(<PoolSetupStepper step="find" />);

      expect(screen.getByTestId('pool-setup-stepper-compact')).toHaveAttribute('aria-hidden', 'true');
    });

    it.each([
      ['ready', '25%'],
      ['find', '50%'],
      ['connect', '75%'],
      ['approve', '100%'],
    ] as const)('fills its bar to %s of the way at %s, counting the current step as done', (step, width) => {
      render(<PoolSetupStepper step={step} />);

      const bar = screen.getByTestId('pool-setup-stepper-compact').querySelector('[style]') as HTMLElement;

      expect(bar.style.width).toBe(width);
    });
  });

  it('draws both looks from the one component, the list always in the page and the compact block beside it', () => {
    render(<PoolSetupStepper step="approve" />);

    expect(screen.getByTestId('pool-setup-stepper')).toBeInTheDocument();
    expect(screen.getByTestId('pool-setup-stepper-compact')).toBeInTheDocument();
  });
});
