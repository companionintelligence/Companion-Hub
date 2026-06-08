import { render, screen } from '@testing-library/react';
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

function renderHeader(isLoggedIn = true) {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Header isLoggedIn={isLoggedIn} />
    </MemoryRouter>,
  );
}

describe('Header', () => {
  it('renders Home and Store links when logged in', () => {
    renderHeader(true);

    expect(screen.getAllByRole('link', { name: /HEADER_DASHBOARD|Dashboard/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('link', { name: /HEADER_APP_STORE|App Store|Store/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('does not render My Apps link', () => {
    renderHeader(true);

    expect(screen.queryByRole('link', { name: /My Apps/i })).not.toBeInTheDocument();
  });

  it('does not render navigation links when logged out', () => {
    renderHeader(false);

    expect(screen.queryByRole('link', { name: /HEADER_APP_STORE|App Store|Store/i })).not.toBeInTheDocument();
  });
});
