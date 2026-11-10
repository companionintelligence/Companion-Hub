import { render, screen, userEvent } from '@/tests/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestDashboard } from './guest-dashboard';

const { refreshUserContext } = vi.hoisted(() => ({ refreshUserContext: vi.fn() }));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getGuestAppsOptions: () => ({ queryKey: ['guest-apps'], queryFn: () => Promise.reject(new Error('403')) }),
  getGuestLinksOptions: () => ({ queryKey: ['guest-links'], queryFn: () => Promise.reject(new Error('403')) }),
}));
vi.mock('@/context/user-context', () => ({ useUserContext: () => ({ sslPort: 443, refreshUserContext }) }));
vi.mock('@/components/header/header', () => ({ Header: () => null }));

describe('GuestDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
