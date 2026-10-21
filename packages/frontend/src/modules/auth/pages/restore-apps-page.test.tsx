import { act, render, screen, userEvent, waitFor } from '@/tests/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RestoreAppsPage from './restore-apps-page';
import { sdkFail, sdkOk } from '@/tests/sdk-mock-helpers';

const { acknowledgeRestore, executeRehydrate, getRehydrateStatus, navigate } = vi.hoisted(() => ({
  acknowledgeRestore: vi.fn(),
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
  acknowledgeRestore,
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
    sessionStorage.clear();
    sessionStorage.setItem('ci-hub-registration-drift-choice', 'restore');
    acknowledgeRestore.mockResolvedValue(sdkOk({ success: true }));
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

  it('offers retry and a way into the Hub when the restore request fails', async () => {
    getRehydrateStatus.mockResolvedValue(sdkFail(500));

    await act(async () => {
      render(<RestoreAppsPage />);
    });

    expect(await screen.findByText('Could not check restore status. Please try again from Settings after signing in.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    getRehydrateStatus.mockResolvedValue(sdkOk({ completed: false, restoreIntent: true }));
    executeRehydrate.mockResolvedValue(
      sdkOk({
        success: true,
        message: 'done',
        alreadyCompleted: true,
        plan: { portalAppCount: 0, items: [] },
        queued: [],
        started: [],
        skipped: [],
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(executeRehydrate).toHaveBeenCalled());
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

  /*
   * The Hub restores the device's apps right after pairing, with nobody signed in. The person who signs
   * in next, from any browser, sees what came back and what did not, once, instead of the setup wizard.
   */
  describe('after the Hub restored on its own', () => {
    const summary = {
      completedAt: '2026-10-21T10:45:00.000Z',
      restored: [
        { name: 'Excalidraw', urn: 'excalidraw:ci-marketplace', status: 'running', usesAi: false },
        { name: 'OpenClaw', urn: 'ci-openclaw:ci-marketplace', status: 'running', usesAi: true },
      ],
      notRestored: [
        {
          name: 'Kimai',
          urn: 'kimai:ci-marketplace',
          reason: 'APP_INSTALL_FORM_ERROR_INVALID',
          code: 'failed',
          params: { fields: 'Admin Password' },
        },
      ],
      aiModelChosen: false,
    };

    beforeEach(() => {
      // Signed in from a browser that never chose "Restore existing device".
      sessionStorage.clear();
      getRehydrateStatus.mockResolvedValue(sdkOk({ completed: true, restoreIntent: false, checking: false, noticePending: true, summary }));
    });

    it('shows what was restored and why an app was not, without restoring again', async () => {
      await act(async () => {
        render(<RestoreAppsPage />);
      });

      expect(await screen.findByText('Your apps are back on this Hub')).toBeInTheDocument();
      expect(screen.getByText('Excalidraw')).toBeInTheDocument();
      const notRestored = screen.getByTestId('restore-summary-not-restored');
      expect(notRestored).toHaveTextContent('Kimai');
      expect(notRestored).toHaveTextContent(
        "It needs settings your CI Account doesn't keep: Admin Password. Install it from the App Store to fill them in.",
      );
      expect(executeRehydrate).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    });

    it('records that the restore was seen, then opens the Hub', async () => {
      await act(async () => {
        render(<RestoreAppsPage />);
      });

      await userEvent.click(await screen.findByTestId('restore-summary-continue'));

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/home', { replace: true }));
      expect(acknowledgeRestore).toHaveBeenCalled();
    });

    it('still lets the person leave when the Hub cannot record that the restore was seen', async () => {
      acknowledgeRestore.mockResolvedValue(sdkFail(500));

      await act(async () => {
        render(<RestoreAppsPage />);
      });

      await userEvent.click(await screen.findByTestId('restore-summary-continue'));

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/home', { replace: true }));
      expect(sessionStorage.getItem('ci-hub-restore-notice-seen')).toBe('1');
    });

    it('opens the App Store page of an app that was not restored, where its settings can be filled in', async () => {
      await act(async () => {
        render(<RestoreAppsPage />);
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Open in App Store' }));

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/store/ci-marketplace/kimai', { replace: true }));
      expect(acknowledgeRestore).toHaveBeenCalled();
    });

    it('says restored AI apps use the recommended model until one is chosen', async () => {
      await act(async () => {
        render(<RestoreAppsPage />);
      });

      expect(
        await screen.findByText('No AI model is chosen on this Hub yet, so OpenClaw uses the one this Hub recommends for its hardware.'),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Choose a model' }));
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/settings?tab=ai', { replace: true }));
    });

    it('shows the summary once a restore it joined has finished', async () => {
      const underWay = sdkOk({ completed: false, restoreIntent: true, checking: false, noticePending: true });
      // Asked by the page's gate, then by the page.
      getRehydrateStatus
        .mockResolvedValueOnce(underWay)
        .mockResolvedValueOnce(underWay)
        .mockResolvedValue(sdkOk({ completed: true, restoreIntent: true, checking: false, noticePending: true, summary }));
      executeRehydrate.mockResolvedValue(
        sdkOk({
          success: true,
          message: 'Queued 2 install(s) and 0 start(s) from Portal',
          plan: { portalAppCount: 3, items: [] },
          queued: ['excalidraw:ci-marketplace'],
          started: [],
          skipped: [],
        }),
      );

      await act(async () => {
        render(<RestoreAppsPage />);
      });

      expect(await screen.findByText('Your apps are back on this Hub')).toBeInTheDocument();
      expect(executeRehydrate).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  describe('right after pairing, while the Hub asks which apps the device had', () => {
    beforeEach(() => {
      sessionStorage.clear();
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits for the answer, then restores', async () => {
      getRehydrateStatus
        .mockResolvedValueOnce(sdkOk({ completed: false, restoreIntent: false, checking: true, noticePending: false }))
        .mockResolvedValueOnce(sdkOk({ completed: false, restoreIntent: false, checking: true, noticePending: false }))
        .mockResolvedValue(sdkOk({ completed: false, restoreIntent: true, checking: false, noticePending: true }));
      executeRehydrate.mockResolvedValue(
        sdkOk({
          success: true,
          message: 'Queued 1 install(s)',
          plan: { portalAppCount: 1, items: [] },
          queued: ['excalidraw:ci-marketplace'],
          started: [],
          skipped: [],
        }),
      );

      await act(async () => {
        render(<RestoreAppsPage />);
      });

      expect(await screen.findByText('Looking for your apps')).toBeInTheDocument();
      expect(executeRehydrate).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });

      await waitFor(() => expect(executeRehydrate).toHaveBeenCalledWith({ body: { source: 'restore' } }));
    });

    it('goes on to the Hub and its setup when there is nothing to restore', async () => {
      getRehydrateStatus
        .mockResolvedValueOnce(sdkOk({ completed: false, restoreIntent: false, checking: true, noticePending: false }))
        .mockResolvedValueOnce(sdkOk({ completed: false, restoreIntent: false, checking: true, noticePending: false }))
        .mockResolvedValue(sdkOk({ completed: false, restoreIntent: false, checking: false, noticePending: false }));

      await act(async () => {
        render(<RestoreAppsPage />);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/home', { replace: true }));
      expect(executeRehydrate).not.toHaveBeenCalled();
    });

    it('offers to go on to setup when the answer is slow', async () => {
      getRehydrateStatus.mockResolvedValue(sdkOk({ completed: false, restoreIntent: false, checking: true, noticePending: false }));

      await act(async () => {
        render(<RestoreAppsPage />);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(22_100);
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Continue to setup' }));
      expect(navigate).toHaveBeenCalledWith('/onboarding', { replace: true });
    });
  });
});
