import { render, screen } from '@/tests/test-utils';
import { useAppContext } from '@/context/app-context';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import SettingsPage from './settings-page';

vi.mock('@/context/app-context', () => ({
  useAppContext: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('../containers/user-settings', () => ({
  UserSettingsContainer: () => <div>User settings</div>,
}));

vi.mock('../containers/security', () => ({
  SecurityContainer: () => <div>Security</div>,
}));

vi.mock('../containers/logs', () => ({
  LogsContainer: () => <div>Logs</div>,
}));

vi.mock('../containers/network-settings', () => ({
  NetworkSettingsContainer: () => <div>Network</div>,
}));

vi.mock('../containers/system-inspector', () => ({
  SystemInspectorContainer: () => <div>System inspector</div>,
}));

vi.mock('../containers/general-actions', () => ({
  GeneralActionsContainer: () => <div>General actions</div>,
}));

vi.mock('../containers/app-stores-container', () => ({
  AppStoresContainer: () => <div>App stores</div>,
}));

const mockUseAppContext = vi.mocked(useAppContext);

function renderSettingsPage(initialEntry: string) {
  mockUseAppContext.mockReturnValue({
    userSettings: {},
    user: { username: 'admin@ci.computer', totpEnabled: false },
  } as ReturnType<typeof useAppContext>);

  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe('SettingsPage', () => {
  it('uses the default constrained layout for non-log settings tabs', async () => {
    renderSettingsPage('/settings');

    expect(await screen.findByText('User settings')).toBeInTheDocument();

    const scrollContainer = screen.getByTestId('settings-scroll-container');
    const innerWrapper = scrollContainer.firstElementChild as HTMLElement;

    expect(scrollContainer).toHaveClass('overflow-y-auto');
    expect(scrollContainer).not.toHaveClass('overflow-hidden');
    expect(innerWrapper).toHaveClass('max-w-5xl');
    expect(innerWrapper).not.toHaveClass('max-w-none');
    expect(innerWrapper).not.toHaveClass('h-full');
  });

  it('expands only the logs tab to the full available size', async () => {
    renderSettingsPage('/settings?tab=logs');

    expect(await screen.findByText('Logs')).toBeInTheDocument();

    const scrollContainer = screen.getByTestId('settings-scroll-container');
    const innerWrapper = scrollContainer.firstElementChild as HTMLElement;

    expect(scrollContainer).toHaveClass('overflow-hidden');
    expect(scrollContainer).not.toHaveClass('overflow-y-auto');
    expect(innerWrapper).toHaveClass('h-full');
    expect(innerWrapper).toHaveClass('max-w-none');
    expect(innerWrapper).not.toHaveClass('max-w-5xl');
  });
});
