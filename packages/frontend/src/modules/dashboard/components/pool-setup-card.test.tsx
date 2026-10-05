import { incomingPeer, poolPeer, poolStatus, poolWith, waitingPeer } from '@/tests/pool-fixtures';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolStatus } from '@/modules/settings/helpers/hub-pool-shared';
import { POOL_SETUP_DISMISSED_KEY } from '../helpers/pool-setup-dismissal';
import { PoolSetupCard } from './pool-setup-card';

const fixtures = vi.hoisted(() => ({
  pool: null as unknown as PoolStatus,
  poolFails: false,
  poolReads: 0,
  registered: true,
  demo: false,
}));

vi.mock('@/lib/hooks/use-demo-mode', () => ({ useDemoMode: () => fixtures.demo }));
vi.mock('@/lib/hooks/use-registration-status', () => ({
  useRegistrationStatus: () => ({ data: { registered: fixtures.registered } }),
}));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  poolStatusQueryKey: () => ['pool-status'],
  poolStatusOptions: () => ({
    queryKey: ['pool-status'],
    queryFn: async () => {
      fixtures.poolReads += 1;
      if (fixtures.poolFails) throw new Error('pool status unreachable');
      return fixtures.pool;
    },
  }),
}));
// The guide has its own suite; here it only needs to be observable as open or closed.
vi.mock('@/modules/settings/components/pool-setup-wizard/lazy-pool-setup-wizard', () => ({
  LazyPoolSetupWizard: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <div data-testid="wizard-stub">
        <button type="button" onClick={() => onOpenChange(false)}>
          close-wizard
        </button>
      </div>
    ) : null,
}));

const renderCard = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <PoolSetupCard />
    </QueryClientProvider>,
  );
  return { ...view, client };
};

const invite = () => screen.queryByTestId('pool-setup-card');
const review = () => screen.queryByTestId('pool-setup-review-card');

beforeEach(() => {
  localStorage.clear();
  fixtures.pool = poolStatus();
  fixtures.poolFails = false;
  fixtures.poolReads = 0;
  fixtures.registered = true;
  fixtures.demo = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PoolSetupCard', () => {
  // First on purpose. The in-memory fallback is module state that outlives a test, and it is only read when
  // storage throws. A test that dismissed earlier would leave it set and this one would find the card
  // already dismissed. Every test after this one reads a working store, which ignores the fallback.
  describe('when storage is unavailable', () => {
    it('still renders, dismisses for the session through the in-memory fallback, and throws nothing', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
      renderCard();
      await screen.findByTestId('pool-setup-card');

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss the Hub Pool suggestion' }));

      expect(invite()).not.toBeInTheDocument();
    });
  });

  it('renders nothing while pool status is pending', () => {
    fixtures.pool = poolStatus();
    renderCard();

    expect(invite()).not.toBeInTheDocument();
    expect(review()).not.toBeInTheDocument();
  });

  it('renders nothing, and raises no error, when pool status has failed', async () => {
    fixtures.poolFails = true;
    renderCard();

    await waitFor(() => expect(fixtures.poolReads).toBeGreaterThan(0));

    expect(invite()).not.toBeInTheDocument();
    expect(review()).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the invite only when registered, pooling enabled, Tailscale connected, zero peers, and not dismissed', async () => {
    renderCard();

    expect(await screen.findByRole('heading', { name: 'Pool your Hubs' })).toBeInTheDocument();
    expect(screen.getByText('Tailscale is connected. Pair your other Hubs so apps here can use their models.')).toBeInTheDocument();
    expect(screen.getByText('You can find this later in Settings → Network → Hub Pool.')).toBeInTheDocument();
  });

  it.each([
    ['the Hub is not registered', () => (fixtures.registered = false)],
    ['pooling is off', () => (fixtures.pool = poolStatus({ enabled: false, disabledBy: 'setting' }))],
    ['Tailscale is not connected', () => (fixtures.pool = poolStatus({ localNode: { ...poolStatus().localNode, tailscaleConnected: false } }))],
    ['a connected peer exists', () => (fixtures.pool = poolWith([poolPeer()]))],
    ['a request this Hub sent is waiting', () => (fixtures.pool = poolWith([waitingPeer()]))],
    ['the Hub is in demo mode', () => (fixtures.demo = true)],
  ])('hides the invite when %s', async (_name, arrange) => {
    arrange();
    renderCard();

    // Long enough for the status read to land, so the absence below is not just "not loaded yet".
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(invite()).not.toBeInTheDocument();
  });

  it('does not read pool status at all in demo mode', async () => {
    fixtures.demo = true;
    renderCard();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(fixtures.poolReads).toBe(0);
  });

  it('Dismiss hides the card, writes ci-hub.pool-setup-dismissed, and it stays hidden after a remount', async () => {
    const user = userEvent.setup();
    const first = renderCard();
    await screen.findByTestId('pool-setup-card');

    await user.click(screen.getByRole('button', { name: 'Dismiss the Hub Pool suggestion' }));

    expect(invite()).not.toBeInTheDocument();
    expect(localStorage.getItem(POOL_SETUP_DISMISSED_KEY)).toBe('1');
    first.unmount();

    renderCard();
    await waitFor(() => expect(fixtures.poolReads).toBeGreaterThan(1));
    expect(invite()).not.toBeInTheDocument();
  });

  it('Set up Hub Pool opens the guide', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Set up Hub Pool' }));

    expect(screen.getByTestId('wizard-stub')).toBeInTheDocument();
  });

  it('Set up Hub Pool and Dismiss are buttons with accessible names', async () => {
    renderCard();
    const card = await screen.findByRole('region', { name: 'Pool your Hubs' });

    expect(within(card).getByRole('button', { name: 'Set up Hub Pool' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Dismiss the Hub Pool suggestion' })).toBeInTheDocument();
  });

  describe('review mode', () => {
    it('shows the count and the first three requesters by tailnet name, and its button opens the guide', async () => {
      fixtures.pool = poolWith(
        ['a', 'b', 'c', 'd'].map((letter) =>
          incomingPeer({ id: `in-${letter}`, nodeFqdn: `hub-${letter}.example-tailnet.ts.net`, displayName: `Friendly name ${letter}` }),
        ),
      );
      const user = userEvent.setup();
      renderCard();

      const card = await screen.findByTestId('pool-setup-review-card');

      expect(within(card).getByRole('heading', { name: '4 Hubs want to join your pool' })).toBeInTheDocument();
      expect(card).toHaveAttribute('role', 'status');
      expect(
        within(card).getByText('From hub-a.example-tailnet.ts.net, hub-b.example-tailnet.ts.net, hub-c.example-tailnet.ts.net'),
      ).toBeInTheDocument();
      expect(within(card).queryByText(/Friendly name/)).not.toBeInTheDocument();
      expect(invite()).not.toBeInTheDocument();

      await user.click(within(card).getByRole('button', { name: 'Review requests' }));

      expect(screen.getByTestId('wizard-stub')).toBeInTheDocument();
    });

    it('uses the singular for one request', async () => {
      fixtures.pool = poolWith([incomingPeer()]);
      renderCard();

      const card = await screen.findByTestId('pool-setup-review-card');

      expect(within(card).getByRole('heading', { name: '1 Hub wants to join your pool' })).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: 'Review request' })).toBeInTheDocument();
    });

    it('ignores a stored dismissal and an unregistered Hub, because a request needs a decision', async () => {
      localStorage.setItem(POOL_SETUP_DISMISSED_KEY, '1');
      fixtures.registered = false;
      fixtures.pool = poolWith([poolPeer(), incomingPeer()]);
      renderCard();

      expect(await screen.findByTestId('pool-setup-review-card')).toBeInTheDocument();
    });

    it('is not shown in demo mode', async () => {
      fixtures.demo = true;
      fixtures.pool = poolWith([incomingPeer()]);
      renderCard();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(review()).not.toBeInTheDocument();
    });
  });

  it('keeps the guide mounted when the invitation disappears mid-flow because a peer now exists', async () => {
    const user = userEvent.setup();
    const { client } = renderCard();
    await user.click(await screen.findByRole('button', { name: 'Set up Hub Pool' }));
    expect(screen.getByTestId('wizard-stub')).toBeInTheDocument();

    // The guide's first request is what makes `peerCounts.total` 1 and retires the invite.
    fixtures.pool = poolWith([waitingPeer()]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['pool-status'] });
    });

    await waitFor(() => expect(invite()).not.toBeInTheDocument());
    expect(screen.getByTestId('wizard-stub')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'close-wizard' }));
    expect(screen.queryByTestId('wizard-stub')).not.toBeInTheDocument();
  });

  it('refetches pool status every 30 s and not faster', async () => {
    vi.useFakeTimers();
    renderCard();
    const flush = async () => {
      for (const ms of [0, 0, 1]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      }
    };
    await flush();
    expect(fixtures.poolReads).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(fixtures.poolReads).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flush();
    expect(fixtures.poolReads).toBe(2);
  });
});
