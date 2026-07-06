import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const useRegistrationStatus = vi.fn();

vi.mock('@/lib/hooks/use-registration-status', () => ({
  useRegistrationStatus: () => useRegistrationStatus(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

import { TunnelStatusBanner } from './tunnel-status-banner';

describe('TunnelStatusBanner', () => {
  it('renders a re-pair banner when the public tunnel is degraded', () => {
    useRegistrationStatus.mockReturnValue({ data: { phase: 'degraded', registered: true, degradedReasons: ['tunnel_token_missing'] } });

    render(<TunnelStatusBanner />);

    expect(screen.getByTestId('tunnel-status-banner')).toBeInTheDocument();
    expect(screen.getByText('TUNNEL_DEGRADED_BANNER_TITLE')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'TUNNEL_DEGRADED_BANNER_ACTION' })).toHaveAttribute('href', '/device-registration');
  });

  it('renders nothing when the device is fully operational', () => {
    useRegistrationStatus.mockReturnValue({ data: { phase: 'locally_ready', registered: true, degradedReasons: [] } });

    const { container } = render(<TunnelStatusBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for other degraded reasons', () => {
    useRegistrationStatus.mockReturnValue({ data: { phase: 'degraded', registered: true, degradedReasons: ['dns_pending'] } });

    expect(render(<TunnelStatusBanner />).container).toBeEmptyDOMElement();
  });

  it('renders nothing while the status is still loading', () => {
    useRegistrationStatus.mockReturnValue({ data: undefined });

    expect(render(<TunnelStatusBanner />).container).toBeEmptyDOMElement();
  });
});
