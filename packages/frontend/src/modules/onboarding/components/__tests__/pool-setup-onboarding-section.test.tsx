import type { TailscaleSetupStatus } from '@/modules/settings/components/pool-setup-wizard/pool-setup-model';
import { tailscaleStatus } from '@/tests/pool-fixtures';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PoolSetupOnboardingSection } from '../pool-setup-onboarding-section';

const fixtures = vi.hoisted(() => ({ ts: null as unknown as TailscaleSetupStatus, tsReads: 0 }));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getStatus3QueryKey: () => ['tailscale-status'],
  getStatus3Options: () => ({
    queryKey: ['tailscale-status'],
    queryFn: async () => {
      fixtures.tsReads += 1;
      return fixtures.ts;
    },
  }),
}));
vi.mock('@/modules/settings/components/pool-setup-wizard/lazy-pool-setup-wizard', () => ({
  LazyPoolSetupWizard: ({ open }: { open: boolean }) => (open ? <div data-testid="wizard-stub" /> : null),
}));

const renderSection = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <PoolSetupOnboardingSection />
    </QueryClientProvider>,
  );
  return { ...view, client };
};

const section = () => screen.queryByTestId('pool-setup-onboarding');

beforeEach(() => {
  fixtures.ts = tailscaleStatus();
  fixtures.tsReads = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PoolSetupOnboardingSection', () => {
  it.each([
    ['Tailscale is not installed', { installed: false, connected: false }],
    ['Tailscale is installed but not connected', { connected: false }],
  ])('renders nothing when %s', async (_name, overrides) => {
    fixtures.ts = tailscaleStatus(overrides);
    renderSection();

    await waitFor(() => expect(fixtures.tsReads).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(section()).not.toBeInTheDocument();
  });

  it('shows the optional section with the Optional badge once Tailscale is connected', async () => {
    renderSection();

    const found = await screen.findByTestId('pool-setup-onboarding');

    expect(found).toHaveAccessibleName('Pool with your other Hubs');
    expect(found).toHaveTextContent('Optional');
    expect(found).toHaveTextContent('Tailscale is connected. Pool your other Hubs now, or later from Home.');
  });

  it('the button opens the guide, and the guide stays mounted if Tailscale then reports disconnected', async () => {
    const user = userEvent.setup();
    const { client } = renderSection();
    await user.click(await screen.findByRole('button', { name: 'Set up Hub Pool' }));
    expect(screen.getByTestId('wizard-stub')).toBeInTheDocument();

    fixtures.ts = tailscaleStatus({ connected: false });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['tailscale-status'] });
    });

    await waitFor(() => expect(section()).not.toBeInTheDocument());
    expect(screen.getByTestId('wizard-stub')).toBeInTheDocument();
  });

  it('appears by itself when Tailscale connects while the page is open, within the 3 s registration poll', async () => {
    vi.useFakeTimers();
    fixtures.ts = tailscaleStatus({ connected: false });
    renderSection();
    const flush = async () => {
      for (const ms of [0, 0, 1]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      }
    };
    await flush();
    expect(section()).not.toBeInTheDocument();

    fixtures.ts = tailscaleStatus();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await flush();

    expect(section()).toBeInTheDocument();
  });
});
