import { act, fireEvent, render, screen, waitFor } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistrationStatus } from '@/lib/registration-status';
import DeviceRegistrationPage from './device-registration-page';

const {
  captureHubWarning,
  navigate,
  setHubSentryDeviceId,
  toast,
  fetchRegistrationStatusResult,
  fetchDeviceRegistrationInfoResult,
  fetchRegistrationStateDrift,
  pairWithCode,
  markRegistrationRestoreIntentDetailed,
  prepareFreshRegistrationDetailed,
  probeRegistrationDomain,
} = vi.hoisted(() => ({
  captureHubWarning: vi.fn(),
  navigate: vi.fn(),
  setHubSentryDeviceId: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
  fetchRegistrationStatusResult: vi.fn(),
  fetchDeviceRegistrationInfoResult: vi.fn(),
  fetchRegistrationStateDrift: vi.fn(),
  pairWithCode: vi.fn(),
  markRegistrationRestoreIntentDetailed: vi.fn(),
  prepareFreshRegistrationDetailed: vi.fn(),
  probeRegistrationDomain: vi.fn(),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock('@/lib/registration-api', () => ({
  fetchRegistrationStatusResult,
  fetchDeviceRegistrationInfoResult,
  fetchRegistrationStateDrift,
  pairWithCode,
  markRegistrationRestoreIntentDetailed,
  prepareFreshRegistrationDetailed,
  probeRegistrationDomain,
}));

vi.mock('@/lib/sentry', () => ({
  captureHubWarning,
  setHubSentryDeviceId,
}));

vi.mock('react-hot-toast', () => ({
  default: toast,
}));

function makeStatus(phase: RegistrationStatus['phase'], registered = false): RegistrationStatus {
  return {
    phase,
    registered,
    degradedReasons: [],
  };
}

function statusOk(phase: RegistrationStatus['phase'], registered = false) {
  return { ok: true, status: 200, data: makeStatus(phase, registered) };
}

function deviceInfo(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    data: {
      device_id: 'device-123',
      ci_cloud_url: 'https://portal.example.com/',
      ...overrides,
    },
  };
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('DeviceRegistrationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    sessionStorage.clear();
    fetchRegistrationStatusResult.mockResolvedValue(statusOk('unregistered'));
    fetchDeviceRegistrationInfoResult.mockResolvedValue(deviceInfo());
    fetchRegistrationStateDrift.mockResolvedValue({ detected: false, signals: [] });
    pairWithCode.mockResolvedValue({ ok: true, status: 200, data: { success: true, domain: 'example.com', subdomain: 'hub' } });
    markRegistrationRestoreIntentDetailed.mockResolvedValue({ ok: true, data: { success: true } });
    prepareFreshRegistrationDetailed.mockResolvedValue({ ok: true, data: { success: true } });
    probeRegistrationDomain.mockResolvedValue({ ready: true });
  });

  it('shows the pairing form only after confirming the Hub is unregistered', async () => {
    render(<DeviceRegistrationPage />);

    expect(await screen.findByRole('heading', { name: 'Step 2: Connect this device' })).toBeInTheDocument();
    expect(
      screen.getByText('In your Companion Account, click Add Device, name your Hub, then paste the pairing code here to finish registration.'),
    ).toBeInTheDocument();
    expect(screen.getByText('device-123')).toBeInTheDocument();
    expect(setHubSentryDeviceId).toHaveBeenCalledWith('device-123');
    expect(screen.getByLabelText('Enter Pairing Code:')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Login to Companion Account' })).toHaveAttribute('href', 'https://portal.example.com');
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute(
      'href',
      'https://portal.example.com/signup?redirect=%2Fhome%3Fadd_device%3D1%26hub_device_id%3Ddevice-123',
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('uses the device-scoped registration URL for login when the backend provides one', async () => {
    fetchDeviceRegistrationInfoResult.mockResolvedValue(
      deviceInfo({
        registration_url:
          'https://portal.example.com/device/register?device_id=device-123&callback_url=http%3A%2F%2Flocalhost%3A5002%2Fdevice-registration',
      }),
    );

    render(<DeviceRegistrationPage />);

    expect(await screen.findByRole('link', { name: 'Login to Companion Account' })).toHaveAttribute(
      'href',
      'https://portal.example.com/device/register?device_id=device-123&callback_url=http%3A%2F%2Flocalhost%3A5002%2Fdevice-registration',
    );
  });

  it('shows a retryable temporary-unavailable state instead of the pairing form when status lookup fails', async () => {
    fetchRegistrationStatusResult.mockResolvedValue({ ok: false, status: 503, data: undefined });

    render(<DeviceRegistrationPage />);

    expect(await screen.findByRole('heading', { name: 'Registration status temporarily unavailable' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Enter Pairing Code:')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry status check' })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not keep polling registration status after a failed lookup', async () => {
    fetchRegistrationStatusResult.mockResolvedValue({ ok: false, status: 503, data: undefined });

    render(<DeviceRegistrationPage />);
    expect(await screen.findByRole('heading', { name: 'Registration status temporarily unavailable' })).toBeInTheDocument();
    const initialCalls = fetchRegistrationStatusResult.mock.calls.length;

    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    expect(fetchRegistrationStatusResult.mock.calls.length).toBe(initialCalls);
    vi.useRealTimers();
  });

  it('submits pairing without immediate navigation when status remains unregistered', async () => {
    render(<DeviceRegistrationPage />);
    await flushAsyncWork();

    expect(screen.getByRole('heading', { name: 'Step 2: Connect this device' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Enter Pairing Code:'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() => {
      expect(pairWithCode).toHaveBeenCalledWith('ABC123');
    });

    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not show the state drift dialog while pairing is in progress', async () => {
    fetchRegistrationStateDrift.mockImplementation(async () => {
      if (pairWithCode.mock.calls.length > 0) {
        return {
          detected: true,
          hardwareDeviceId: 'device-123',
          localRegistered: false,
          portalDeviceActive: true,
          staleAppEnvDeviceIds: [],
          hasStaleTunnelToken: false,
          signals: [{ reason: 'local_unregistered_portal_active' }],
        };
      }
      return { detected: false, signals: [] };
    });

    render(<DeviceRegistrationPage />);
    await flushAsyncWork();

    fireEvent.change(screen.getByLabelText('Enter Pairing Code:'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() => {
      expect(pairWithCode).toHaveBeenCalledWith('ABC123');
    });

    expect(screen.queryByRole('heading', { name: 'Reconnect this Hub' })).not.toBeInTheDocument();
  });

  it('shows the state drift dialog when local and portal registration disagree', async () => {
    fetchRegistrationStateDrift.mockResolvedValue({
      detected: true,
      hardwareDeviceId: 'device-123',
      localRegistered: false,
      portalDeviceActive: true,
      staleAppEnvDeviceIds: ['old-device-id'],
      hasStaleTunnelToken: false,
      signals: [{ reason: 'local_unregistered_portal_active' }],
    });

    render(<DeviceRegistrationPage />);

    expect(await screen.findByRole('heading', { name: 'Reconnect this Hub' })).toBeInTheDocument();
    expect(screen.getByTestId('drift-setup-new')).toBeInTheDocument();
    expect(screen.getByTestId('drift-restore')).toBeInTheDocument();
  });

  it('renders the re-pair form instead of bouncing to login when the public tunnel is degraded', async () => {
    fetchRegistrationStatusResult.mockResolvedValue({
      ok: true,
      status: 200,
      data: { phase: 'degraded', registered: true, degradedReasons: ['tunnel_token_missing'] },
    });

    render(<DeviceRegistrationPage />);

    // The pairing form renders so the user can re-pair...
    expect(await screen.findByLabelText('Enter Pairing Code:')).toBeInTheDocument();
    // ...with an explanation of why remote access needs attention...
    expect(screen.getByText(/public URL is offline/i)).toBeInTheDocument();
    // ...and the page does NOT auto-bounce to the local app.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('points the login button at Portal home (not the Add Device intent URL) after choosing restore', async () => {
    fetchDeviceRegistrationInfoResult.mockResolvedValue(
      deviceInfo({
        registration_url:
          'https://portal.example.com/device/register?device_id=device-123&callback_url=http%3A%2F%2Flocalhost%3A5002%2Fdevice-registration',
      }),
    );
    fetchRegistrationStateDrift.mockResolvedValue({
      detected: true,
      hardwareDeviceId: 'device-123',
      localRegistered: false,
      portalDeviceActive: true,
      staleAppEnvDeviceIds: ['old-device-id'],
      hasStaleTunnelToken: false,
      signals: [{ reason: 'local_unregistered_portal_active' }],
    });

    render(<DeviceRegistrationPage />);

    fireEvent.click(await screen.findByTestId('drift-restore'));

    await waitFor(() => {
      expect(markRegistrationRestoreIntentDetailed).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Login to Companion Account' })).toHaveAttribute('href', 'https://portal.example.com/home');
    });
  });
});
