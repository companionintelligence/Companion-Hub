import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CoreServerBanner } from './core-server-banner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('CoreServerBanner', () => {
  it('renders the banner with the default message when no system data is provided', () => {
    render(<CoreServerBanner onDismiss={vi.fn()} />);

    expect(screen.getByTestId('core-server-banner')).toBeInTheDocument();
    expect(screen.getByText(/CORE_SERVER_BANNER_DEFAULT_TITLE/)).toBeInTheDocument();
    expect(screen.getByText(/CORE_SERVER_BANNER_DEFAULT_MESSAGE/)).toBeInTheDocument();
  });

  it('renders the low-RAM message when memory is below the threshold', () => {
    render(<CoreServerBanner onDismiss={vi.fn()} system={{ memoryTotal: 4, diskSize: 500, cpuCores: 8 }} />);

    expect(screen.getByText(/CORE_SERVER_BANNER_LOW_RAM_TITLE/)).toBeInTheDocument();
    expect(screen.getByText(/CORE_SERVER_BANNER_LOW_RAM_MESSAGE/)).toBeInTheDocument();
  });

  it('renders the low-disk message when disk size is below the threshold', () => {
    render(<CoreServerBanner onDismiss={vi.fn()} system={{ memoryTotal: 16, diskSize: 50, cpuCores: 8 }} />);

    expect(screen.getByText(/CORE_SERVER_BANNER_LOW_DISK_TITLE/)).toBeInTheDocument();
    expect(screen.getByText(/CORE_SERVER_BANNER_LOW_DISK_MESSAGE/)).toBeInTheDocument();
  });

  it('renders the low-CPU message when CPU cores are at or below the threshold', () => {
    render(<CoreServerBanner onDismiss={vi.fn()} system={{ memoryTotal: 16, diskSize: 500, cpuCores: 2 }} />);

    expect(screen.getByText(/CORE_SERVER_BANNER_LOW_CPU_TITLE/)).toBeInTheDocument();
    expect(screen.getByText(/CORE_SERVER_BANNER_LOW_CPU_MESSAGE/)).toBeInTheDocument();
  });

  it('renders the default message when system data is present but no threshold matched', () => {
    render(<CoreServerBanner onDismiss={vi.fn()} system={{ memoryTotal: 16, diskSize: 500, cpuCores: 8 }} />);

    expect(screen.getByText(/CORE_SERVER_BANNER_DEFAULT_TITLE/)).toBeInTheDocument();
    expect(screen.getByText(/CORE_SERVER_BANNER_DEFAULT_MESSAGE/)).toBeInTheDocument();
  });

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(<CoreServerBanner onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders a "Learn more" link pointing to the Core Server page', () => {
    render(<CoreServerBanner onDismiss={vi.fn()} />);

    const link = screen.getByRole('link', { name: /CORE_SERVER_BANNER_LEARN_MORE/i });
    expect(link).toHaveAttribute('href', 'https://www.ci.computer/store/p/core');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('prioritises RAM message over disk when both are low', () => {
    render(<CoreServerBanner onDismiss={vi.fn()} system={{ memoryTotal: 4, diskSize: 50, cpuCores: 8 }} />);

    expect(screen.getByText(/CORE_SERVER_BANNER_LOW_RAM_TITLE/)).toBeInTheDocument();
  });
});
