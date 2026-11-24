import { render, screen, userEvent } from '@/tests/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { openExternal } from '@/lib/helpers/open-external';
import { TailscaleSetupStep } from '../tailscale-setup-step';

type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> } };

const mockUseQuery = vi.fn();
// The component makes exactly one useMutation() call (browserAuthMutation), so
// capturing every config passed in and reading the last one gets us the real
// onSuccess/onError closures to exercise directly -- there is no live
// QueryClient here to drive a real mutation lifecycle through.
const mutationConfigs: Array<{ onSuccess?: (payload: unknown) => unknown; onError?: () => void }> = [];
const translations = {
  COMMON_BACK: 'Back',
  COMMON_CONTINUE: 'Continue',
  ONBOARDING_TAILSCALE_SKIP_TO_DISCOVER: 'Skip to Discover',
  ONBOARDING_TAILSCALE_CONTINUE_TO_DISCOVER: 'Continue to Discover',
} as const;

vi.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (config: { onSuccess?: (payload: unknown) => unknown; onError?: () => void }) => {
    mutationConfigs.push(config);
    return {
      mutate: vi.fn(),
      isPending: false,
    };
  },
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getStatus3Options: () => ({ queryKey: ['tailscale-status'], queryFn: vi.fn() }),
  getStatus3QueryKey: () => ['tailscale-status'],
}));

vi.mock('@/lib/hooks/use-tailscale-readiness-sync', () => ({
  useTailscaleReadinessSync: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/lib/helpers/open-external', () => ({
  openExternal: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key as keyof typeof translations] ?? key,
  }),
}));

function renderStep(connected: boolean) {
  mockUseQuery.mockReturnValue({
    data: {
      installed: true,
      connected,
      ip: connected ? '100.64.0.1' : null,
      hostname: connected ? 'ci-hub' : null,
      backendState: connected ? 'Running' : 'Stopped',
    },
    isLoading: false,
    isError: false,
  });

  const onComplete = vi.fn();
  const onSkip = vi.fn();
  const onBack = vi.fn();

  render(<TailscaleSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);

  return { onComplete, onSkip, onBack };
}

describe('TailscaleSetupStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationConfigs.length = 0;
  });

  describe('when the Hub has no Tailscale', () => {
    const renderMissing = () => {
      mockUseQuery.mockReturnValue({ data: { installed: false, connected: false }, isLoading: false, isError: false });
      render(<TailscaleSetupStep onComplete={vi.fn()} onSkip={vi.fn()} onBack={vi.fn()} />);
    };

    afterEach(() => {
      delete (window as TauriWindow).__TAURI_INTERNALS__;
    });

    it('says to install it on a normal machine', () => {
      renderMissing();

      expect(screen.getByText('ONBOARDING_TAILSCALE_NOT_AVAILABLE')).toBeInTheDocument();
      expect(screen.queryByTestId('tailscale-live-session')).not.toBeInTheDocument();
    });

    it('says a live session cannot run it, instead of sending someone to install it', async () => {
      (window as TauriWindow).__TAURI_INTERNALS__ = {
        invoke: vi.fn().mockResolvedValue({ live: true, ollamaBlocked: true, tailscaleBlocked: true }),
      };

      renderMissing();

      expect(await screen.findByTestId('tailscale-live-session')).toHaveTextContent('SETTINGS_NETWORK_TAILSCALE_LIVE_SESSION');
      expect(screen.queryByText('ONBOARDING_TAILSCALE_NOT_AVAILABLE')).not.toBeInTheDocument();
      expect(screen.queryByText('ONBOARDING_TAILSCALE_INSTALL_THEN_CONNECT')).not.toBeInTheDocument();
    });
  });

  it('shows only Skip when Tailscale is not connected', () => {
    renderStep(false);

    expect(screen.getByRole('button', { name: 'Skip to Discover' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue to Discover' })).not.toBeInTheDocument();
  });

  it('shows only Continue when Tailscale is connected and completes onboarding', async () => {
    const { onComplete } = renderStep(true);

    expect(screen.getByRole('button', { name: 'Continue to Discover' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip to Discover' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Continue to Discover' }));

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('shows the opening toast only when the system opener actually reports success', async () => {
    vi.mocked(openExternal).mockResolvedValue(true);
    renderStep(false);
    const { onSuccess } = mutationConfigs[mutationConfigs.length - 1] ?? {};

    await onSuccess?.({ success: true, authUrl: 'https://login.tailscale.com/a/abc123' });

    expect(openExternal).toHaveBeenCalledWith('https://login.tailscale.com/a/abc123');
    expect(toast.success).toHaveBeenCalledWith('ONBOARDING_TAILSCALE_AUTH_OPENING');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows an error, not a false success toast, when the system opener silently fails', async () => {
    // Regression test: openExternal never throws on a failed open (an ACL denial,
    // a scope rejection, a stale opener-plugin chunk) -- it logs and resolves
    // false. Before this was awaited, the button showed "Opening..." regardless.
    vi.mocked(openExternal).mockResolvedValue(false);
    renderStep(false);
    const { onSuccess } = mutationConfigs[mutationConfigs.length - 1] ?? {};

    await onSuccess?.({ success: true, authUrl: 'https://login.tailscale.com/a/abc123' });

    expect(toast.error).toHaveBeenCalledWith('ONBOARDING_TAILSCALE_AUTH_FAILED');
    expect(toast.success).not.toHaveBeenCalled();
  });
});
