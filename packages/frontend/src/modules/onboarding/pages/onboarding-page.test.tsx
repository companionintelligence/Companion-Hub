import { sdkOk } from '@/tests/sdk-mock-helpers';
import { render, screen, waitFor } from '@/tests/test-utils';
import { TranslatableError } from '@/types/error.types';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { InstallSummary } from '../helpers/types';
import OnboardingPage from './onboarding-page';

const { mockCatalogState, mockAppContext, mockCompleteOnboarding, mockNavigate, mockToast } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockCatalogState: {
    isLoading: false,
    isError: false,
  },
  // Stable across renders so tests can assert on them; a fresh vi.fn() per useAppContext() call
  // would record nothing the test can see.
  mockAppContext: {
    setAppContext: vi.fn(),
    refreshAppContext: vi.fn().mockResolvedValue(undefined),
  },
  mockCompleteOnboarding: vi.fn(),
  mockToast: {
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// Only error/dismiss are replaced; the real Toaster and the rest of the API stay in place.
vi.mock('react-hot-toast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const toast = Object.assign(((...args: unknown[]) => (actual.default as (...a: unknown[]) => unknown)(...args)) as never, actual.default, {
    error: mockToast.error,
    dismiss: mockToast.dismiss,
  });
  return { ...actual, default: toast, toast };
});

// Only useNavigate is replaced; MemoryRouter and <Navigate> stay real so the render guards behave.
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNavigate: () => mockNavigate,
}));

vi.mock('@/context/app-context', () => ({
  AppContextProvider: ({ children }: { children: ReactNode }) => children,
  useAppContext: () => ({
    user: { hasCompletedOnboarding: false },
    cloudflareAvailable: false,
    tailscaleAvailable: true,
    setAppContext: mockAppContext.setAppContext,
    refreshAppContext: mockAppContext.refreshAppContext,
  }),
}));

vi.mock('@/api-client/sdk.gen', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  completeOnboarding: mockCompleteOnboarding,
}));

vi.mock('../helpers/use-marketplace-catalog-apps', () => ({
  useMarketplaceCatalogApps: () => ({
    apps: mockCatalogState.isLoading
      ? []
      : [
          {
            id: 'ci-openclaw',
            name: 'OpenClaw',
            urn: 'urn:store:ci-openclaw',
            short_desc: 'Agent',
            available: true,
            deprecated: false,
            categories: [],
            created_at: 0,
            supported_architectures: [],
          },
          {
            id: 'ci-hermes',
            name: 'Hermes',
            urn: 'urn:store:ci-hermes',
            short_desc: 'Agent',
            available: true,
            deprecated: false,
            categories: [],
            created_at: 0,
            supported_architectures: [],
          },
        ],
    isLoading: mockCatalogState.isLoading,
    isFetching: mockCatalogState.isLoading,
    isError: mockCatalogState.isError,
    refetch: vi.fn(),
  }),
}));

vi.mock('../helpers/prefetch-onboarding-marketplace', () => ({
  prefetchOnboardingMarketplace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/context/user-context', () => ({
  useUserContext: () => ({ isLoggedIn: true }),
}));

vi.mock('@/lib/theme/theme', () => ({ getLogo: () => '/logo.svg' }));

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ services: [] }) }),
}));

// The config sections are exercised in their own suites; here we mock them to drive the page flow.
vi.mock('../components/ai-setup-step', () => ({
  AiSetupStep: ({
    onConfigChange,
    children,
    onCompanionAppsChange,
  }: {
    onConfigChange?: (c: unknown) => void;
    children?: ReactNode;
    onCompanionAppsChange?: (apps: unknown[]) => void;
  }) => (
    <div data-testid="ai-setup-step">
      AI Setup
      {children}
      <button
        type="button"
        onClick={() =>
          onConfigChange?.({
            agentFrameworks: ['openclaw'],
            selectedModels: ['phi-4-mini'],
            installedCatalogIds: ['phi-4-mini'],
            backend: 'ollama',
            cloudProviders: [],
            remoteAccess: [],
            skipped: false,
            installBlocked: false,
          })
        }
      >
        emit-ai-config
      </button>
      <button
        type="button"
        onClick={() =>
          onConfigChange?.({
            agentFrameworks: [],
            selectedModels: [],
            installedCatalogIds: [],
            backend: 'ollama',
            cloudProviders: [],
            remoteAccess: [],
            skipped: false,
            installBlocked: false,
          })
        }
      >
        emit-ai-config-no-agent
      </button>
      <button
        type="button"
        onClick={() =>
          onConfigChange?.({
            agentFrameworks: ['openclaw'],
            selectedModels: [],
            installedCatalogIds: [],
            backend: 'ollama',
            cloudProviders: [{ provider: 'openai', apiKey: 'sk-test', enabled: true }],
            remoteAccess: [],
            skipped: false,
            installBlocked: false,
          })
        }
      >
        emit-ai-config-cloud
      </button>
      <button
        type="button"
        onClick={() =>
          onConfigChange?.({
            agentFrameworks: ['openclaw'],
            selectedModels: ['llama3-3-70b'],
            installedCatalogIds: [],
            backend: 'ollama',
            cloudProviders: [],
            remoteAccess: [],
            skipped: false,
            installBlocked: false,
          })
        }
      >
        emit-ai-config-needs-download
      </button>
      <button
        type="button"
        onClick={() =>
          onConfigChange?.({
            agentFrameworks: ['openclaw', 'hermes'],
            selectedModels: ['phi-4-mini'],
            installedCatalogIds: ['phi-4-mini'],
            backend: 'ollama',
            cloudProviders: [],
            remoteAccess: [],
            skipped: false,
            installBlocked: false,
          })
        }
      >
        emit-ai-config-both-agents
      </button>
      <button
        type="button"
        onClick={() =>
          onCompanionAppsChange?.([
            {
              appSlug: 'ci-memory',
              name: 'CI Memory',
              icon: '',
              category: 'companion-intelligence',
              replacesNames: [],
              urn: 'urn:store:ci-memory',
              localSubdomain: 'ci-memory',
              exposureMode: 'tailscale',
            },
            {
              appSlug: 'ci-import-tools',
              name: 'Import Tools',
              icon: '',
              category: 'companion-intelligence',
              replacesNames: [],
              urn: 'urn:store:ci-import-tools',
              localSubdomain: 'ci-import-tools',
              exposureMode: 'tailscale',
            },
          ])
        }
      >
        emit-companion-apps
      </button>
    </div>
  ),
}));

vi.mock('../components/ai-setup/companion-apps-card', () => ({
  CompanionAppsCard: ({ onChange }: { onChange?: (apps: unknown[]) => void }) => (
    <div data-testid="companion-apps-card">
      <button
        type="button"
        onClick={() =>
          onChange?.([
            {
              appSlug: 'ci-memory',
              name: 'CI Memory',
              icon: '',
              category: 'companion-intelligence',
              replacesNames: [],
              urn: 'urn:store:ci-memory',
              localSubdomain: 'ci-memory',
              exposureMode: 'tailscale',
            },
            {
              appSlug: 'ci-import-tools',
              name: 'Import Tools',
              icon: '',
              category: 'companion-intelligence',
              replacesNames: [],
              urn: 'urn:store:ci-import-tools',
              localSubdomain: 'ci-import-tools',
              exposureMode: 'tailscale',
            },
          ])
        }
      >
        emit-companion-apps
      </button>
    </div>
  ),
}));

vi.mock('../components/recommendations-step', () => ({
  RecommendationsStep: ({ onChange }: { onChange?: (a: unknown[]) => void }) => (
    <div data-testid="recommendations-step">
      <button type="button" onClick={() => onChange?.([])}>
        emit-apps
      </button>
      <button
        type="button"
        onClick={() =>
          onChange?.([
            {
              appSlug: 'hermes',
              name: 'Hermes',
              icon: '/agents/hermes.png',
              category: 'featured',
              replacesNames: [],
              urn: undefined,
              localSubdomain: 'hermes',
            },
          ])
        }
      >
        emit-apps-hermes-legacy
      </button>
    </div>
  ),
}));

vi.mock('../components/install-step', () => ({
  InstallStep: ({ apps, onComplete }: { apps: Array<{ appSlug: string }>; onComplete: (summary: InstallSummary) => void | Promise<void> }) => (
    <div data-testid="install-step" data-apps={apps.map((a) => a.appSlug).join(',')}>
      <button
        type="button"
        onClick={() =>
          void onComplete({
            results: [],
            running: 0,
            incomplete: 0,
            failed: 0,
            total: 0,
          })
        }
      >
        install-complete
      </button>
    </div>
  ),
}));

const renderPage = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('OnboardingPage (single vertical form)', () => {
  beforeEach(() => {
    mockCatalogState.isLoading = false;
    mockCatalogState.isError = false;
    mockAppContext.setAppContext.mockClear();
    mockAppContext.refreshAppContext.mockClear().mockResolvedValue(undefined);
    mockNavigate.mockClear();
    mockToast.error.mockClear();
    mockToast.dismiss.mockClear();
    // The generated client resolves with a real `Response`; `sdkResult` reads `.ok`/`.status` off it.
    mockCompleteOnboarding.mockReset().mockResolvedValue(sdkOk(undefined));
  });

  it('renders config sections and step 4 (app picker) on the same page', () => {
    renderPage();
    expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument();
    expect(screen.getByTestId('recommendations-step')).toBeInTheDocument();
  });

  it('keeps Install & Finish disabled until AI config is provided', () => {
    renderPage();
    expect(screen.getByTestId('finish-setup-btn')).toBeDisabled();
  });

  it('keeps Install & Finish enabled while the marketplace catalog is loading', async () => {
    mockCatalogState.isLoading = true;
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config' }));
    expect(screen.getByTestId('finish-setup-btn')).toBeEnabled();
  });

  it('keeps Install & Finish enabled when the marketplace catalog fails to load', async () => {
    mockCatalogState.isError = true;
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config' }));
    expect(screen.getByTestId('finish-setup-btn')).toBeEnabled();
  });

  it('flows: AI config → Install & Finish → install → navigate to /store', async () => {
    const user = userEvent.setup();
    renderPage();

    // Step 4 (recommendations) is visible on the form page from the start.
    expect(screen.getByTestId('recommendations-step')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config' }));
    const finish = screen.getByTestId('finish-setup-btn');
    expect(finish).toBeEnabled();

    // Clicking Install & Finish transitions to the install phase immediately.
    await user.click(finish);
    expect(screen.getByTestId('install-step')).toBeInTheDocument();
    // The chosen agent is auto-queued in the install list.
    expect(screen.getByTestId('install-step')).toHaveAttribute('data-apps', 'ci-openclaw');

    // Completing the install navigates to /store (no complete-step shown).
    await user.click(screen.getByRole('button', { name: 'install-complete' }));
    expect(screen.queryByTestId('complete-step')).not.toBeInTheDocument();
  });

  describe('marking onboarding complete', () => {
    /** Returns the `user` handle so a test can drive a retry without re-inlining these steps. */
    const finishInstall = async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(screen.getByRole('button', { name: 'emit-ai-config' }));
      await user.click(screen.getByTestId('finish-setup-btn'));
      await user.click(screen.getByRole('button', { name: 'install-complete' }));
      return user;
    };

    it('re-reads the server context once the flag is written', async () => {
      await finishInstall();

      await waitFor(() => expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(mockAppContext.refreshAppContext).toHaveBeenCalled());
    });

    /**
     * A rejected PATCH means the server flag is still false, so every step that assumes it
     * landed has to be skipped: refetching would replace the optimistic flag with that false,
     * and the optimistic write itself would trip the `hasCompletedOnboarding` render guard and
     * navigate for us. Both roads end at /home bouncing the user back into the wizard.
     */
    it('MUST NOT refetch or optimistically flag the context when the write never landed', async () => {
      mockCompleteOnboarding.mockRejectedValue(new Error('Service Unavailable'));

      await finishInstall();

      await waitFor(() => expect(mockCompleteOnboarding).toHaveBeenCalledTimes(2), { timeout: 3_000 });
      expect(mockAppContext.setAppContext).not.toHaveBeenCalled();
      expect(mockAppContext.refreshAppContext).not.toHaveBeenCalled();
    });

    /** The user is left on a finished wizard, so the reason has to be on screen, not just a toast. */
    it('MUST keep the user on the wizard and say why when the write never landed', async () => {
      mockCompleteOnboarding.mockRejectedValue(new Error('Service Unavailable'));

      await finishInstall();

      const failure = await screen.findByTestId('onboarding-complete-failed', undefined, { timeout: 3_000 });
      expect(failure).toHaveTextContent(/could not save that setup is finished/i);
      // Still on the install phase, so Continue is there to retry with.
      expect(screen.getByRole('button', { name: 'install-complete' })).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('clears the failure notice and navigates once a retry lands', async () => {
      mockCompleteOnboarding.mockRejectedValue(new Error('Service Unavailable'));
      const user = await finishInstall();
      await screen.findByTestId('onboarding-complete-failed', undefined, { timeout: 3_000 });

      mockCompleteOnboarding.mockReset().mockResolvedValue(sdkOk(undefined));
      await user.click(screen.getByRole('button', { name: 'install-complete' }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/home', expect.objectContaining({ replace: true })));
      expect(screen.queryByTestId('onboarding-complete-failed')).not.toBeInTheDocument();
      // The Toaster outlives this route, so the failed attempt's toast would otherwise ride
      // along to /home still claiming the setup could not be saved.
      expect(mockToast.dismiss).toHaveBeenCalledWith('onboarding-complete-failed');
    });

    it('retries once and stops when the second attempt lands', async () => {
      mockCompleteOnboarding.mockRejectedValueOnce(new Error('Service Unavailable')).mockResolvedValue(sdkOk(undefined));

      await finishInstall();

      await waitFor(() => expect(mockAppContext.refreshAppContext).toHaveBeenCalled(), { timeout: 3_000 });
      expect(mockCompleteOnboarding).toHaveBeenCalledTimes(2);
    });

    it('treats a resolved response that is not ok as a failed write', async () => {
      mockCompleteOnboarding.mockResolvedValue({ data: undefined, response: undefined });

      await finishInstall();

      await waitFor(() => expect(mockCompleteOnboarding).toHaveBeenCalledTimes(2), { timeout: 3_000 });
      expect(mockAppContext.refreshAppContext).not.toHaveBeenCalled();
    });

    /**
     * A 401 means the session lapsed, not that the Hub is down: the interceptor has already
     * started the redirect to /login, so a second identical PATCH cannot succeed and only
     * delays the failure notice — whose advice ("check that the Hub is running") is wrong here.
     */
    it('MUST NOT retry a write the server refused outright', async () => {
      mockCompleteOnboarding.mockRejectedValue(new TranslatableError('SESSION_EXPIRED', {}, { status: 401, url: '/api/complete-onboarding' }));

      await finishInstall();

      await screen.findByTestId('onboarding-complete-failed', undefined, { timeout: 3_000 });
      expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
    });

    it('retries a 5xx, which a restarting Hub answers with', async () => {
      mockCompleteOnboarding.mockRejectedValue(new TranslatableError('SYSTEM_ERROR', {}, { status: 503, url: '/api/complete-onboarding' }));

      await finishInstall();

      await waitFor(() => expect(mockCompleteOnboarding).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    });

    /**
     * InstallStep's Continue button is never disabled and drops the promise it gets back, and
     * the handler now stays alive across the retry pause — so without a latch the loser of two
     * overlapping chains reports failure over the winner's navigation.
     */
    it('MUST NOT start a second completion chain while one is still in flight', async () => {
      let releaseFirst: (() => void) | undefined;
      mockCompleteOnboarding
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseFirst = () => resolve(sdkOk(undefined));
            }),
        )
        .mockResolvedValue(sdkOk(undefined));

      const user = await finishInstall();
      await waitFor(() => expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1));

      await user.click(screen.getByRole('button', { name: 'install-complete' }));
      expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);

      releaseFirst?.();
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
      expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
    });
  });

  it('queues no agent when none was selected', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config-no-agent' }));
    await user.click(screen.getByTestId('finish-setup-btn'));

    expect(screen.getByTestId('install-step')).toHaveAttribute('data-apps', '');
  });

  it('passes selected apps from RecommendationsStep to the install list', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config' }));
    // Emit apps from the embedded recommendations step before installing.
    await user.click(screen.getByRole('button', { name: 'emit-apps' }));
    await user.click(screen.getByTestId('finish-setup-btn'));

    // The openclaw agent is in the list (apps emitted empty, so only agent remains).
    expect(screen.getByTestId('install-step')).toHaveAttribute('data-apps', 'ci-openclaw');
  });

  it('includes cloud provider config in the AI setup config', async () => {
    const user = userEvent.setup();
    renderPage();

    // emit-ai-config-cloud provides a cloud provider; verify the form accepts it.
    await user.click(screen.getByRole('button', { name: 'emit-ai-config-cloud' }));
    expect(screen.getByTestId('finish-setup-btn')).toBeEnabled();
  });

  it('includes companion apps in the install list when selected', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config' }));
    await user.click(screen.getByRole('button', { name: 'emit-companion-apps' }));
    await user.click(screen.getByTestId('finish-setup-btn'));

    expect(screen.getByTestId('install-step')).toHaveAttribute('data-apps', 'ci-openclaw,ci-memory,ci-import-tools');
  });

  it('deduplicates Hermes when selected via agent framework and legacy app slug', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config-both-agents' }));
    await user.click(screen.getByRole('button', { name: 'emit-apps-hermes-legacy' }));
    await user.click(screen.getByTestId('finish-setup-btn'));

    expect(screen.getByTestId('install-step')).toHaveAttribute('data-apps', 'ci-openclaw,ci-hermes');
  });

  it('keeps Install & Finish enabled while model downloads are in progress', async () => {
    const { apiFetch } = await import('@/lib/api-fetch');
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url === '/api/system/detect-services') {
        return new Response(JSON.stringify({ services: [] }), { status: 200 });
      }
      if (url === '/api/inference/ollama/status') {
        return new Response(JSON.stringify({ ready: true, running: true }), { status: 200 });
      }
      if (url === '/api/inference/models/pull/start') {
        return new Response(JSON.stringify({ status: 'queued' }), { status: 200 });
      }
      if (url === '/api/inference/models/tracked') {
        return new Response(JSON.stringify([{ catalogId: 'llama3-3-70b', state: 'pulling', pullProgress: 34 }]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config' }));
    // Override with a model that still needs download
    await user.click(screen.getByRole('button', { name: 'emit-ai-config-needs-download' }));

    expect(screen.getByTestId('finish-setup-btn')).toBeEnabled();
    expect(await screen.findByTestId('model-download-status')).toBeInTheDocument();
  });
});
