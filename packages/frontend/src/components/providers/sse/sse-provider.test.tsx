import { render, screen, userEvent } from '@/tests/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SSEProvider } from './sse-provider';

const { mockUseSSE, mockHandleAppSseEvent, mockToast, mockToastError, mockToastDismiss, mockToastSuccess } = vi.hoisted(() => ({
  mockUseSSE: vi.fn(),
  mockHandleAppSseEvent: vi.fn(),
  mockToast: vi.fn(),
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

vi.mock('react-hot-toast', () => {
  // The default export is itself callable (plain warning toast) AND carries
  // .success/.error/.dismiss — mirror that so `toast(...)` is exercised too.
  const toast = (...args: unknown[]) => mockToast(...args);
  toast.error = (...args: unknown[]) => mockToastError(...args);
  toast.success = (...args: unknown[]) => mockToastSuccess(...args);
  toast.dismiss = (...args: unknown[]) => mockToastDismiss(...args);
  return { default: toast };
});

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

  const renderProvider = () => {
    let onEvent: ((data: unknown) => void) | undefined;
    mockUseSSE.mockImplementation((config: { onEvent: (data: unknown) => void }) => {
      onEvent = config.onEvent;
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SSEProvider>
            <div>child</div>
          </SSEProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return () => onEvent;
  };

  it('warns (not a plain success) when uninstall_success carries a warningCode (#907)', () => {
    const getOnEvent = renderProvider();

    act(() => {
      getOnEvent()?.({ event: 'uninstall_success', appUrn: 'excalidraw:community', warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT' });
    });

    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('could not be fully removed'), expect.objectContaining({ icon: '⚠️' }));
  });

  it('shows the plain success toast when uninstall_success has no warningCode', () => {
    const getOnEvent = renderProvider();

    act(() => {
      getOnEvent()?.({ event: 'uninstall_success', appUrn: 'excalidraw:community' });
    });

    expect(mockToast).not.toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('uninstalled successfully'));
  });

  it('shows an actionable manual-cleanup command when uninstall_success carries a warningDetail path (#907)', () => {
    const getOnEvent = renderProvider();

    act(() => {
      getOnEvent()?.({
        event: 'uninstall_success',
        appUrn: 'excalidraw:community',
        warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
        warningDetail: '/srv/app-data/community/excalidraw',
      });
    });

    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledTimes(1);
    const [message, opts] = mockToast.mock.calls[0] as [() => ReactNode, { icon?: string }];
    expect(opts).toEqual(expect.objectContaining({ icon: '⚠️' }));

    // The toast body must render the exact host path in a runnable command.
    render(<MemoryRouter>{message()}</MemoryRouter>);
    expect(screen.getByText('sudo rm -rf /srv/app-data/community/excalidraw')).toBeInTheDocument();
  });
});
