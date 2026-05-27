import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkSettingsContainer } from '../network-settings';

const mockApiFetch = vi.fn();
const mockOpenExternal = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const writeTextMock = vi.fn();

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/lib/helpers/open-external', () => ({
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function renderContainer() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <NetworkSettingsContainer />
    </QueryClientProvider>,
  );
}

describe('NetworkSettingsContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeTextMock.mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/tailscale/status') {
        return Promise.resolve({
          json: async () => ({
            installed: true,
            connected: true,
            ip: '100.64.0.1',
            hostname: 'hub',
            backendState: 'Running',
          }),
        });
      }

      if (url === '/api/tailscale/devices') {
        return Promise.resolve({
          json: async () => ({
            devices: [
              {
                id: 'dev-1',
                name: 'Mac mini',
                online: true,
                status: 'online',
                tailscaleUrl: 'https://mac-mini.tailnet.ts.net',
                adminUrl: 'https://mac-mini.tailnet.ts.net/admin',
              },
            ],
            message: null,
          }),
        });
      }

      if (url === '/api/cloudflare/status') {
        return Promise.resolve({
          json: async () => ({
            tunnelEnabled: true,
            tunnelId: 'tunnel-1',
            message: 'Connected',
          }),
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
  });

  it('renders registered Tailscale device URLs with copy and admin actions', async () => {
    renderContainer();

    expect(await screen.findByText('Registered device URLs')).toBeInTheDocument();
    expect(screen.getByText('Mac mini')).toBeInTheDocument();
    expect(screen.getAllByText('Online')).not.toHaveLength(0);
    expect(screen.getByText('https://mac-mini.tailnet.ts.net')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy Tailscale URL for Mac mini' }));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('https://mac-mini.tailnet.ts.net');
      expect(toastSuccess).toHaveBeenCalledWith('SETTINGS_NETWORK_COPIED');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Admin Panel' }));
    await waitFor(() => {
      expect(mockOpenExternal).toHaveBeenCalledWith('https://mac-mini.tailnet.ts.net/admin');
    });
  });

  it('shows the backend message when no registered Tailscale devices are available', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/tailscale/status') {
        return Promise.resolve({
          json: async () => ({
            installed: true,
            connected: false,
            ip: null,
            hostname: null,
            backendState: 'Stopped',
          }),
        });
      }

      if (url === '/api/tailscale/devices') {
        return Promise.resolve({
          json: async () => ({
            devices: [],
            message: 'Register this Hub with Companion Cloud to load your device directory.',
          }),
        });
      }

      if (url === '/api/cloudflare/status') {
        return Promise.resolve({
          json: async () => ({
            tunnelEnabled: false,
            tunnelId: null,
            message: 'Disconnected',
          }),
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    renderContainer();

    await waitFor(() => {
      expect(screen.getByText('Register this Hub with Companion Cloud to load your device directory.')).toBeInTheDocument();
    });
  });
});
