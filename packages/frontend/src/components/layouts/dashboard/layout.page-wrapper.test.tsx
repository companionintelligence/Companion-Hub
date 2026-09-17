import { render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { DashboardLayout } from '@/components/layouts/dashboard/layout';

const { appContext } = vi.hoisted(() => ({
  appContext: {
    user: { hasCompletedOnboarding: true },
    userSettings: { ciHubDeviceSlug: 'hub-device', allowAutoThemes: false },
    isLoading: false,
    loadFailed: false,
  },
}));

vi.mock('@/lib/mobile-connection', () => ({
  isMobileClient: () => false,
  isTauriMobileSync: () => false,
  getHubBaseUrlSync: () => null,
  needsRemoteHubConnect: () => false,
  clearHubConnection: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));
vi.mock('@/context/user-context', () => ({ useUserContext: () => ({ isLoggedIn: true }) }));
vi.mock('@/context/app-context', () => ({ useAppContext: () => appContext }));
vi.mock('@/lib/hooks/use-registration-status', () => ({ useRegistrationStatus: () => ({ data: null }) }));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  logoutMutation: () => ({ mutationFn: vi.fn() }),
  systemLoadOptions: () => ({ queryKey: ['system-load'], queryFn: async () => null }),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useMutation: () => ({ mutate: vi.fn() }),
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/components/mode-toggle', () => ({ ModeToggle: () => null }));

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <DashboardLayout>
              <h1>Page</h1>
            </DashboardLayout>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DashboardLayout page wrapper', () => {
  it('fits the page to the height of <main> so pages scroll in their own panes', () => {
    renderAt('/settings');

    // With `flex-1` alone the wrapper grows to fit the page: the store pane and
    // the Settings pane stop scrolling, and <main> scrolls the whole page,
    // store sidebar included.
    expect(screen.getByRole('heading', { name: 'Page' }).parentElement).toHaveClass('flex-1', 'min-h-0');
  });

  it('keys the wrapper by page, sharing one key across the store routes', () => {
    renderAt('/store/ci-marketplace/immich');

    expect(screen.getByRole('heading', { name: 'Page' }).parentElement).toHaveAttribute('data-page-key', '/store');
  });
});

describe('DashboardLayout <main>', () => {
  it('shows its scrollbar and starts below the fixed header, so nothing covers the scrollbar', () => {
    renderAt('/apps/ci-marketplace/immich');

    // Pages without their own pane (app details under /apps, Resource Monitor)
    // scroll <main>. With the header offset as padding, the header sat over the
    // top of the scrollbar and hid the thumb at the top of the page.
    const main = screen.getByRole('main');
    expect(main).not.toHaveClass('no-scrollbar');
    expect(main).toHaveStyle({ marginTop: 'var(--header-offset)' });
  });
});
