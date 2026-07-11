import { render, screen } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallRetryButton } from './install-retry-button';

const { capturedOptions, invalidateQueries, removeOptimisticInstalledApp } = vi.hoisted(() => ({
  capturedOptions: { current: null as { onError?: (e: unknown) => void } | null },
  invalidateQueries: vi.fn(),
  removeOptimisticInstalledApp: vi.fn(),
}));

vi.mock('@/modules/app/helpers/use-app-status', () => ({
  useAppStatus: () => ({
    setOptimisticStatus: vi.fn(),
  }),
}));

vi.mock('@/modules/app/helpers/optimistic-installed-apps', () => ({
  addOptimisticInstalledApp: vi.fn(),
  removeOptimisticInstalledApp,
}));

vi.mock('@tanstack/react-query', () => ({
  // Capture the options so the mutation's own onError can be exercised directly.
  useMutation: (options: { onError?: (e: unknown) => void }) => {
    capturedOptions.current = options;
    return { mutate: vi.fn(), isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  installAppMutation: () => ({}),
  getInstalledAppsQueryKey: () => ['getInstalledApps'],
  getAppQueryKey: ({ path }: { path: { urn: string } }) => ['getApp', path.urn],
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

const invalidatedKeys = () => invalidateQueries.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));

describe('InstallRetryButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions.current = null;
  });

  it('uses the softer shared retry overlay background by default', () => {
    render(<InstallRetryButton urn="test-app:community" name="Test App" slug="test-app" />);

    expect(screen.getByRole('button', { name: 'APP_ACTION_RETRY_INSTALL' })).toHaveClass(
      'bg-background/25',
      'hover:bg-background/35',
      'dark:bg-background/15',
      'dark:hover:bg-background/25',
    );
  });

  describe('when the retry fails', () => {
    // `onMutate` optimistically forces the app to `installing` in BOTH caches. A request that fails
    // before the backend starts work emits no SSE event, and neither query polls — so if we do not
    // refetch them here, the tile and the details page spin forever on a status that never arrives.
    it('MUST refetch the installed list and the app itself', () => {
      render(<InstallRetryButton urn="test-app:community" name="Test App" slug="test-app" />);

      capturedOptions.current?.onError?.({ message: 'BOOM' });

      expect(invalidatedKeys()).toContain(JSON.stringify(['getInstalledApps']));
      expect(invalidatedKeys()).toContain(JSON.stringify(['getApp', 'test-app:community']));
    });

    // Unlike a first install, the row behind this button is a REAL `install_failed` row that onMutate
    // overwrote. Retracting it would make the tile vanish instead of returning it to its failed state
    // — taking this retry button down with it.
    it('MUST NOT retract the row behind it', () => {
      render(<InstallRetryButton urn="test-app:community" name="Test App" slug="test-app" />);

      capturedOptions.current?.onError?.({ message: 'BOOM' });

      expect(removeOptimisticInstalledApp).not.toHaveBeenCalled();
    });
  });
});
