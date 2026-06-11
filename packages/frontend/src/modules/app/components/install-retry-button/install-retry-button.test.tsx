import { render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { InstallRetryButton } from './install-retry-button';

vi.mock('@/modules/app/helpers/use-app-status', () => ({
  useAppStatus: () => ({
    setOptimisticStatus: vi.fn(),
  }),
}));

vi.mock('@/modules/app/helpers/optimistic-installed-apps', () => ({
  addOptimisticInstalledApp: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({}),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  installAppMutation: () => ({}),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    error: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-tooltip', () => ({
  Tooltip: () => null,
}));

describe('InstallRetryButton', () => {
  it('uses the softer shared retry overlay background by default', () => {
    render(<InstallRetryButton urn="test-app:community" name="Test App" slug="test-app" />);

    expect(screen.getByRole('button', { name: 'APP_ACTION_RETRY_INSTALL' })).toHaveClass(
      'bg-background/25',
      'hover:bg-background/35',
      'dark:bg-background/15',
      'dark:hover:bg-background/25',
    );
  });
});
