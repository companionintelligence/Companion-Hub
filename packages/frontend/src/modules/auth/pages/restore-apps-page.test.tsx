import { act, render, screen, waitFor } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RestoreAppsPage from './restore-apps-page';
import { sdkOk } from '@/tests/sdk-mock-helpers';

const { executeRehydrate, getRehydrateStatus, navigate } = vi.hoisted(() => ({
  executeRehydrate: vi.fn(),
  getRehydrateStatus: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => navigate,
    Navigate: ({ to }: { to: string }) => <div data-testid={`navigate-${to}`} />,
  };
});

vi.mock('@/api-client/sdk.gen', () => ({
  executeRehydrate,
  getRehydrateStatus,
}));

vi.mock('@/context/user-context', () => ({
  useUserContext: () => ({ isLoggedIn: true }),
}));

vi.mock('@/context/app-context', () => ({
  AppContextProvider: ({ children }: { children: React.ReactNode }) => children,
  useAppContext: () => ({
    refreshAppContext: vi.fn().mockResolvedValue(undefined),
    isLoading: false,
    user: { hasCompletedOnboarding: false },
  }),
}));

vi.mock('@/modules/app/helpers/use-install-queue', () => ({
  useInstallQueue: () => ({
    data: { active: null, queued: [] },
    isLoading: false,
  }),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('RestoreAppsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.setItem('ci-hub-registration-drift-choice', 'restore');
  });

  it('auto-triggers rehydrate and renders progress UI', async () => {
    getRehydrateStatus.mockResolvedValue(sdkOk({ completed: false, restoreIntent: true }));
    executeRehydrate.mockResolvedValue(
      sdkOk({
        success: true,
        message: 'Queued 1 install(s)',
        plan: {
          portalAppCount: 1,
          items: [
            {
              portalApp: { name: 'nextcloud', slug: 'nextcloud-official' },
              action: 'install',
              hasExistingData: true,
            },
          ],
        },
        queued: ['nextcloud:official'],
        started: [],
        skipped: [],
      }),
    );

    await act(async () => {
      render(<RestoreAppsPage />);
    });

    await waitFor(() => {
      expect(executeRehydrate).toHaveBeenCalled();
    });

    expect(screen.getByTestId('restore-apps-page')).toBeInTheDocument();
    expect(screen.getByText('nextcloud')).toBeInTheDocument();
  });

  it('redirects home when drift choice is not restore', async () => {
    sessionStorage.setItem('ci-hub-registration-drift-choice', 'fresh');
    getRehydrateStatus.mockResolvedValue(sdkOk({ completed: false, restoreIntent: false }));

    await act(async () => {
      render(<RestoreAppsPage />);
    });

    await waitFor(() => {
      expect(screen.getByTestId('navigate-/home')).toBeInTheDocument();
    });
  });
});
