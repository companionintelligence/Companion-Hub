import { render, screen, userEvent } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { Header } from '@/components/header/header';
import { DashboardLayout } from '@/components/layouts/dashboard/layout';
import { SimpleAppTile } from '@/modules/dashboard/components/simple-app-tile';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/Dialog';
import { ThemeProvider } from '@/components/providers/theme/theme-provider';
import { isBodyScrollLocked, isBodyThemeLocked, pageHasVisibleChrome, shouldSkipIosPageSlide } from '@/lib/ios-webview-guards';

const { isMobileClient } = vi.hoisted(() => ({
  isMobileClient: vi.fn(() => true),
}));

vi.mock('@/lib/mobile-connection', () => ({
  isMobileClient,
  isTauriMobileSync: () => true,
  getHubBaseUrlSync: () => 'https://hub.example.com',
  needsRemoteHubConnect: () => false,
  clearHubConnection: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@/context/user-context', () => ({
  useUserContext: () => ({ isLoggedIn: true }),
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({
    user: { hasCompletedOnboarding: true },
    userSettings: { ciHubDeviceSlug: 'hub-device', allowAutoThemes: false },
  }),
}));

vi.mock('@/lib/hooks/use-registration-status', () => ({
  useRegistrationStatus: () => ({ data: null }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  logoutMutation: () => ({ mutationFn: vi.fn() }),
  systemLoadOptions: () => ({ queryKey: ['system-load'], queryFn: async () => null }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useMutation: () => ({ mutate: vi.fn() }),
    useQuery: () => ({ data: undefined }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock('@/components/mode-toggle', () => ({
  ModeToggle: () => <div data-testid="mode-toggle">ModeToggle</div>,
}));

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('iOS navigation smoke', () => {
  beforeEach(() => {
    isMobileClient.mockReturnValue(true);
    document.documentElement.classList.remove('light', 'dark');
    document.body.removeAttribute('style');
    document.body.style.pointerEvents = '';
  });

  it('skips page-slide transitions on a phone', () => {
    expect(shouldSkipIosPageSlide()).toBe(true);
    isMobileClient.mockReturnValue(false);
    expect(shouldSkipIosPageSlide()).toBe(false);
  });

  it('keeps dashboard routes in place instead of sliding them off-screen', () => {
    render(
      <MemoryRouter initialEntries={['/apps/community/notes']}>
        <DashboardLayout>
          <h1>App details</h1>
        </DashboardLayout>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('dashboard-page')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'App details' })).toBeInTheDocument();
    expect(document.querySelector('[style*="translate"]')).toBeNull();
    expect(pageHasVisibleChrome()).toBe(true);
    expect(isBodyScrollLocked()).toBe(false);
  });

  it('lets theme tokens color the page — body is never pinned to light-mode ink', async () => {
    render(
      <ThemeProvider defaultTheme="light" storageKey="ios-smoke-theme">
        <MemoryRouter>
          <Header isLoggedIn />
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(isBodyThemeLocked()).toBe(false);
    expect(screen.getByTestId('mobile-app-menu-btn')).toHaveClass('text-foreground');

    await userEvent.click(screen.getByTestId('mobile-app-menu-btn'));
    await userEvent.click(screen.getByRole('menuitem', { name: /THEME_DARK|Dark/i }));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(isBodyThemeLocked()).toBe(false);
    expect(isBodyScrollLocked()).toBe(false);
    expect(screen.getByTestId('mobile-app-menu-btn')).toBeVisible();
  });

  it('does not lock body when a Radix dropdown opens', async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>More</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Network</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await userEvent.click(screen.getByText('More'));
    expect(screen.getByRole('menuitem', { name: 'Network' })).toBeInTheDocument();
    expect(isBodyScrollLocked()).toBe(false);
  });

  it('does not lock body when a dialog is open', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Confirm</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(isBodyScrollLocked()).toBe(false);
  });

  it('colors installed-app titles with the theme foreground token', () => {
    render(<SimpleAppTile name="Notes" urn="notes:community" status="running" />);
    expect(screen.getByText('Notes')).toHaveClass('text-foreground');
  });

  it('walks Home → app details without a blank main', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Routes>
          <Route
            path="/home"
            element={
              <DashboardLayout>
                <a href="/apps/community/notes">Notes</a>
              </DashboardLayout>
            }
          />
          <Route
            path="/apps/:storeId/:appId"
            element={
              <DashboardLayout>
                <h1>Notes details</h1>
              </DashboardLayout>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('dashboard-page')).toBeVisible();
    expect(isBodyScrollLocked()).toBe(false);
  });
});
