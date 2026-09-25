import { act, render, screen, userEvent, waitFor } from '@/tests/test-utils';
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

vi.mock('@/modules/app/helpers/use-install-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/app/helpers/use-install-queue')>();
  return {
    ...actual,
    useInstallQueue: () => ({
      data: { active: null, queued: [] },
      isLoading: false,
    }),
  };
});

vi.mock('sonner', () => ({
  toast: {
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

  /*
   * The Hub restores on its own after pairing, so the restore is often done before this page opens.
   * Moving straight on skipped the step that marks this person's onboarding done.
   */
  it('finishes a restore the Hub already ran, then continues to the dashboard', async () => {
    getRehydrateStatus.mockResolvedValue(sdkOk({ completed: true, restoreIntent: true }));
    executeRehydrate.mockResolvedValue(
      sdkOk({
        success: true,
        message: 'Rehydration already completed for this registration epoch',
        alreadyCompleted: true,
        plan: { portalAppCount: 0, items: [] },
        queued: ['wordpress:ci-marketplace'],
        started: [],
        skipped: [],
      }),
    );
    const { toast } = await import('sonner');

    await act(async () => {
      render(<RestoreAppsPage />);
    });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/home', { replace: true }));
    expect(executeRehydrate).toHaveBeenCalledWith({ body: { source: 'restore' } });
    expect(sessionStorage.getItem('ci-hub-registration-drift-choice')).toBeNull();
    // A finished restore's plan is only for show; an empty one says nothing about the account.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('still continues to the dashboard when finishing an already-run restore fails', async () => {
    getRehydrateStatus.mockResolvedValue(sdkOk({ completed: true, restoreIntent: true }));
    executeRehydrate.mockRejectedValue(new Error('offline'));

    await act(async () => {
      render(<RestoreAppsPage />);
    });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/home', { replace: true }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  /*
   * Rehydrate installs as the person who asked (CI-Hub#1397). With nothing queued, the page used to
   * move straight on — so a refused install was never shown, and the restore looked finished.
   */
  describe('when an install is refused for this account', () => {
    beforeEach(() => {
      getRehydrateStatus.mockResolvedValue(sdkOk({ completed: false, restoreIntent: true }));
      executeRehydrate.mockResolvedValue(
        sdkOk({
          success: true,
          message: 'Queued 0 install(s) and 0 start(s) from Portal; 1 install(s) were refused for this account',
          incomplete: true,
          plan: { portalAppCount: 1, items: [{ portalApp: { name: 'Immich', slug: 'immich' }, action: 'install', hasExistingData: false }] },
          queued: [],
          started: [],
          skipped: [{ name: 'Immich', reason: 'APP_ACTION_GRANT_DENIED' }],
        }),
      );
    });

    it('stays on the page and says which apps were not restored, and why', async () => {
      await act(async () => {
        render(<RestoreAppsPage />);
      });

      expect(await screen.findByText('Some apps were not restored')).toBeInTheDocument();
      expect(screen.getByText('Immich: You are not allowed to install this app.')).toBeInTheDocument();
      expect(navigate).not.toHaveBeenCalled();
    });

    it('retries on request', async () => {
      await act(async () => {
        render(<RestoreAppsPage />);
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));

      await waitFor(() => expect(executeRehydrate).toHaveBeenCalledTimes(2));
    });

    it('continues to the dashboard without the restore choice, so it is not sent straight back here', async () => {
      await act(async () => {
        render(<RestoreAppsPage />);
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Continue to dashboard' }));

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/home', { replace: true }));
      expect(sessionStorage.getItem('ci-hub-registration-drift-choice')).toBeNull();
    });
  });
});
