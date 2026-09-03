import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { CoreServerBanner } from './core-server-banner';

describe('CoreServerBanner', () => {
  it('renders disk-full messaging', () => {
    render(<CoreServerBanner onDismiss={vi.fn()} />);

    expect(screen.getByTestId('core-server-banner')).toBeInTheDocument();
    expect(screen.getByText(/CORE_SERVER_BANNER_LOW_DISK_TITLE/)).toBeInTheDocument();
    expect(screen.getByText(/CORE_SERVER_BANNER_LOW_DISK_MESSAGE/)).toBeInTheDocument();
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(<CoreServerBanner onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: /CORE_SERVER_BANNER_DISMISS/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('links to the Core Server store listing', () => {
    render(<CoreServerBanner onDismiss={vi.fn()} />);

    const link = screen.getByRole('link', { name: /CORE_SERVER_BANNER_LEARN_MORE/i });
    expect(link).toHaveAttribute('href', 'https://www.ci.computer/store/p/core');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
