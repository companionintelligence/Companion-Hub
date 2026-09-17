import { act, fireEvent, render, screen, waitFor } from '@/tests/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** The desktop shell's side of a `cihub://pair` link, as in main.rs: one parked code, plus listeners. */
const shell = vi.hoisted(() => ({
  parkedPairingCode: null as string | null,
  pairListeners: [] as Array<(event: { payload: string }) => void>,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: string }) => void) => {
    if (name === 'deep-link-pair') {
      shell.pairListeners.push(handler);
    }
    return () => {
      shell.pairListeners = shell.pairListeners.filter((listener) => listener !== handler);
    };
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command !== 'consume_pending_pairing_code') {
      return null;
    }
    const code = shell.parkedPairingCode;
    shell.parkedPairingCode = null;
    return code;
  },
}));

/** What queue_pairing_code does with a link: park the code, then emit it. */
function openPairingLink(code: string) {
  shell.parkedPairingCode = code;
  for (const listener of [...shell.pairListeners]) {
    listener({ payload: code });
  }
}

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
    const deviceId = screen.getByText('device-123');
    expect(deviceId).toBeInTheDocument();
    expect(deviceId).toHaveClass('truncate');
    expect(deviceId).toHaveAttribute('title', 'device-123');
    expect(setHubSentryDeviceId).toHaveBeenCalledWith('device-123');
    expect(screen.getByLabelText('Enter Pairing Code:')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to CI Account' })).toHaveAttribute('href', 'https://portal.example.com');
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

    expect(await screen.findByRole('link', { name: 'Sign in to CI Account' })).toHaveAttribute(
      'href',
      'https://portal.example.com/device/register?device_id=device-123&callback_url=http%3A%2F%2Flocalhost%3A5002%2Fdevice-registration',
    );
  });

  it('offers both step 1 links as scannable codes for appliances with no browser', async () => {
    // A headless CI-OS box (or an SSH session) has no browser to open the anchor
    // in, so each link is also published as a QR. The disclosure stays collapsed
    // so the two-column desktop layout stays balanced, and once open the plate
    // is bare — no caption, no printed fallback link — since the "Scan QR"
    // button the user just pressed is already all the context it needs; the
    // payload is still carried on the SVG's accessible name for screen readers.
    render(<DeviceRegistrationPage />);

    expect(await screen.findByRole('button', { name: 'Scan QR to sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scan QR to create an account' })).toBeInTheDocument();
    expect(screen.queryByTitle('QR code')).not.toBeInTheDocument();
    expect(screen.queryByText('https://portal.example.com')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Scan QR to sign in' }));
    expect(screen.queryByText('No browser on this device? Scan to sign in on your phone.')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'https://portal.example.com' })).toBeInTheDocument();
    expect(screen.queryByText('https://portal.example.com')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Scan QR to create an account' }));
    expect(screen.queryByText('Or scan to create your account on your phone.')).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: 'https://portal.example.com/signup?redirect=%2Fhome%3Fadd_device%3D1%26hub_device_id%3Ddevice-123',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('https://portal.example.com/signup?redirect=%2Fhome%3Fadd_device%3D1%26hub_device_id%3Ddevice-123'),
    ).not.toBeInTheDocument();
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
    // ...device info is loaded so the device ID is shown (not stuck "Loading device ID...")...
    expect(await screen.findByText('device-123')).toBeInTheDocument();
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
      expect(screen.getByRole('link', { name: 'Sign in to CI Account' })).toHaveAttribute('href', 'https://portal.example.com/home');
    });
  });

  describe('pairing links from the desktop app', () => {
    // Portal spends a code on its first use. A copy of the link left behind was submitted again the
    // next time this screen opened in the same session, and failed with "no longer valid".
    const win = window as unknown as Record<string, unknown>;
    const STASH_KEY = 'ci-hub.pending-pairing-code';

    beforeEach(() => {
      win.__TAURI_INTERNALS__ = {};
      shell.parkedPairingCode = null;
      shell.pairListeners = [];
    });

    afterEach(() => {
      delete win.__TAURI_INTERNALS__;
    });

    async function openScreenAgain() {
      render(<DeviceRegistrationPage />);
      expect(await screen.findByRole('heading', { name: 'Step 2: Connect this device' })).toBeInTheDocument();
      await flushAsyncWork();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    }

    it('submits a link opened on this screen once, and leaves no copy for the next visit', async () => {
      const first = render(<DeviceRegistrationPage />);
      await waitFor(() => expect(shell.pairListeners.length).toBeGreaterThan(0));

      act(() => openPairingLink('ABC123'));

      await waitFor(() => expect(pairWithCode).toHaveBeenCalledWith('ABC123'));
      await waitFor(() => expect(shell.parkedPairingCode).toBeNull());
      expect(sessionStorage.getItem(STASH_KEY)).toBeNull();

      first.unmount();
      await openScreenAgain();
      expect(pairWithCode).toHaveBeenCalledTimes(1);
    });

    it('submits a link delivered twice once, and keeps no copy of the second delivery', async () => {
      const first = render(<DeviceRegistrationPage />);
      await waitFor(() => expect(shell.pairListeners.length).toBeGreaterThan(0));

      act(() => openPairingLink('ABC123'));
      await waitFor(() => expect(pairWithCode).toHaveBeenCalledWith('ABC123'));
      // Linux and Windows hand the app every link twice.
      act(() => openPairingLink('ABC123'));

      await waitFor(() => expect(shell.parkedPairingCode).toBeNull());
      await waitFor(() => expect(sessionStorage.getItem(STASH_KEY)).toBeNull());

      first.unmount();
      await openScreenAgain();
      expect(pairWithCode).toHaveBeenCalledTimes(1);
    });

    it('submits a link that arrived before this screen opened once, and leaves no copy', async () => {
      // The shell parked it, and the app-wide listener stashed it.
      shell.parkedPairingCode = 'DEF456';
      sessionStorage.setItem(STASH_KEY, 'DEF456');

      const first = render(<DeviceRegistrationPage />);

      await waitFor(() => expect(pairWithCode).toHaveBeenCalledWith('DEF456'));
      await waitFor(() => expect(sessionStorage.getItem(STASH_KEY)).toBeNull());
      expect(shell.parkedPairingCode).toBeNull();

      first.unmount();
      await openScreenAgain();
      expect(pairWithCode).toHaveBeenCalledTimes(1);
    });

    it('does not resubmit a refused code, or repeat its error, on the next visit', async () => {
      pairWithCode.mockResolvedValue({
        ok: true,
        status: 201,
        data: { success: false, message: 'That pairing code is no longer valid. Ask for a new one.' },
      });
      const first = render(<DeviceRegistrationPage />);
      await waitFor(() => expect(shell.pairListeners.length).toBeGreaterThan(0));

      act(() => openPairingLink('GHI789'));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('That pairing code is no longer valid. Ask for a new one.'));
      // The code stays in the box, so Register can still retry it by hand.
      expect(screen.getByLabelText('Enter Pairing Code:')).toHaveValue('GHI789');

      first.unmount();
      await openScreenAgain();
      expect(pairWithCode).toHaveBeenCalledTimes(1);
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
  });
});
