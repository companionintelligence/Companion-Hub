import { render, screen } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { DashboardLayout } from '@/components/layouts/dashboard/layout';

const { appContext } = vi.hoisted(() => ({
  appContext: {
    user: { hasCompletedOnboarding: false } as { hasCompletedOnboarding: boolean },
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
          path="/resource-monitor"
          element={
            <DashboardLayout>
              <h1>Resource monitor</h1>
            </DashboardLayout>
          }
        />
        <Route path="/onboarding" element={<h1>Onboarding wizard</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DashboardLayout onboarding gate', () => {
  beforeEach(() => {
    appContext.user = { hasCompletedOnboarding: false };
    appContext.isLoading = false;
    appContext.loadFailed = false;
  });

  it('keeps a deep link in place while app-context is still loading (the default payload says "not onboarded")', () => {
    appContext.isLoading = true;
    renderAt('/resource-monitor');

    expect(screen.getByRole('heading', { name: 'Resource monitor' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Onboarding wizard' })).not.toBeInTheDocument();
  });

  it('keeps the requested page when app-context failed to load', () => {
    appContext.loadFailed = true;
    renderAt('/resource-monitor');

    expect(screen.getByRole('heading', { name: 'Resource monitor' })).toBeInTheDocument();
  });

  it('still sends a genuinely un-onboarded operator to the wizard once the payload is in', () => {
    renderAt('/resource-monitor');

    expect(screen.getByRole('heading', { name: 'Onboarding wizard' })).toBeInTheDocument();
  });

  it('renders normally for an onboarded operator', () => {
    appContext.user = { hasCompletedOnboarding: true };
    renderAt('/resource-monitor');

    expect(screen.getByRole('heading', { name: 'Resource monitor' })).toBeInTheDocument();
  });
});
