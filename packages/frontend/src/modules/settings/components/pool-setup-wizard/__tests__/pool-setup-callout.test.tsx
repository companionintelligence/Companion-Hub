import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PoolSetupCallout } from '../pool-setup-callout';

describe('PoolSetupCallout', () => {
  it('renders the title, body, and a Set up Hub Pool button that calls onOpen', async () => {
    const onOpen = vi.fn();
    render(<PoolSetupCallout onOpen={onOpen} />);

    expect(screen.getByRole('region', { name: 'Set up your Hub Pool' })).toBeInTheDocument();
    expect(screen.getByText('A guided setup finds your other Hubs and sends the requests. Each Hub approves its own.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Set up Hub Pool' }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('disables the button in demo mode', async () => {
    const onOpen = vi.fn();
    render(<PoolSetupCallout onOpen={onOpen} disabled />);

    const button = screen.getByRole('button', { name: 'Set up Hub Pool' });
    expect(button).toBeDisabled();
    await userEvent.click(button);

    expect(onOpen).not.toHaveBeenCalled();
  });
});
