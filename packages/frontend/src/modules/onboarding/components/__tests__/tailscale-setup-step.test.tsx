import { render, screen, userEvent } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TailscaleSetupStep } from '../tailscale-setup-step';

const mockUseQuery = vi.fn();
const translations = {
  COMMON_BACK: 'Back',
  COMMON_CONTINUE: 'Continue',
  ONBOARDING_TAILSCALE_SKIP: 'Skip',
  ONBOARDING_TAILSCALE_SKIP_TO_DISCOVER: 'Skip to Discover',
  ONBOARDING_TAILSCALE_CONTINUE_TO_DISCOVER: 'Continue to Discover',
} as const;

vi.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock('react-hot-toast', () => ({
  default: {
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
});
