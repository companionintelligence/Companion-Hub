import { render, screen, userEvent } from '@/tests/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SSEProvider } from './sse-provider';

const { mockUseSSE, mockHandleAppSseEvent, mockToastError, mockToastDismiss, mockToastSuccess } = vi.hoisted(() => ({
  mockUseSSE: vi.fn(),
  mockHandleAppSseEvent: vi.fn(),
  mockToastError: vi.fn(),
  mockToastDismiss: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock('@/lib/hooks/use-sse', () => ({
  useSSE: (...args: unknown[]) => mockUseSSE(...args),
}));

vi.mock('@/modules/app/helpers/app-sse-cache', () => ({
  handleAppSseEvent: (...args: unknown[]) => mockHandleAppSseEvent(...args),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
    dismiss: (...args: unknown[]) => mockToastDismiss(...args),
  },
}));

describe('SSEProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links install failure to the logs tab', async () => {
    let onEvent: ((data: unknown) => void) | undefined;
    mockUseSSE.mockImplementation((config: { onEvent: (data: unknown) => void }) => {
      onEvent = config.onEvent;
    });

    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SSEProvider>
            <div>child</div>
          </SSEProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    act(() => {
      onEvent?.({ event: 'install_error', appUrn: 'excalidraw:community' });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);

    const toastMessage = mockToastError.mock.calls[0]?.[0] as ((toast: { id: string }) => ReactNode) | undefined;
    expect(toastMessage).toBeTypeOf('function');

    render(<MemoryRouter>{toastMessage?.({ id: 'install-error-toast' })}</MemoryRouter>);

    const logsLink = screen.getByRole('link', { name: 'see logs' });

    expect(logsLink).toHaveAttribute('href', '/settings?tab=logs');
    expect(logsLink.parentElement).toHaveTextContent('Failed to install app excalidraw, see logs for more details');

    await userEvent.click(logsLink);

    expect(mockToastDismiss).toHaveBeenCalledWith('install-error-toast');
  });

  it('renders install_error rocm_kfd_missing branch', () => {
    let onEvent: ((data: unknown) => void) | undefined;
    mockUseSSE.mockImplementation((config: { onEvent: (data: unknown) => void }) => {
      onEvent = config.onEvent;
    });

    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SSEProvider>
            <div>child</div>
          </SSEProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    act(() => {
      onEvent?.({ event: 'install_error', errorCode: 'rocm_kfd_missing', appUrn: 'excalidraw:community' });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it('renders install_error network_overlap branch', () => {
    let onEvent: ((data: unknown) => void) | undefined;
    mockUseSSE.mockImplementation((config: { onEvent: (data: unknown) => void }) => {
      onEvent = config.onEvent;
    });

    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SSEProvider>
            <div>child</div>
          </SSEProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    act(() => {
      onEvent?.({ event: 'install_error', errorCode: 'network_overlap', appUrn: 'excalidraw:community' });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it('renders tailscale_serve_error with custom toast duration', () => {
    let onEvent: ((data: unknown) => void) | undefined;
    mockUseSSE.mockImplementation((config: { onEvent: (data: unknown) => void }) => {
      onEvent = config.onEvent;
    });

    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SSEProvider>
            <div>child</div>
          </SSEProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    act(() => {
      onEvent?.({ event: 'tailscale_serve_error', appUrn: 'excalidraw:community' });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError.mock.calls[0]?.[1]).toMatchObject({ duration: 10000 });
  });

  it('links app operation failures to the logs tab via "see logs"', async () => {
    let onEvent: ((data: unknown) => void) | undefined;
    mockUseSSE.mockImplementation((config: { onEvent: (data: unknown) => void }) => {
      onEvent = config.onEvent;
    });

    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SSEProvider>
            <div>child</div>
          </SSEProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    act(() => {
      onEvent?.({ event: 'start_error', appUrn: 'excalidraw:community' });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);

    const toastMessage = mockToastError.mock.calls[0]?.[0] as ((toast: { id: string }) => ReactNode) | undefined;
    expect(toastMessage).toBeTypeOf('function');

    render(<MemoryRouter>{toastMessage?.({ id: 'start-error-toast' })}</MemoryRouter>);

    const logsLink = screen.getByRole('link', { name: 'see logs' });

    expect(logsLink).toHaveAttribute('href', '/settings?tab=logs');
    expect(logsLink.parentElement).toHaveTextContent('Failed to start app excalidraw, see logs for more details');

    await userEvent.click(logsLink);

    expect(mockToastDismiss).toHaveBeenCalledWith('start-error-toast');
  });
});
