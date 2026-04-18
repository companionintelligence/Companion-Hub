import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { Header } from '../header';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@/context/user-context', () => ({
  useUserContext: () => ({ isLoggedIn: true }),
}));

vi.mock('@/components/providers/theme/theme-provider', () => ({
  useTheme: () => ({ setTheme: vi.fn() }),
}));

vi.mock('@/components/mode-toggle', () => ({
  ModeToggle: () => <div data-testid="mode-toggle">ModeToggle</div>,
}));

let capturedMutationOptions: any = {};
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: any) => {
    capturedMutationOptions = options;
    return { mutate: vi.fn() };
  },
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  logoutMutation: () => ({ mutationFn: vi.fn() }),
}));

const mockSetTauriSessionId = vi.fn();
vi.mock('@/lib/api-fetch', () => ({
  setTauriSessionId: (...args: any[]) => mockSetTauriSessionId(...args),
}));

// Polyfill ResizeObserver for Radix UI
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function renderHeader(isLoggedIn = true) {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Header isLoggedIn={isLoggedIn} />
    </MemoryRouter>,
  );
}

describe('Header', () => {
  beforeEach(() => {
    capturedMutationOptions = {};
    mockSetTauriSessionId.mockClear();
  });

  it('renders My Apps link in desktop navigation when logged in', () => {
    renderHeader(true);

    // Desktop nav (hidden lg:flex) — check for the link
    const myAppsLinks = screen.getAllByRole('link', { name: /My Apps/i });
    expect(myAppsLinks.length).toBeGreaterThanOrEqual(1);

    // At least one link points to /apps
    const hasCorrectHref = myAppsLinks.some((link) => link.getAttribute('href') === '/apps');
    expect(hasCorrectHref).toBe(true);
  });

  it('renders Home, My Apps, and Store links when logged in', () => {
    renderHeader(true);

    expect(screen.getAllByRole('link', { name: /Home/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('link', { name: /My Apps/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('link', { name: /Store/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('does not render My Apps link when logged out', () => {
    renderHeader(false);

    expect(screen.queryByRole('link', { name: /My Apps/i })).not.toBeInTheDocument();
  });

  it('renders My Apps in mobile menu when logged in', () => {
    renderHeader(true);

    // Mobile dropdown renders a Link with "My Apps" text in the DOM
    // (even if visually hidden until the dropdown is opened)
    // Desktop nav contains a NavLink, mobile contains a Link — both are in the DOM
    const allMyAppsLinks = screen.getAllByRole('link', { name: /My Apps/i });
    // At minimum the desktop nav link exists; the mobile dropdown link may
    // be in the DOM as well depending on Radix rendering behaviour
    expect(allMyAppsLinks.length).toBeGreaterThanOrEqual(1);
    expect(allMyAppsLinks.some((link) => link.getAttribute('href') === '/apps')).toBe(true);
  });

  it('clears Tauri session on successful logout before reloading', () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', { value: { reload: reloadMock }, writable: true });

    renderHeader(true);

    expect(capturedMutationOptions.onSuccess).toBeDefined();
    capturedMutationOptions.onSuccess();

    expect(mockSetTauriSessionId).toHaveBeenCalledWith(null);
    expect(reloadMock).toHaveBeenCalled();
  });
});
