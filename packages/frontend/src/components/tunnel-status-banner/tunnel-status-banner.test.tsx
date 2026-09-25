import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useRegistrationStatus, reconnectTunnel, resetRegistrationForRePair, navigate, invalidateQueries, toast } = vi.hoisted(() => ({
  useRegistrationStatus: vi.fn(),
  reconnectTunnel: vi.fn(),
  resetRegistrationForRePair: vi.fn(),
  navigate: vi.fn(),
  invalidateQueries: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/hooks/use-registration-status', () => ({
  useRegistrationStatus: () => useRegistrationStatus(),
}));

vi.mock('@/lib/registration-api', () => ({
  reconnectTunnel: () => reconnectTunnel(),
  resetRegistrationForRePair: () => resetRegistrationForRePair(),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getStatusQueryKey: () => ['getStatus'],
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router', () => ({
  useNavigate: () => navigate,
}));

vi.mock('sonner', () => ({
  toast: toast,
}));

import { TunnelStatusBanner } from './tunnel-status-banner';

const degraded = { data: { phase: 'degraded', registered: true, degradedReasons: ['tunnel_token_missing'] } };

describe('TunnelStatusBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders a reconnect banner when the public tunnel is degraded', () => {
    useRegistrationStatus.mockReturnValue(degraded);

    render(<TunnelStatusBanner />);

    expect(screen.getByTestId('tunnel-status-banner')).toBeInTheDocument();
    expect(screen.getByText('TUNNEL_DEGRADED_BANNER_TITLE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'TUNNEL_DEGRADED_BANNER_ACTION' })).toBeInTheDocument();
  });

  it('renders nothing when operational, for other degraded reasons, or while loading', () => {
    useRegistrationStatus.mockReturnValue({ data: { phase: 'locally_ready', registered: true, degradedReasons: [] } });
    expect(render(<TunnelStatusBanner />).container).toBeEmptyDOMElement();

    useRegistrationStatus.mockReturnValue({ data: { phase: 'degraded', registered: true, degradedReasons: ['dns_pending'] } });
    expect(render(<TunnelStatusBanner />).container).toBeEmptyDOMElement();

    useRegistrationStatus.mockReturnValue({ data: undefined });
    expect(render(<TunnelStatusBanner />).container).toBeEmptyDOMElement();
  });

  it('recovers in place on reconnect success (refetches status, no navigation)', async () => {
    useRegistrationStatus.mockReturnValue(degraded);
    reconnectTunnel.mockResolvedValue({ recovered: true, reason: 'recovered_from_db' });

    render(<TunnelStatusBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'TUNNEL_DEGRADED_BANNER_ACTION' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('TUNNEL_DEGRADED_RECONNECT_SUCCESS'));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['getStatus'] });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('resets then routes to the re-pair screen when there are no recoverable credentials', async () => {
    useRegistrationStatus.mockReturnValue(degraded);
    reconnectTunnel.mockResolvedValue({ recovered: false, action: 're_pair', reason: 'no_credentials' });
    resetRegistrationForRePair.mockResolvedValue({ ok: true });

    render(<TunnelStatusBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'TUNNEL_DEGRADED_BANNER_ACTION' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/device-registration'));
    expect(window.confirm).toHaveBeenCalled();
    expect(resetRegistrationForRePair).toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('does not reset or navigate if the user cancels the re-pair confirmation', async () => {
    useRegistrationStatus.mockReturnValue(degraded);
    reconnectTunnel.mockResolvedValue({ recovered: false, action: 're_pair', reason: 'no_credentials' });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<TunnelStatusBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'TUNNEL_DEGRADED_BANNER_ACTION' }));

    await waitFor(() => expect(reconnectTunnel).toHaveBeenCalled());
    expect(resetRegistrationForRePair).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate to re-pair if the reset fails', async () => {
    useRegistrationStatus.mockReturnValue(degraded);
    reconnectTunnel.mockResolvedValue({ recovered: false, action: 're_pair', reason: 'no_credentials' });
    resetRegistrationForRePair.mockResolvedValue({ ok: false });

    render(<TunnelStatusBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'TUNNEL_DEGRADED_BANNER_ACTION' }));

    await waitFor(() => expect(resetRegistrationForRePair).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('TUNNEL_DEGRADED_RECONNECT_FAILED');
  });

  it('prompts a restart when the token cannot be written yet', async () => {
    useRegistrationStatus.mockReturnValue(degraded);
    reconnectTunnel.mockResolvedValue({ recovered: false, action: 'restart', reason: 'tunnel_dir_not_writable' });

    render(<TunnelStatusBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'TUNNEL_DEGRADED_BANNER_ACTION' }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('TUNNEL_DEGRADED_RECONNECT_NEEDS_RESTART', expect.anything()));
    expect(navigate).not.toHaveBeenCalled();
  });
});
