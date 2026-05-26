import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CompanionServerBanner } from './companion-server-banner.tsx';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('CompanionServerBanner', () => {
  it('renders the banner with the default message when no system data is provided', () => {
    render(<CompanionServerBanner onDismiss={vi.fn()} />);

    expect(screen.getByTestId('core-server-banner')).toBeInTheDocument();
    expect(screen.getByText(/COMPANION_SERVER_BANNER_DEFAULT_TITLE/)).toBeInTheDocument();
    expect(screen.getByText(/COMPANION_SERVER_BANNER_DEFAULT_MESSAGE/)).toBeInTheDocument();
  });

  it('renders the low-RAM message when memory is below the threshold', () => {
    render(<CompanionServerBanner onDismiss={vi.fn()} system={{ memoryTotal: 4, diskSize: 500, cpuCores: 8 }} />);

    expect(screen.getByText(/COMPANION_SERVER_BANNER_LOW_RAM_TITLE/)).toBeInTheDocument();
    expect(screen.getByText(/COMPANION_SERVER_BANNER_LOW_RAM_MESSAGE/)).toBeInTheDocument();
  });

  it('renders the low-disk message when disk size is below the threshold', () => {
    render(<CompanionServerBanner onDismiss={vi.fn()} system={{ memoryTotal: 16, diskSize: 50, cpuCores: 8 }} />);

    expect(screen.getByText(/COMPANION_SERVER_BANNER_LOW_DISK_TITLE/)).toBeInTheDocument();
    expect(screen.getByText(/COMPANION_SERVER_BANNER_LOW_DISK_MESSAGE/)).toBeInTheDocument();
  });

  it('renders the low-CPU message when CPU cores are at or below the threshold', () => {
    render(<CompanionServerBanner onDismiss={vi.fn()} system={{ memoryTotal: 16, diskSize: 500, cpuCores: 2 }} />);

    expect(screen.getByText(/COMPANION_SERVER_BANNER_LOW_CPU_TITLE/)).toBeInTheDocument();
    expect(screen.getByText(/COMPANION_SERVER_BANNER_LOW_CPU_MESSAGE/)).toBeInTheDocument();
  });

  it('renders the default message when all system specs are adequate', () => {
    render(<CompanionServerBanner onDismiss={vi.fn()} system={{ memoryTotal: 16, diskSize: 500, cpuCores: 8 }} />);

    expect(screen.getByText(/COMPANION_SERVER_BANNER_DEFAULT_TITLE/)).toBeInTheDocument();
    expect(screen.getByText(/COMPANION_SERVER_BANNER_DEFAULT_MESSAGE/)).toBeInTheDocument();
  });

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(<CompanionServerBanner onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders a "Learn more" link pointing to the Core Server page', () => {
    render(<CompanionServerBanner onDismiss={vi.fn()} />);

    const link = screen.getByRole('link', { name: /COMPANION_SERVER_BANNER_LEARN_MORE/i });
    expect(link).toHaveAttribute('href', 'https://www.ci.computer/core-server');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('prioritises RAM message over disk when both are low', () => {
    render(<CompanionServerBanner onDismiss={vi.fn()} system={{ memoryTotal: 4, diskSize: 50, cpuCores: 8 }} />);

    expect(screen.getByText(/COMPANION_SERVER_BANNER_LOW_RAM_TITLE/)).toBeInTheDocument();
  });
});
