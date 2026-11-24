import { render, screen, userEvent, within } from '@/tests/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestDashboard } from './guest-dashboard';

const { refreshUserContext, answers } = vi.hoisted(() => ({
  refreshUserContext: vi.fn(),
  answers: { apps: (): Promise<unknown> => Promise.reject(new Error('403')), links: (): Promise<unknown> => Promise.reject(new Error('403')) },
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getGuestAppsOptions: () => ({ queryKey: ['guest-apps'], queryFn: () => answers.apps() }),
  getGuestLinksOptions: () => ({ queryKey: ['guest-links'], queryFn: () => answers.links() }),
}));

const guestApp = (id: number, name: string, urn: string, shortDesc: string) => ({
  app: { id, status: 'running', exposedLocal: false, exposureMode: 'local', localSubdomain: null, publicUrl: null, port: null },
  info: { id: urn.split(':')[0], urn, name, short_desc: shortDesc, port: 8080 },
});

const renderDashboard = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GuestDashboard />
    </QueryClientProvider>,
  );
};
vi.mock('@/context/user-context', () => ({ useUserContext: () => ({ sslPort: 443, refreshUserContext }) }));
vi.mock('@/components/header/header', () => ({ Header: () => null }));

describe('GuestDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    answers.apps = () => Promise.reject(new Error('403'));
    answers.links = () => Promise.reject(new Error('403'));
  });

  it('asks again whether the dashboard is on when a visitor retries a refused load', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <GuestDashboard />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(refreshUserContext).toHaveBeenCalledTimes(1);
  });

  // Laid out like Home. The links were a different card, larger and out of line with the apps.
  it('shows the apps and links as the same tiles in one card under a title', async () => {
    answers.apps = () =>
      Promise.resolve({
        installed: [
          guestApp(1, 'Immich', 'immich:ci-marketplace', 'Self-hosted photo and video management solution'),
          guestApp(2, 'Family Photos', 'family-photos:_user', 'User-created custom app'),
        ],
      });
    answers.links = () => Promise.resolve({ links: [{ id: 1, title: 'Family wiki', url: 'https://wiki.example.com', description: 'House notes' }] });

    renderDashboard();

    expect(await screen.findByText('Immich')).toBeInTheDocument();
    const card = screen.getByTestId('guest-dashboard-apps');
    expect(within(card).getByText('Immich')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Apps on this Hub' })).toBeInTheDocument();
    expect(within(card).getByText('Self-hosted photo and video management solution')).toBeInTheDocument();
    expect(within(card).getByText('Family Photos')).toBeInTheDocument();
    // The description the Hub writes for every custom app says nothing to a guest.
    expect(within(card).queryByText('User-created custom app')).not.toBeInTheDocument();
    const link = within(card).getByTestId('guest-link-tile-Family wiki');
    expect(within(link).getByText('House notes')).toBeInTheDocument();
    // A link without an icon shows its first letter, not the ":/" placeholder.
    expect(within(link).getByTestId('app-logo-monogram')).toHaveTextContent('F');
  });

  it('shows no tile until both lists have arrived', async () => {
    let releaseApps: (value: unknown) => void = () => {};
    answers.apps = () => new Promise((resolve) => (releaseApps = resolve));
    answers.links = () => Promise.resolve({ links: [{ id: 1, title: 'Family wiki', url: 'https://wiki.example.com', description: '' }] });

    renderDashboard();

    expect((await screen.findAllByTestId('app-tile-skeleton')).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('guest-link-tile-Family wiki')).not.toBeInTheDocument();

    releaseApps({ installed: [] });

    expect(await screen.findByTestId('guest-link-tile-Family wiki')).toBeInTheDocument();
    expect(screen.queryByTestId('app-tile-skeleton')).not.toBeInTheDocument();
  });
});
