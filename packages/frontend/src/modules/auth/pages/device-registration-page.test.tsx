import { act, fireEvent, render, screen, waitFor } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistrationStatus } from '@/lib/registration-status';
import DeviceRegistrationPage from './device-registration-page';

const { captureHubWarning, navigate, apiFetch, setHubSentryDeviceId, toast } = vi.hoisted(() => ({
  captureHubWarning: vi.fn(),
  navigate: vi.fn(),
  apiFetch: vi.fn(),
  setHubSentryDeviceId: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock('@/lib/api-fetch', () => ({
  apiFetch,
}));

vi.mock('@/lib/sentry', () => ({
  captureHubWarning,
  setHubSentryDeviceId,
}));

vi.mock('react-hot-toast', () => ({
  default: toast,
}));

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

function makeStatus(phase: RegistrationStatus['phase'], registered = false): RegistrationStatus {
  return {
    phase,
    registered,
    degradedReasons: [],
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
    apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/registration/status') {
        return jsonResponse(makeStatus('unregistered'));
      }
      if (url === '/api/registration/device-id') {
        return jsonResponse({ device_id: 'device-123', ci_cloud_url: 'https://portal.example.com/' });
      }
      return jsonResponse({});
    });
  });

  it('shows the pairing form only after confirming the Hub is unregistered', async () => {
    apiFetch.mockResolvedValueOnce(jsonResponse(makeStatus('unregistered'))).mockResolvedValueOnce(
      jsonResponse({
        device_id: 'device-123',
        ci_cloud_url: 'https://portal.example.com/',
      }),
    );

    render(<DeviceRegistrationPage />);

    expect(await screen.findByRole('heading', { name: 'Step 2: Connect this device' })).toBeInTheDocument();
    expect(
      screen.getByText('In your Companion Account, click Add Device, name your Hub, then paste the pairing code here to finish registration.'),
    ).toBeInTheDocument();
    expect(screen.getByText('device-123')).toBeInTheDocument();
    expect(setHubSentryDeviceId).toHaveBeenCalledWith('device-123');
    expect(screen.getByLabelText('Enter Pairing Code:')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Login to Companion Account' })).toHaveAttribute('href', 'https://portal.example.com');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows a retryable temporary-unavailable state instead of the pairing form when status lookup fails', async () => {
    apiFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));

    render(<DeviceRegistrationPage />);

    expect(await screen.findByRole('heading', { name: 'Registration status temporarily unavailable' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Enter Pairing Code:')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry status check' })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('submits pairing without immediate navigation when status remains unregistered', async () => {
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/registration/status') {
        return jsonResponse(makeStatus('unregistered'));
      }

      if (url === '/api/registration/device-id') {
        return jsonResponse({ device_id: 'device-123', ci_cloud_url: 'https://portal.example.com' });
      }

      if (url === '/api/registration/pair' && init?.method === 'POST') {
        return jsonResponse({ success: true });
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(<DeviceRegistrationPage />);
    await flushAsyncWork();

    expect(screen.getByRole('heading', { name: 'Step 2: Connect this device' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Enter Pairing Code:'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/registration/pair',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ pairing_code: 'ABC123' }) }),
      );
    });

    // Pairing submission should not trigger an immediate route transition in this branch.
    expect(navigate).not.toHaveBeenCalled();
  });
});
