import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const useQuery = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => useQuery(...args),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getStatusOptions: () => ({ queryKey: ['getStatus'], queryFn: vi.fn() }),
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
    useQuery.mockReturnValue({ data: { phase: 'degraded', registered: true, degradedReasons: ['tunnel_token_missing'] } });

    render(<TunnelStatusBanner />);

    expect(screen.getByTestId('tunnel-status-banner')).toBeInTheDocument();
    expect(screen.getByText('TUNNEL_DEGRADED_BANNER_TITLE')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'TUNNEL_DEGRADED_BANNER_ACTION' })).toHaveAttribute('href', '/device-registration');
  });

  it('renders nothing when the device is fully operational', () => {
    useQuery.mockReturnValue({ data: { phase: 'locally_ready', registered: true, degradedReasons: [] } });

    const { container } = render(<TunnelStatusBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for other degraded reasons', () => {
    useQuery.mockReturnValue({ data: { phase: 'degraded', registered: true, degradedReasons: ['dns_pending'] } });

    expect(render(<TunnelStatusBanner />).container).toBeEmptyDOMElement();
  });

  it('renders nothing while the status is still loading', () => {
    useQuery.mockReturnValue({ data: undefined });

    expect(render(<TunnelStatusBanner />).container).toBeEmptyDOMElement();
  });
});
