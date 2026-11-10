import { render, screen, userEvent } from '@/tests/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { DashboardLayout } from '@/components/layouts/dashboard/layout';

const { isMobileClient } = vi.hoisted(() => ({ isMobileClient: vi.fn(() => true) }));

vi.mock('@/lib/mobile-connection', () => ({
  isMobileClient,
  isTauriMobileSync: () => false,
  getHubBaseUrlSync: () => null,
  needsRemoteHubConnect: () => false,
  clearHubConnection: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));
vi.mock('@/context/user-context', () => ({ useUserContext: () => ({ isLoggedIn: true }) }));
vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({
    user: { hasCompletedOnboarding: true },
    userSettings: { ciHubDeviceSlug: 'hub-device' },
    isLoading: false,
    loadFailed: false,
  }),
}));
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

// jsdom does no layout: scrollTop is always 0 and Element.scrollTo does not exist.
// Model both so the test can scroll the store and read where it ends up.
const offsets = new WeakMap<Element, number>();
const nativeScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');

function renderStore() {
  return render(
    <MemoryRouter initialEntries={['/store']}>
      <Routes>
        <Route
          path="*"
          element={
            <DashboardLayout>
              <div data-page-scroller="store" data-testid="store-pane" />
            </DashboardLayout>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function scrollStoreDown() {
  const main = screen.getByRole('main');
  const pane = screen.getByTestId('store-pane');
  main.scrollTop = 400;
  pane.scrollTop = 400;
  return { main, pane };
}

describe('DashboardLayout tap to top (#1879)', () => {
  beforeEach(() => {
    isMobileClient.mockReturnValue(true);
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return offsets.get(this) ?? 0;
      },
      set(this: Element, value: number) {
        offsets.set(this, value);
      },
    });
    Element.prototype.scrollTo = function scrollTo(this: Element, options?: ScrollToOptions | number) {
      if (typeof options === 'object' && options.top !== undefined) this.scrollTop = options.top;
    } as Element['scrollTo'];
  });

  afterEach(() => {
    if (nativeScrollTop) Object.defineProperty(Element.prototype, 'scrollTop', nativeScrollTop);
    // Restore jsdom's prototype, which has no scrollTo.
    delete (Element.prototype as Partial<Element>).scrollTo;
  });

  it('brings the store pane back to the top when the header band is tapped on the mobile app', async () => {
    renderStore();
    const { main, pane } = scrollStoreDown();

    await userEvent.click(screen.getByTestId('app-header'));

    expect(pane.scrollTop).toBe(0);
    expect(main.scrollTop).toBe(0);
  });

  it('leaves the store where it is when the menu button is tapped', async () => {
    renderStore();
    const { main, pane } = scrollStoreDown();

    await userEvent.click(screen.getByTestId('mobile-app-menu-btn'));

    expect(pane.scrollTop).toBe(400);
    expect(main.scrollTop).toBe(400);
  });

  it('keeps desktop scrolling as it is', async () => {
    isMobileClient.mockReturnValue(false);
    renderStore();
    const { main, pane } = scrollStoreDown();

    await userEvent.click(screen.getByTestId('app-header'));

    expect(pane.scrollTop).toBe(400);
    expect(main.scrollTop).toBe(400);
  });
});
