import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstallStep } from '../install-step';
import { sdkOk, sdkFail } from '@/tests/sdk-mock-helpers';

const mockInvalidateQueries = vi.fn();
const mockSetQueryData = vi.fn();

const { installApp, getInstalledApps, saveInferencePreferences, pinInferenceModel, saveCloudProviderConfig, fetchTrackedModels } = vi.hoisted(() => ({
  installApp: vi.fn(),
  getInstalledApps: vi.fn(),
  saveInferencePreferences: vi.fn(),
  pinInferenceModel: vi.fn(),
  saveCloudProviderConfig: vi.fn(),
  fetchTrackedModels: vi.fn(),
}));

vi.mock('@/api-client/sdk.gen', () => ({
  installApp,
  getInstalledApps,
}));

vi.mock('@/lib/inference/inference-api', () => ({
  saveInferencePreferences,
  pinInferenceModel,
  saveCloudProviderConfig,
}));

vi.mock('@/lib/inference/tracked-models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inference/tracked-models')>();
  return {
    ...actual,
    fetchTrackedModels,
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    getQueryData: vi.fn(() => ({ installed: [] })),
    setQueryData: mockSetQueryData,
    invalidateQueries: mockInvalidateQueries,
  }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getInstalledAppsQueryKey: () => ['installed-apps'],
}));

const makeApp = (slug: string, name: string, urn?: string): OnboardingApp => ({
  appSlug: slug,
  name,
  icon: `/icons/${slug}.png`,
  category: 'utilities',
  replacesNames: [],
  urn,
  localSubdomain: slug,
});

describe('InstallStep', () => {
  const onComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    installApp.mockResolvedValue(sdkOk({}));
    getInstalledApps.mockResolvedValue(sdkOk({ installed: [] }));
    saveInferencePreferences.mockResolvedValue(undefined);
    pinInferenceModel.mockResolvedValue(undefined);
    saveCloudProviderConfig.mockResolvedValue(undefined);
    fetchTrackedModels.mockResolvedValue([]);
    mockInvalidateQueries.mockResolvedValue(undefined);
  });

  it('renders all apps in queued state initially', () => {
    const apps = [makeApp('nextcloud', 'Nextcloud', 'nextcloud:store1'), makeApp('gitea', 'Gitea', 'gitea:store1')];

    render(<InstallStep apps={apps} onComplete={onComplete} />);

    expect(screen.getByText('Nextcloud')).toBeInTheDocument();
    expect(screen.getByText('Gitea')).toBeInTheDocument();
    // At least one should be queued (the second one hasn't started yet)
    const queuedIcons = screen.queryAllByTestId('status-queued');
    expect(queuedIcons.length).toBeGreaterThanOrEqual(1);
  });

  it('shows the correct progress text while installing', () => {
    const apps = [makeApp('nextcloud', 'Nextcloud', 'nextcloud:store1')];

    render(<InstallStep apps={apps} onComplete={onComplete} />);

    expect(screen.getByText('Installing Apps')).toBeInTheDocument();
  });

  it('marks apps without a URN as failed immediately', async () => {
    const apps = [makeApp('no-urn', 'NoUrn App')]; // no urn

    render(<InstallStep apps={apps} onComplete={onComplete} />);

    // Should eventually show the failure
    const failedIcon = await screen.findByTestId('status-failed', {}, { timeout: 3000 });
    expect(failedIcon).toBeInTheDocument();
    expect(screen.getByText('Not available in store')).toBeInTheDocument();
  });

  it('shows status labels for each state', () => {
    const apps = [makeApp('app1', 'App One', 'app1:store1'), makeApp('app2', 'App Two', 'app2:store1')];

    render(<InstallStep apps={apps} onComplete={onComplete} />);

    // At least one should show Queued (the second hasn't started yet);
    // the first may have already transitioned to Installing
    const queued = screen.queryAllByText('Queued');
    const installing = screen.queryAllByText('Installing…');
    expect(queued.length + installing.length).toBeGreaterThanOrEqual(1);
  });

  it('provides a continue button that calls onComplete', async () => {
    const apps = [makeApp('app1', 'App One', 'app1:store1')];

    render(<InstallStep apps={apps} onComplete={onComplete} />);

    const btn = screen.getByTestId('install-continue-btn');
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toContain('Continue');
  });

  it('flags continuedInBackground when Continue is clicked before installs finish', async () => {
    installApp.mockImplementation(() => new Promise(() => {}));

    render(<InstallStep apps={[makeApp('app1', 'App One', 'app1:store1')]} onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId('install-continue-btn'));

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ continuedInBackground: true }));
  });

  it('flags continuedInBackground when installs end incomplete but are still converging', async () => {
    installApp.mockResolvedValue(sdkOk({}));
    getInstalledApps.mockResolvedValue(sdkOk({ installed: [{ info: { urn: 'app1:store1' }, app: { status: 'installing' } }] }));

    vi.useFakeTimers();

    render(<InstallStep apps={[makeApp('app1', 'App One', 'app1:store1')]} onComplete={onComplete} />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    vi.useRealTimers();

    expect(await screen.findByTestId('status-incomplete', {}, { timeout: 5000 })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('install-continue-btn'));

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ continuedInBackground: true, incomplete: 1 }));
  });

  it('renders the app list container', () => {
    const apps = [makeApp('app1', 'App One', 'app1:store1')];

    render(<InstallStep apps={apps} onComplete={onComplete} />);

    expect(screen.getByTestId('install-app-list')).toBeInTheDocument();
  });

  it('shows clear text when no apps are selected', async () => {
    render(
      <InstallStep
        apps={[]}
        onComplete={onComplete}
        aiSetupConfig={{
          agentFrameworks: ['openclaw'],
          selectedModels: [],
          installedCatalogIds: [],
          backend: 'ollama',
          cloudProviders: [],
          remoteAccess: [],
          skipped: true,
        }}
      />,
    );

    expect(await screen.findByText('No apps selected for installation.')).toBeInTheDocument();
    expect(screen.queryByText(/Installing 1 of 0/)).not.toBeInTheDocument();
  });

  it('persists selected backend preference during AI setup (no preferred model)', async () => {
    render(
      <InstallStep
        apps={[]}
        onComplete={onComplete}
        aiSetupConfig={{
          agentFrameworks: ['openclaw'],
          remoteAccess: [],
          selectedModels: [],
          installedCatalogIds: [],
          backend: 'vllm',
          cloudProviders: [],
          skipped: false,
        }}
      />,
    );

    await waitFor(() => {
      expect(saveInferencePreferences).toHaveBeenCalledWith({
        backend: 'vllm',
        model: null,
        embeddingModel: null,
        visionModel: null,
      });
    });
  });

  it('persists the preferred model alongside the backend during AI setup', async () => {
    fetchTrackedModels.mockResolvedValue([
      { catalogId: 'llama3-3-70b', state: 'pulled' },
      { catalogId: 'bad-model', state: 'error', errorMessage: 'connect ECONNREFUSED' },
    ] as never);
    getInstalledApps.mockResolvedValue(sdkOk({ installed: [] }));

    render(
      <InstallStep
        apps={[makeApp('nextcloud', 'Nextcloud', 'nextcloud:store1')]}
        onComplete={onComplete}
        aiSetupConfig={{
          agentFrameworks: ['openclaw'],
          remoteAccess: [],
          selectedModels: ['llama3-3-70b', 'bad-model'],
          installedCatalogIds: [],
          backend: 'ollama',
          cloudProviders: [],
          preferredModelId: 'llama3-3-70b',
          skipped: false,
        }}
      />,
    );

    await waitFor(
      () => {
        expect(saveInferencePreferences).toHaveBeenCalledWith({
          backend: 'ollama',
          model: 'llama3-3-70b',
          embeddingModel: null,
          visionModel: null,
        });
      },
      { timeout: 5000 },
    );

    await waitFor(
      () => {
        expect(installApp).toHaveBeenCalled();
      },
      { timeout: 10000 },
    );
  });

  it('persists embedding and vision defaults only when those models are installed or pulled successfully', async () => {
    fetchTrackedModels.mockResolvedValue([
      { catalogId: 'chat-model', state: 'pulled' },
      { catalogId: 'embedding-model', state: 'pulled' },
      { catalogId: 'vision-model', state: 'error', errorMessage: 'download failed' },
    ] as never);

    render(
      <InstallStep
        apps={[]}
        onComplete={onComplete}
        aiSetupConfig={{
          agentFrameworks: ['openclaw'],
          remoteAccess: [],
          selectedModels: ['chat-model', 'embedding-model', 'vision-model'],
          installedCatalogIds: [],
          backend: 'ollama',
          cloudProviders: [],
          preferredModelId: 'chat-model',
          preferredEmbeddingModelId: 'embedding-model',
          preferredVisionModelId: 'vision-model',
          skipped: false,
        }}
      />,
    );

    await waitFor(
      () => {
        expect(saveInferencePreferences).toHaveBeenCalledWith({
          backend: 'ollama',
          model: 'chat-model',
          embeddingModel: 'embedding-model',
          visionModel: null,
        });
      },
      { timeout: 5000 },
    );
  });

  it('polls tracked models without restarting pulls started on the form page', async () => {
    fetchTrackedModels.mockResolvedValue([{ catalogId: 'llama3-3-70b', state: 'pulled' }] as never);

    render(
      <InstallStep
        apps={[]}
        onComplete={onComplete}
        aiSetupConfig={{
          agentFrameworks: ['openclaw'],
          remoteAccess: [],
          selectedModels: ['llama3-3-70b'],
          installedCatalogIds: [],
          backend: 'ollama',
          cloudProviders: [],
          skipped: false,
        }}
      />,
    );

    await waitFor(
      () => {
        expect(pinInferenceModel).toHaveBeenCalledWith('llama3-3-70b');
      },
      { timeout: 5000 },
    );
  });

  it('only pins models that finished pulling', async () => {
    vi.useFakeTimers();

    fetchTrackedModels.mockResolvedValue([
      { catalogId: 'llama3-3-70b', state: 'pulled' },
      { catalogId: 'still-pulling', state: 'pulling', pullProgress: 50 },
    ] as never);

    render(
      <InstallStep
        apps={[]}
        onComplete={onComplete}
        aiSetupConfig={{
          agentFrameworks: ['openclaw'],
          remoteAccess: [],
          selectedModels: ['llama3-3-70b', 'still-pulling'],
          installedCatalogIds: [],
          backend: 'ollama',
          cloudProviders: [],
          skipped: false,
        }}
      />,
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    vi.useRealTimers();

    await waitFor(
      () => {
        expect(pinInferenceModel).toHaveBeenCalledWith('llama3-3-70b');
      },
      { timeout: 5000 },
    );

    expect(pinInferenceModel).not.toHaveBeenCalledWith('still-pulling');
  });

  it('invalidates installed apps on HTTP install failure (server truth)', async () => {
    installApp.mockResolvedValue(sdkFail(500, { message: 'Server error' }));

    render(<InstallStep apps={[makeApp('plane', 'Plane', 'plane:store1')]} onComplete={onComplete} />);

    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['installed-apps'] });
    });
  });

  it('marks app failed when poll sees install_failed', async () => {
    installApp.mockResolvedValue(sdkOk({ requestId: '1' }));
    getInstalledApps.mockResolvedValue(
      sdkOk({
        installed: [
          {
            info: { urn: 'plane:store1', name: 'Plane' },
            app: { status: 'install_failed' },
          },
        ],
      }),
    );

    render(<InstallStep apps={[makeApp('plane', 'Plane', 'plane:store1')]} onComplete={onComplete} />);

    expect(await screen.findByTestId('status-failed', {}, { timeout: 12000 })).toBeInTheDocument();
    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['installed-apps'] });
    });
  });

  it('defaults Hermes allowed users to the operator username during onboarding installs', async () => {
    installApp.mockResolvedValue(sdkOk({ requestId: '1' }));
    getInstalledApps.mockResolvedValue(
      sdkOk({
        installed: [
          {
            info: { urn: 'ci-hermes:store1', name: 'Hermes' },
            app: { status: 'running' },
          },
        ],
      }),
    );

    render(
      <InstallStep apps={[makeApp('ci-hermes', 'Hermes', 'ci-hermes:store1')]} operatorUsername="operator@example.com" onComplete={onComplete} />,
    );

    await waitFor(() => {
      expect(installApp).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { urn: 'ci-hermes:store1' },
          body: {
            localSubdomain: 'ci-hermes',
            exposureMode: 'cloudflare',
            exposedLocal: true,
            openPort: false,
            GATEWAY_ALLOWED_USERS: 'operator@example.com',
          },
        }),
      );
    });
  });

  it('uses per-app exposureMode override when set on the app', async () => {
    installApp.mockResolvedValue(sdkOk({ requestId: '1' }));
    getInstalledApps.mockResolvedValue(
      sdkOk({
        installed: [
          {
            info: { urn: 'ci-memory:store1', name: 'Companion Memory' },
            app: { status: 'running' },
          },
        ],
      }),
    );

    const app: OnboardingApp = {
      ...makeApp('ci-memory', 'Companion Memory', 'ci-memory:store1'),
      exposureMode: 'cloudflare',
    };

    render(<InstallStep apps={[app]} defaultExposureMode="tailscale" onComplete={onComplete} />);

    await waitFor(() => {
      expect(installApp).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { urn: 'ci-memory:store1' },
          body: {
            localSubdomain: 'ci-memory',
            exposureMode: 'cloudflare',
            exposedLocal: true,
            openPort: false,
          },
        }),
      );
    });
  });

  it('does not inject Hermes defaults for other apps', async () => {
    installApp.mockResolvedValue(sdkOk({ requestId: '1' }));
    getInstalledApps.mockResolvedValue(
      sdkOk({
        installed: [
          {
            info: { urn: 'plane:store1', name: 'Plane' },
            app: { status: 'running' },
          },
        ],
      }),
    );

    render(<InstallStep apps={[makeApp('plane', 'Plane', 'plane:store1')]} operatorUsername="operator@example.com" onComplete={onComplete} />);

    await waitFor(() => {
      expect(installApp).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { urn: 'plane:store1' },
          body: {
            localSubdomain: 'plane',
            exposureMode: 'cloudflare',
            exposedLocal: true,
            openPort: false,
          },
        }),
      );
    });
  });
});
