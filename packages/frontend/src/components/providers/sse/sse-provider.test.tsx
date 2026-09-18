import { render, screen, userEvent } from '@/tests/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isStackUpdatePending, markStackUpdatePending, subscribeStackUpdate } from '@/lib/desktop-stack-session';
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
  // .success/.error/.dismiss — mirror that shape via Object.assign so the callable
  // and its methods stay type-safe, and so `toast(...)` is exercised too.
  const toast = Object.assign((...args: unknown[]) => mockToast(...args), {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
    dismiss: (...args: unknown[]) => mockToastDismiss(...args),
  });
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

    // The toast body must render the exact host path in a runnable, shell-safe command
    // (single-quoted + `--` so a path with spaces/metacharacters can't misfire on paste).
    render(<MemoryRouter>{message()}</MemoryRouter>);
    expect(screen.getByText("sudo rm -rf -- '/srv/app-data/community/excalidraw'")).toBeInTheDocument();
  });

  describe('public_dns_error', () => {
    const firePublicDnsError = (errorCode?: string) => {
      const getOnEvent = renderProvider();
      act(() => {
        getOnEvent()?.({ event: 'public_dns_error', appUrn: 'n8n:ci-marketplace', error: 'n8n-laptop-acme.companionintelligence.com', errorCode });
      });
      expect(mockToastError).toHaveBeenCalledTimes(1);
      return mockToastError.mock.calls[0]?.[0];
    };

    it('names the plan when the Portal refuses an app over the quota', () => {
      const message = firePublicDnsError('subdomain_quota_exceeded');

      expect(message).toBe(
        "n8n can't get a public address: your organization's plan includes no more. Remove another app's public address, or upgrade the plan in the Portal.",
      );
      // Waiting does not help and the domain is fine, so the toast must say neither.
      expect(message).not.toMatch(/retr|clears on its own|domain/i);
    });

    it.each([
      [
        'duplicate_subdomain',
        "n8n can't get a public address: another app on this Hub already uses the same subdomain. Give n8n a different subdomain.",
      ],
      [
        'release_pending',
        "n8n keeps its current public address for now: its previous address hasn't been released yet. The Hub retries the change automatically.",
      ],
      ['write_failed', "Couldn't create a public address for n8n just now. This usually clears on its own — it will be retried automatically."],
    ])('shows the copy for %s', (errorCode, expected) => {
      expect(firePublicDnsError(errorCode)).toBe(expected);
    });

    it('falls back to the generic copy for a class it does not know', () => {
      expect(firePublicDnsError('not_yet_invented')).toBe(
        "Couldn't create a public address for n8n. Verify the selected domain is available for this device.",
      );
    });
  });

  describe('hub_hello', () => {
    const mountWithHandler = () => {
      let onEvent: ((data: unknown) => void) | undefined;
      mockUseSSE.mockImplementation((config: { onEvent: (data: unknown) => void }) => {
        onEvent = config.onEvent;
      });
      const queryClient = new QueryClient();
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SSEProvider>
              <div>child</div>
            </SSEProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      return { fire: (data: unknown) => act(() => onEvent?.(data)), invalidate };
    };

    beforeEach(() => {
      sessionStorage.clear();
    });

    it('resolves a pending stack update when the Hub greets on a new version', () => {
      markStackUpdatePending('0.2.71');
      const outcomes: unknown[] = [];
      const unsubscribe = subscribeStackUpdate((outcome) => outcomes.push(outcome));
      const { fire, invalidate } = mountWithHandler();

      fire({ event: 'hub_hello', version: '0.2.72' });

      expect(isStackUpdatePending()).toBe(false);
      expect(outcomes).toEqual([{ state: 'completed', version: '0.2.72' }]);
      expect(invalidate).toHaveBeenCalledTimes(1);
      // The greeting is the Hub's, not an app's: it must never reach the app cache or a toast.
      expect(mockHandleAppSseEvent).not.toHaveBeenCalled();
      expect(mockToastSuccess).not.toHaveBeenCalled();
      expect(mockToastError).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('keeps a fresh pending update waiting when the old container greets first', () => {
      markStackUpdatePending('0.2.71');
      const { fire, invalidate } = mountWithHandler();
      fire({ event: 'hub_hello', version: '0.2.71' });
      expect(isStackUpdatePending()).toBe(true);
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('is inert when nothing is pending', () => {
      const { fire, invalidate } = mountWithHandler();
      fire({ event: 'hub_hello', version: '0.2.72' });
      expect(invalidate).not.toHaveBeenCalled();
      expect(mockHandleAppSseEvent).not.toHaveBeenCalled();
    });
  });
});
