import { render, screen, userEvent } from '@/tests/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isStackUpdatePending, markStackUpdatePending, subscribeStackUpdate } from '@/lib/desktop-stack-session';
import { SSEProvider } from './sse-provider';

const { appNameCache } = vi.hoisted(() => ({ appNameCache: { dropped: false } }));

const { mockUseSSE, mockHandleAppSseEvent, mockInvalidateAppRecords, mockToastWarning, mockToastError, mockToastDismiss, mockToastSuccess } =
  vi.hoisted(() => ({
    mockUseSSE: vi.fn(),
    mockHandleAppSseEvent: vi.fn(),
    mockInvalidateAppRecords: vi.fn(),
    mockToastWarning: vi.fn(),
    mockToastError: vi.fn(),
    mockToastDismiss: vi.fn(),
    mockToastSuccess: vi.fn(),
  }));

vi.mock('@/lib/hooks/use-sse', () => ({
  useSSE: (...args: unknown[]) => mockUseSSE(...args),
}));

vi.mock('@/modules/app/helpers/app-sse-cache', () => ({
  handleAppSseEvent: (...args: unknown[]) => mockHandleAppSseEvent(...args),
  invalidateAppRecords: (...args: unknown[]) => mockInvalidateAppRecords(...args),
  // The page's name for the app, as the cache would give it, until an event has taken it out.
  cachedAppName: (_queryClient: unknown, appUrn: string, fallback: string) =>
    appUrn === 'uptime-kuma:ci-marketplace' && !appNameCache.dropped ? 'Uptime Kuma' : fallback,
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
    warning: (...args: unknown[]) => mockToastWarning(...args),
    dismiss: (...args: unknown[]) => mockToastDismiss(...args),
  },
}));

describe('SSEProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appNameCache.dropped = false;
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

    // Sonner hands back the new toast's id; the "see logs" link closes the toast by it.
    mockToastError.mockReturnValueOnce('install-error-toast');
    act(() => {
      onEvent?.({ event: 'install_error', appUrn: 'excalidraw:community' });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);

    const toastMessage = mockToastError.mock.calls[0]?.[0] as ReactNode;

    render(<MemoryRouter>{toastMessage}</MemoryRouter>);

    const logsLink = screen.getByRole('link', { name: 'see logs' });

    expect(logsLink).toHaveAttribute('href', '/settings?tab=logs');
    expect(logsLink.parentElement).toHaveTextContent('Failed to install app excalidraw, see logs for more details');

    await userEvent.click(logsLink);

    expect(mockToastDismiss).toHaveBeenCalledWith('install-error-toast');
  });

  it.each([
    ['start_error', 'kvm_missing', 'This app needs hardware virtualization (KVM). It is not available on this machine.'],
    ['install_error', 'kvm_missing', 'This app needs hardware virtualization (KVM). It is not available on this machine.'],
    ['restart_error', 'kvm_missing', 'This app needs hardware virtualization (KVM). It is not available on this machine.'],
    ['start_error', 'kata_runtime_missing', "This app needs the Kata container runtime. It isn't set up in Docker on this machine."],
    ['install_error', 'kata_runtime_missing', "This app needs the Kata container runtime. It isn't set up in Docker on this machine."],
    ['restart_error', 'kata_runtime_missing', "This app needs the Kata container runtime. It isn't set up in Docker on this machine."],
  ])('%s with %s says what the machine lacks', (event, errorCode, message) => {
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

    act(() => {
      onEvent?.({ event, appUrn: 'kata-test:_user', errorCode });
    });

    expect(mockToastError).toHaveBeenCalledExactlyOnceWith(message);
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

    // Sonner hands back the new toast's id; the "see logs" link closes the toast by it.
    mockToastError.mockReturnValueOnce('start-error-toast');
    act(() => {
      onEvent?.({ event: 'start_error', appUrn: 'excalidraw:community' });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);

    const toastMessage = mockToastError.mock.calls[0]?.[0] as ReactNode;

    render(<MemoryRouter>{toastMessage}</MemoryRouter>);

    const logsLink = screen.getByRole('link', { name: 'see logs' });

    expect(logsLink).toHaveAttribute('href', '/settings?tab=logs');
    expect(logsLink.parentElement).toHaveTextContent('Failed to start app excalidraw, see logs for more details');

    await userEvent.click(logsLink);

    expect(mockToastDismiss).toHaveBeenCalledWith('start-error-toast');
  });

  it.each([
    ['start_error', 'excalidraw did not start: summary-service keeps restarting (exit 126): permission denied'],
    ['restart_error', 'excalidraw did not restart: summary-service keeps restarting (exit 126): permission denied'],
    ['install_error', 'excalidraw did not install: summary-service keeps restarting (exit 126): permission denied'],
  ])('names the failing service and the reason in the %s toast', (event, text) => {
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

    act(() => {
      onEvent?.({
        event,
        appUrn: 'excalidraw:community',
        serviceFailure: { kind: 'restarting', service: 'summary-service', exitCode: 126, logLine: 'permission denied' },
      });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith(text, { duration: 10000 });
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
    expect(mockToastWarning).toHaveBeenCalledTimes(1);
    expect(mockToastWarning).toHaveBeenCalledWith(expect.stringContaining('could not be fully removed'), expect.anything());
  });

  describe('a success that moved the app off a busy port', () => {
    const movedHostPort = { from: 10000, to: 10001 };

    it.each(['start_success', 'restart_success', 'install_success'])('%s says where the app is now, in place of the success toast', (event) => {
      const getOnEvent = renderProvider();

      act(() => {
        getOnEvent()?.({ event, appUrn: 'excalidraw:community', movedHostPort });
      });

      expect(mockToastSuccess).not.toHaveBeenCalled();
      expect(mockToastWarning).toHaveBeenCalledTimes(1);
      expect(mockToastWarning).toHaveBeenCalledWith(
        'excalidraw is now on port 10001 because another program is using port 10000. Update any bookmarks or clients that use the old port.',
        { duration: 20000 },
      );
    });

    it.each(['start_error', 'restart_error', 'install_error'])('%s still says where the app is now, beside the error', (event) => {
      const getOnEvent = renderProvider();

      act(() => {
        getOnEvent()?.({ event, appUrn: 'excalidraw:community', movedHostPort });
      });

      expect(mockToastError).toHaveBeenCalledTimes(1);
      expect(mockToastWarning).toHaveBeenCalledWith(expect.stringMatching(/^excalidraw is now on port 10001 /), expect.anything());
    });

    it.each([
      ['start_error', 'excalidraw did not start: summary-service keeps restarting (exit 126)'],
      ['restart_error', 'excalidraw did not restart: summary-service keeps restarting (exit 126)'],
      ['install_error', 'excalidraw did not install: summary-service keeps restarting (exit 126)'],
    ])('%s names the failing service and still says where the app is now', (event, text) => {
      const getOnEvent = renderProvider();

      act(() => {
        getOnEvent()?.({
          event,
          appUrn: 'excalidraw:community',
          movedHostPort,
          serviceFailure: { kind: 'restarting', service: 'summary-service', exitCode: 126 },
        });
      });

      expect(mockToastError).toHaveBeenCalledExactlyOnceWith(text, { duration: 10000 });
      expect(mockToastWarning).toHaveBeenCalledWith(expect.stringMatching(/^excalidraw is now on port 10001 /), expect.anything());
    });

    it('host_port_moved says where the app is now, with no outcome of its own to report', () => {
      const getOnEvent = renderProvider();

      act(() => {
        getOnEvent()?.({ event: 'host_port_moved', appUrn: 'excalidraw:community', movedHostPort });
      });

      expect(mockToastSuccess).not.toHaveBeenCalled();
      expect(mockToastError).not.toHaveBeenCalled();
      expect(mockToastWarning).toHaveBeenCalledWith(expect.stringMatching(/^excalidraw is now on port 10001 /), expect.anything());
    });

    it('names the app as its page does', () => {
      const getOnEvent = renderProvider();

      act(() => {
        getOnEvent()?.({ event: 'start_success', appUrn: 'uptime-kuma:ci-marketplace', movedHostPort });
      });

      expect(mockToastWarning).toHaveBeenCalledWith(expect.stringMatching(/^Uptime Kuma is now on port 10001 /), expect.anything());
    });

    it('names an uninstalled app though the event takes its name out of the cache', () => {
      mockHandleAppSseEvent.mockImplementationOnce(() => {
        appNameCache.dropped = true;
      });
      const getOnEvent = renderProvider();

      act(() => {
        getOnEvent()?.({ event: 'uninstall_success', appUrn: 'uptime-kuma:ci-marketplace' });
      });

      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Uptime Kuma/));
    });

    it('warns when an update is in but its settings stayed as they were', () => {
      const getOnEvent = renderProvider();

      act(() => {
        getOnEvent()?.({ event: 'update_success', appUrn: 'uptime-kuma:ci-marketplace', warningCode: 'APP_UPDATE_SETTINGS_NOT_REAPPLIED' });
      });

      expect(mockToastSuccess).not.toHaveBeenCalled();
      expect(mockToastWarning).toHaveBeenCalledWith(expect.stringMatching(/^Uptime Kuma updated, but its saved settings/), expect.anything());
    });

    it('names the app the same way in a failed install and its port notice', () => {
      const getOnEvent = renderProvider();

      act(() => {
        getOnEvent()?.({
          event: 'install_error',
          appUrn: 'uptime-kuma:ci-marketplace',
          serviceFailure: { kind: 'exited', service: 'uptime-kuma', exitCode: 137 },
          movedHostPort,
        });
      });

      expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/^Uptime Kuma /), expect.anything());
      expect(mockToastWarning).toHaveBeenCalledWith(expect.stringMatching(/^Uptime Kuma is now on port 10001 /), expect.anything());
    });

    it.each([
      ['start_success', 'App excalidraw started successfully'],
      ['restart_success', 'App excalidraw restarted successfully'],
      ['install_success', 'App excalidraw installed successfully'],
    ])('%s with no move stays the plain success toast', (event, text) => {
      const getOnEvent = renderProvider();

      act(() => {
        getOnEvent()?.({ event, appUrn: 'excalidraw:community' });
      });

      expect(mockToastWarning).not.toHaveBeenCalled();
      expect(mockToastSuccess).toHaveBeenCalledWith(text);
    });
  });

  it('shows the plain success toast when uninstall_success has no warningCode', () => {
    const getOnEvent = renderProvider();

    act(() => {
      getOnEvent()?.({ event: 'uninstall_success', appUrn: 'excalidraw:community' });
    });

    expect(mockToastWarning).not.toHaveBeenCalled();
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
    expect(mockToastWarning).toHaveBeenCalledTimes(1);
    const [message] = mockToastWarning.mock.calls[0] as [ReactNode];

    // The toast body must render the exact host path in a runnable, shell-safe command
    // (single-quoted + `--` so a path with spaces/metacharacters can't misfire on paste).
    render(<MemoryRouter>{message}</MemoryRouter>);
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

  describe('public_domain_changed', () => {
    it('says where the app is published now, as a warning rather than an error', () => {
      const getOnEvent = renderProvider();

      act(() => {
        getOnEvent()?.({ event: 'public_domain_changed', appUrn: 'n8n:ci-marketplace', hostname: 'n8n-core-2-acme.ci.computer' });
      });

      expect(mockToastError).not.toHaveBeenCalled();
      expect(mockToastWarning).toHaveBeenCalledTimes(1);
      expect(mockToastWarning.mock.calls[0]?.[0]).toBe(
        "n8n is now published at n8n-core-2-acme.ci.computer. The domain it used isn't available for this device, so its old address never worked. n8n restarts to use the new one.",
      );
    });

    it('shows nothing when the event names no hostname', () => {
      const getOnEvent = renderProvider();

      act(() => {
        getOnEvent()?.({ event: 'public_domain_changed', appUrn: 'n8n:ci-marketplace' });
      });

      expect(mockToastWarning).not.toHaveBeenCalled();
      expect(mockToastError).not.toHaveBeenCalled();
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

    // What a restart changed was announced while no browser was connected (#2286).
    it('refetches every app record when the Hub greets again after a restart, not on its first greeting', () => {
      const { fire } = mountWithHandler();
      fire({ event: 'hub_hello', version: '0.2.72' });
      expect(mockInvalidateAppRecords).not.toHaveBeenCalled();

      fire({ event: 'hub_hello', version: '0.2.72' });

      expect(mockInvalidateAppRecords).toHaveBeenCalledTimes(1);
    });

    it('is inert when nothing is pending', () => {
      const { fire, invalidate } = mountWithHandler();
      fire({ event: 'hub_hello', version: '0.2.72' });
      expect(invalidate).not.toHaveBeenCalled();
      expect(mockHandleAppSseEvent).not.toHaveBeenCalled();
    });
  });
});

describe('SSEProvider: a cancelled install of a custom app', () => {
  // biome-ignore lint/correctness/noComponentHookFactories: this one-shot test fixture is created once per suite.
  const Where = () => <span data-testid="where">{useLocation().pathname}</span>;

  const renderOnAppPage = () => {
    let onEvent: ((data: unknown) => void) | undefined;
    mockUseSSE.mockImplementation((config: { onEvent: (data: unknown) => void }) => {
      onEvent = config.onEvent;
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/apps/my-tool']}>
          <SSEProvider>
            <Where />
          </SSEProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return (data: unknown) => act(() => onEvent?.(data));
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves the app page when the app is gone', () => {
    const send = renderOnAppPage();

    send({ event: 'install_cancelled', appUrn: 'my-tool:_user', appStatus: 'missing' });

    expect(screen.getByTestId('where')).toHaveTextContent('/store');
  });

  it('names the app as its page does when its update was cancelled, not by its id', () => {
    const send = renderOnAppPage();

    send({ event: 'update_cancelled', appUrn: 'uptime-kuma:ci-marketplace', appStatus: 'running' });

    expect(mockToastSuccess).toHaveBeenCalledWith("Update of Uptime Kuma cancelled. It's back on its previous version.");
  });

  // A retry of a failed install that is cancelled before it is queued stays install_failed.
  it('stays on the app page when the app is still there, failed', () => {
    const send = renderOnAppPage();

    send({ event: 'install_cancelled', appUrn: 'my-tool:_user', appStatus: 'install_failed' });

    expect(screen.getByTestId('where')).toHaveTextContent('/apps/my-tool');
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
  });
});
