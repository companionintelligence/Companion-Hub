import { render, screen, userEvent } from '@/tests/test-utils';
import { describe, it, expect, vi } from 'vitest';
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

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({ userSettings: { ciHubDeviceSlug: 'hub-device' } }),
}));

vi.mock('@/components/providers/theme/theme-provider', () => ({
  useTheme: () => ({ setTheme: vi.fn() }),
}));

vi.mock('@/components/mode-toggle', () => ({
  ModeToggle: () => <div data-testid="mode-toggle">ModeToggle</div>,
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    mutate: vi.fn(),
  }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  logoutMutation: () => ({ mutationFn: vi.fn() }),
}));

// Polyfill ResizeObserver for Radix UI
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function renderHeader(isLoggedIn = true, initialEntry = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Header isLoggedIn={isLoggedIn} />
    </MemoryRouter>,
  );
}

describe('Header', () => {
  it('renders Home and Store links when logged in', () => {
    renderHeader(true);

    expect(screen.getAllByRole('link', { name: /COMMON_HOME|Home/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('link', { name: /COMMON_APP_STORE|App Store|Store/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('does not render My Apps link', () => {
    renderHeader(true);

    expect(screen.queryByRole('link', { name: /My Apps/i })).not.toBeInTheDocument();
  });

  it('does not render navigation links when logged out', () => {
    renderHeader(false);

    expect(screen.queryByRole('link', { name: /COMMON_APP_STORE|App Store|Store/i })).not.toBeInTheDocument();
  });

  it('offsets the bar with the iOS safe-area token so it clears the notch', () => {
    renderHeader(true);
    const header = screen.getByTestId('app-header');
    expect(header.style.paddingTop).toBe('var(--safe-area-top, 0px)');
    expect(header.style.height).toBe('var(--header-offset)');
  });

  it('opens the phone menu without a Radix portal', async () => {
    renderHeader(true);
    expect(screen.queryByTestId('mobile-app-menu')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('mobile-app-menu-btn'));
    expect(screen.getByTestId('mobile-app-menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /COMMON_SETTINGS|Settings/i })).toBeInTheDocument();
  });

  it('uses the stronger active styling for the selected settings button', () => {
    renderHeader(true, '/settings');

    expect(screen.getByRole('link', { name: /COMMON_SETTINGS|Settings/i })).toHaveClass('bg-accent', 'text-accent-foreground', 'btn-active');
  });
});
