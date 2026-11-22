import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { claimOnboardingInstallUrn } from '../../helpers/install-session';
import { InstallStep } from '../install-step';
import type { OnboardingApp } from '../../helpers/types';
import { sdkOk, sdkFail } from '@/tests/sdk-mock-helpers';

const mockInvalidateQueries = vi.fn();
const mockSetQueryData = vi.fn();

const {
  installApp,
  getInstalledApps,
  saveInferencePreferences,
  pinInferenceModel,
  saveCloudProviderConfig,
  fetchTrackedModels,
  startInferenceModelPull,
} = vi.hoisted(() => ({
  installApp: vi.fn(),
  getInstalledApps: vi.fn(),
  saveInferencePreferences: vi.fn(),
  pinInferenceModel: vi.fn(),
  saveCloudProviderConfig: vi.fn(),
  fetchTrackedModels: vi.fn(),
  startInferenceModelPull: vi.fn(),
}));

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

vi.mock('@/api-client/sdk.gen', () => ({
  installApp,
  getInstalledApps,
}));

vi.mock('@/lib/inference/inference-api', () => ({
  saveInferencePreferences,
  pinInferenceModel,
  saveCloudProviderConfig,
  startInferenceModelPull,
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
  const runnerSetupConfig = {
    agentFrameworks: [],
    remoteAccess: [],
    selectedModels: [],
    installedCatalogIds: [],
    backend: 'vllm' as const,
    cloudProviders: [],
    skipped: false,
  };

  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    installApp.mockResolvedValue(sdkOk({}));
    getInstalledApps.mockResolvedValue(sdkOk({ installed: [] }));
    saveInferencePreferences.mockResolvedValue(undefined);
    pinInferenceModel.mockResolvedValue(undefined);
    saveCloudProviderConfig.mockResolvedValue(undefined);
    fetchTrackedModels.mockResolvedValue([]);
    startInferenceModelPull.mockResolvedValue({ status: 'in_progress' });
    mockInvalidateQueries.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // A fake-timer test that fails before its own useRealTimers must not stall the ones after it.
    vi.useRealTimers();
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  });

  it('renders all apps in queued state initially', () => {
    const apps = [makeApp('nextcloud', 'Nextcloud', 'nextcloud:store1'), makeApp('gitea', 'Gitea', 'gitea:store1')];

    render(<InstallStep apps={apps} onComplete={onComplete} start={false} />);

    expect(screen.getByText('Nextcloud')).toBeInTheDocument();
    expect(screen.getByText('Gitea')).toBeInTheDocument();
    expect(screen.getAllByTestId('status-queued')).toHaveLength(2);
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

    render(<InstallStep apps={apps} onComplete={onComplete} start={false} />);

    expect(screen.getAllByText('Queued')).toHaveLength(2);
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

    // The step keeps asking about the app, so there is no last timer to run to.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(121_000);
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
        vllmApiKey: null,
        vllmUrl: null,
        omlxUrl: null,
        decodeEndpoint: null,
        encodeEndpoint: null,
      });
    });
  });

  it('installs oMLX for the Apple Silicon first-run set', async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };

    render(
      <InstallStep
        apps={[]}
        onComplete={onComplete}
        aiSetupConfig={{
          agentFrameworks: ['openclaw'],
          remoteAccess: [],
          selectedModels: [],
          installedCatalogIds: [],
          backend: 'omlx',
          cloudProviders: [],
          skipped: false,
        }}
      />,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('install_and_start_inference_runners_command', {
        backends: ['omlx', 'ollama'],
      });
    });
  });

  it('shows why a runner could not be set up, beside the count', async () => {
    const invoke = vi.fn(async (command: string) =>
      command === 'install_and_start_inference_runners_command'
        ? [
            { runner: 'ollama', state: 'failed', detail: 'Ollama installation failed: Error executing /tmp/.tmpX: Text file busy' },
            { runner: 'vllm', state: 'skipped', detail: 'Automatic Linux vLLM setup requires a working NVIDIA GPU.' },
            { runner: 'omlx', state: 'already_running', detail: 'not shown' },
          ]
        : null,
    );
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
    getInstalledApps.mockResolvedValue(sdkOk({ installed: [] }));

    render(
      <InstallStep
        apps={[]}
        onComplete={onComplete}
        aiSetupConfig={{
          agentFrameworks: [],
          remoteAccess: [],
          selectedModels: [],
          installedCatalogIds: [],
          backend: 'vllm',
          cloudProviders: [],
          skipped: false,
        }}
      />,
    );

    const reasons = await screen.findAllByTestId('inference-runner-reason');
    expect(reasons.map((node) => node.textContent)).toEqual([
      'Ollama installation failed: Error executing /tmp/.tmpX: Text file busy',
      'Automatic Linux vLLM setup requires a working NVIDIA GPU.',
    ]);
    expect(screen.getByTestId('inference-runners-phase')).toHaveTextContent('2 runner(s) unavailable on this machine');
  });

  it("shows a working runner's warning, and not its plain detail", async () => {
    const warning = 'The Hub could not give oMLX an API key, so it cannot download models through it yet: oMLX answered HTTP 503.';
    const invoke = vi.fn(async (command: string) =>
      command === 'install_and_start_inference_runners_command'
        ? [
            { runner: 'omlx', state: 'installed_and_started', detail: `oMLX was installed and started. ${warning}`, warning },
            { runner: 'ollama', state: 'already_running', detail: 'The runner is already reachable.' },
          ]
        : null,
    );
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
    getInstalledApps.mockResolvedValue(sdkOk({ installed: [] }));

    render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={runnerSetupConfig} />);

    expect((await screen.findAllByTestId('inference-runner-warning')).map((node) => node.textContent)).toEqual([warning]);
    expect(screen.queryByTestId('inference-runner-reason')).not.toBeInTheDocument();
  });

  it('shows the count once when a runner gives no reason', async () => {
    const invoke = vi.fn(async (command: string) =>
      command === 'install_and_start_inference_runners_command'
        ? [
            { runner: 'ollama', state: 'failed', detail: 'Ollama installation failed: exit code 1' },
            { runner: 'vllm', state: 'failed' },
          ]
        : null,
    );
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
    getInstalledApps.mockResolvedValue(sdkOk({ installed: [] }));

    render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={runnerSetupConfig} />);

    expect(await screen.findAllByTestId('inference-runner-reason')).toHaveLength(1);
    expect(screen.getByTestId('inference-runners-phase')).toHaveTextContent('2 runner(s) unavailable on this machine');
    expect(screen.queryByTestId('ai-phase-warning')).not.toBeInTheDocument();
  });

  it('keeps a long runner reason from pushing the rest of the step away', async () => {
    const invoke = vi.fn(async (command: string) =>
      command === 'install_and_start_inference_runners_command'
        ? [{ runner: 'ollama', state: 'failed', detail: `Ollama installation failed: stdout: ${'line\n'.repeat(5000)}` }]
        : null,
    );
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
    getInstalledApps.mockResolvedValue(sdkOk({ installed: [] }));

    render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={runnerSetupConfig} />);

    expect((await screen.findByTestId('inference-runner-reason')).className).toMatch(/max-h-\S+ overflow-y-auto/);
    expect(screen.getByTestId('inference-runner-reason').className).toContain('whitespace-pre-wrap');
  });

  it('opens a long runner reason at its end, where the cause is', async () => {
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(4000);
    try {
      const invoke = vi.fn(async (command: string) =>
        command === 'install_and_start_inference_runners_command'
          ? [{ runner: 'ollama', state: 'failed', detail: `Ollama installation failed: ${'line\n'.repeat(5000)}E: the cause` }]
          : null,
      );
      (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
      getInstalledApps.mockResolvedValue(sdkOk({ installed: [] }));

      render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={runnerSetupConfig} />);

      expect((await screen.findByTestId('inference-runner-reason')).scrollTop).toBe(4000);
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('says why when the desktop app rejects the runner request outright', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'install_and_start_inference_runners_command') throw 'Inference runner setup task failed: task was cancelled';
      return null;
    });
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
    getInstalledApps.mockResolvedValue(sdkOk({ installed: [] }));

    render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={runnerSetupConfig} />);

    expect(await screen.findByTestId('ai-phase-warning')).toHaveTextContent('Inference runner setup task failed: task was cancelled');
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
          vllmApiKey: null,
          vllmUrl: null,
          omlxUrl: null,
          decodeEndpoint: null,
          encodeEndpoint: null,
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
          vllmApiKey: null,
          vllmUrl: null,
          omlxUrl: null,
          decodeEndpoint: null,
          encodeEndpoint: null,
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

  describe('on oMLX', () => {
    const omlxConfig = {
      agentFrameworks: ['openclaw' as const],
      remoteAccess: [],
      selectedModels: ['qwen3-8b-mlx', 'nomic-embed-text'],
      // The pin list: oMLX loads a model on its first request, so only Ollama's embedder is pinned.
      ollamaSelectedModelIds: ['nomic-embed-text'],
      downloadModelIds: ['qwen3-8b-mlx', 'nomic-embed-text'],
      installedCatalogIds: [],
      backend: 'omlx' as const,
      cloudProviders: [],
      skipped: false,
    };

    beforeEach(() => {
      const invoke = vi.fn(async (command: string) =>
        command === 'install_and_start_inference_runners_command'
          ? [
              { runner: 'omlx', state: 'installed_and_started', endpointUrl: 'http://host.docker.internal:8000', apiKey: 'omlx-main-key' },
              { runner: 'ollama', state: 'already_running', endpointUrl: 'http://host.docker.internal:11434' },
            ]
          : null,
      );
      (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
    });

    it("saves the key the desktop app set for oMLX, then downloads oMLX's models and pins only Ollama's", async () => {
      fetchTrackedModels.mockResolvedValue([
        { catalogId: 'qwen3-8b-mlx', state: 'pulled' },
        { catalogId: 'nomic-embed-text', state: 'pulled' },
      ] as never);

      render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={omlxConfig} />);

      await waitFor(() => expect(pinInferenceModel).toHaveBeenCalledWith('nomic-embed-text'));
      expect(saveInferencePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ backend: 'omlx', omlxUrl: 'http://host.docker.internal:8000', omlxApiKey: 'omlx-main-key' }),
      );
      expect(startInferenceModelPull).toHaveBeenCalledWith('qwen3-8b-mlx', true);
      expect(startInferenceModelPull).toHaveBeenCalledWith('nomic-embed-text', true);
      // After the save: an oMLX download needs the key the save stores.
      expect(startInferenceModelPull.mock.invocationCallOrder[0]).toBeGreaterThan(
        saveInferencePreferences.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(pinInferenceModel).not.toHaveBeenCalledWith('qwen3-8b-mlx');
    });

    it("stores the key typed for an oMLX on another machine, never this Mac's", async () => {
      fetchTrackedModels.mockResolvedValue([] as never);

      render(
        <InstallStep
          apps={[]}
          onComplete={onComplete}
          aiSetupConfig={{ ...omlxConfig, omlxUrl: 'http://studio.lan:8000', omlxApiKey: 'studio-key' }}
        />,
      );

      await waitFor(() => expect(saveInferencePreferences).toHaveBeenCalled());
      expect(saveInferencePreferences).toHaveBeenCalledWith(expect.objectContaining({ omlxUrl: 'http://studio.lan:8000', omlxApiKey: 'studio-key' }));
      expect(saveInferencePreferences).not.toHaveBeenCalledWith(expect.objectContaining({ omlxApiKey: 'omlx-main-key' }));
    });

    it('marks a download the Hub refused to start as failed, with its reason, instead of waiting on it', async () => {
      const refusal = "oMLX refused to download mlx-community/Qwen3-8B-4bit: its admin API needs oMLX's API key.";
      startInferenceModelPull.mockImplementation(async (modelId: string) =>
        modelId === 'qwen3-8b-mlx' ? { status: 'error', reason: refusal } : { status: 'in_progress' },
      );
      fetchTrackedModels.mockResolvedValue([{ catalogId: 'nomic-embed-text', state: 'pulled' }] as never);

      render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={omlxConfig} />);

      expect(await screen.findByTitle(refusal)).toBeInTheDocument();
      await waitFor(() => expect(pinInferenceModel).toHaveBeenCalledWith('nomic-embed-text'));
    });
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
      await vi.advanceTimersByTimeAsync(65_000);
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

  /*
   * After a reset or a reinstall the Hub tracks nothing, though every model is still in Ollama. The pin
   * step pinned only tracked models, so it pinned nothing. Its row showed a check mark anyway.
   */
  describe('pinning models the engine already has', () => {
    const onDiskConfig = {
      agentFrameworks: ['openclaw' as const],
      remoteAccess: [],
      selectedModels: ['gemma3-270m', 'nomic-embed-text'],
      installedCatalogIds: ['gemma3-270m', 'nomic-embed-text'],
      backend: 'ollama' as const,
      cloudProviders: [],
      skipped: false,
    };

    it('pins a chosen model Ollama has even when this Hub does not track it', async () => {
      fetchTrackedModels.mockResolvedValue([]);

      render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={onDiskConfig} />);

      await waitFor(() => expect(pinInferenceModel).toHaveBeenCalledTimes(2));
      expect(pinInferenceModel).toHaveBeenCalledWith('gemma3-270m');
      expect(pinInferenceModel).toHaveBeenCalledWith('nomic-embed-text');
      await waitFor(() => expect(within(screen.getByTestId('pin-models-row')).getByText('✓')).toBeInTheDocument());
      expect(screen.queryByTestId('pin-models-failures')).not.toBeInTheDocument();
    });

    it('marks the row failed and names a model the Hub refused to pin', async () => {
      fetchTrackedModels.mockResolvedValue([]);
      pinInferenceModel.mockImplementation(async (modelId: string) => {
        if (modelId === 'nomic-embed-text') throw new Error("nomic-embed-text does not fit this node's pinned-model budget");
      });

      render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={onDiskConfig} />);

      const failures = await screen.findByTestId('pin-models-failures');
      expect(failures).toHaveTextContent("nomic-embed-text is not pinned: nomic-embed-text does not fit this node's pinned-model budget");
      // One refusal is said on its line: there is nothing to say once.
      expect(screen.queryByTestId('pin-models-refusal')).not.toBeInTheDocument();
      const row = screen.getByTestId('pin-models-row');
      expect(within(row).getByText('✕')).toBeInTheDocument();
      expect(within(row).queryByText('✓')).not.toBeInTheDocument();
    });

    it('says a refusal the Hub gave every model once, above the list, instead of on each line', async () => {
      const unknownVram =
        "The Hub doesn't know this GPU's memory yet (VRAM Unknown), so it can't tell whether a pinned model fits. " +
        'Restart the desktop app or run cihub up so the Hub can read it (nvidia-smi on the host), then pin again.';
      fetchTrackedModels.mockResolvedValue([]);
      pinInferenceModel.mockRejectedValue(new Error(unknownVram));

      render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={onDiskConfig} />);

      const failures = await screen.findByTestId('pin-models-failures');
      expect(within(failures).getAllByText(unknownVram)).toHaveLength(1);
      expect(screen.getByTestId('pin-models-refusal')).toHaveTextContent(unknownVram);
      expect(
        within(failures)
          .getAllByRole('listitem')
          .map((line) => line.textContent),
      ).toEqual(['gemma3-270m is not pinned.', 'nomic-embed-text is not pinned.']);
    });

    it('keeps each reason on its line when the Hub refused the models for different reasons', async () => {
      fetchTrackedModels.mockResolvedValue([]);
      pinInferenceModel.mockImplementation(async (modelId: string) => {
        throw new Error(`Pinning ${modelId} would use more than the pinned-model budget`);
      });

      render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={onDiskConfig} />);

      const failures = await screen.findByTestId('pin-models-failures');
      expect(screen.queryByTestId('pin-models-refusal')).not.toBeInTheDocument();
      expect(
        within(failures)
          .getAllByRole('listitem')
          .map((line) => line.textContent),
      ).toEqual([
        'gemma3-270m is not pinned: Pinning gemma3-270m would use more than the pinned-model budget',
        'nomic-embed-text is not pinned: Pinning nomic-embed-text would use more than the pinned-model budget',
      ]);
    });

    it("says the Hub's shared refusal once and keeps the step's own reason on a model whose download failed", async () => {
      const unknownVram = "The Hub doesn't know this GPU's memory yet (VRAM Unknown), so it can't tell whether a pinned model fits.";
      vi.useFakeTimers();
      let gemma26b: Record<string, unknown> = { catalogId: 'gemma4-26b', state: 'pulling', pullProgress: 30 };
      fetchTrackedModels.mockImplementation(async () => [gemma26b]);
      pinInferenceModel.mockRejectedValue(new Error(unknownVram));

      render(
        <InstallStep
          apps={[]}
          onComplete={onComplete}
          aiSetupConfig={{ ...onDiskConfig, selectedModels: ['gemma3-270m', 'nomic-embed-text', 'gemma4-26b'] }}
        />,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(65_000);
      });
      // A download that is still running is not a failed pin: it is not listed, and the row is still in progress.
      const listed = () =>
        within(screen.getByTestId('pin-models-failures'))
          .getAllByRole('listitem')
          .map((line) => line.textContent);
      expect(screen.getByTestId('pin-models-refusal')).toHaveTextContent(unknownVram);
      expect(listed()).toEqual(['gemma3-270m is not pinned.', 'nomic-embed-text is not pinned.']);
      expect(within(screen.getByTestId('pin-models-row')).getByText('●')).toBeInTheDocument();

      gemma26b = { catalogId: 'gemma4-26b', state: 'error', errorMessage: 'disk full' };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(screen.getByTestId('pin-models-refusal')).toHaveTextContent(unknownVram);
      expect(listed()).toEqual(['gemma3-270m is not pinned.', 'nomic-embed-text is not pinned.', 'gemma4-26b is not pinned: its download failed.']);
      expect(within(screen.getByTestId('pin-models-row')).getByText('✕')).toBeInTheDocument();
    });

    it('keeps the pin row in progress, with nothing failed, while a chosen model is still downloading', async () => {
      vi.useFakeTimers();
      fetchTrackedModels.mockResolvedValue([{ catalogId: 'gemma4-26b', state: 'pulling', pullProgress: 30 }] as never);

      render(
        <InstallStep
          apps={[]}
          onComplete={onComplete}
          aiSetupConfig={{ ...onDiskConfig, selectedModels: ['gemma3-270m', 'gemma4-26b'], installedCatalogIds: ['gemma3-270m'] }}
        />,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(65_000);
      });

      expect(screen.queryByTestId('pin-models-failures')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('pin-models-row')).getByText('●')).toBeInTheDocument();
      expect(pinInferenceModel).toHaveBeenCalledWith('gemma3-270m');
      expect(pinInferenceModel).not.toHaveBeenCalledWith('gemma4-26b');
    });
  });

  it('keeps the chosen model when its pull is still running after the wait', async () => {
    vi.useFakeTimers();
    fetchTrackedModels.mockResolvedValue([{ catalogId: 'llama3-3-70b', state: 'pulling', pullProgress: 40 }] as never);

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
          preferredModelId: 'llama3-3-70b',
          skipped: false,
        }}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(saveInferencePreferences).toHaveBeenCalledWith(expect.objectContaining({ model: 'llama3-3-70b' }));
    });
  });

  it('saves the chat model again once it leaves the download queue behind the embedder', async () => {
    vi.useFakeTimers();
    // The Hub pulls one model at a time, and a queued one has no tracked row until its turn.
    const chatPulling = [
      { catalogId: 'nomic-embed-text', state: 'pulled' },
      { catalogId: 'llama3-3-70b', state: 'pulling', pullProgress: 5 },
    ];
    fetchTrackedModels
      .mockResolvedValueOnce([{ catalogId: 'nomic-embed-text', state: 'pulling', pullProgress: 50 }] as never)
      .mockResolvedValueOnce(chatPulling as never)
      .mockResolvedValueOnce(chatPulling as never)
      .mockResolvedValue([
        { catalogId: 'nomic-embed-text', state: 'pulled' },
        { catalogId: 'llama3-3-70b', state: 'pulled' },
      ] as never);

    render(
      <InstallStep
        apps={[]}
        onComplete={onComplete}
        aiSetupConfig={{
          agentFrameworks: ['openclaw'],
          remoteAccess: [],
          selectedModels: ['nomic-embed-text', 'llama3-3-70b'],
          installedCatalogIds: [],
          backend: 'ollama',
          cloudProviders: [],
          preferredModelId: 'llama3-3-70b',
          preferredEmbeddingModelId: 'nomic-embed-text',
          skipped: false,
        }}
      />,
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();

    await waitFor(() => expect(saveInferencePreferences).toHaveBeenCalledTimes(2));
    expect(saveInferencePreferences.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ model: null, embeddingModel: 'nomic-embed-text' }));
    // Only the defaults: the URLs and keys the first save stored stay as they are.
    expect(saveInferencePreferences.mock.calls[1]?.[0]).toEqual({
      backend: 'ollama',
      model: 'llama3-3-70b',
      embeddingModel: 'nomic-embed-text',
      visionModel: null,
    });
  });

  it('keeps the first save when Continue is pressed before the queued model is tracked', async () => {
    vi.useFakeTimers();
    fetchTrackedModels.mockResolvedValueOnce([{ catalogId: 'nomic-embed-text', state: 'pulling', pullProgress: 50 }] as never).mockResolvedValue([
      { catalogId: 'nomic-embed-text', state: 'pulled' },
      { catalogId: 'llama3-3-70b', state: 'pulling', pullProgress: 5 },
    ] as never);

    const { unmount } = render(
      <InstallStep
        apps={[]}
        onComplete={onComplete}
        aiSetupConfig={{
          agentFrameworks: ['openclaw'],
          remoteAccess: [],
          selectedModels: ['nomic-embed-text', 'llama3-3-70b'],
          installedCatalogIds: [],
          backend: 'ollama',
          cloudProviders: [],
          preferredModelId: 'llama3-3-70b',
          preferredEmbeddingModelId: 'nomic-embed-text',
          skipped: false,
        }}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(saveInferencePreferences).toHaveBeenCalledTimes(1);

    // Continue takes the wizard to Home. The wait stops there, so nothing writes the defaults again.
    unmount();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();

    expect(saveInferencePreferences).toHaveBeenCalledTimes(1);
  });

  it('keeps following the apps when a prop changes while the install runs', async () => {
    getInstalledApps
      .mockResolvedValueOnce(sdkOk({ installed: [] }))
      .mockResolvedValue(sdkOk({ installed: [{ info: { urn: 'app1:store1' }, app: { status: 'running' } }] }));
    let finishInstall: ((value: unknown) => void) | undefined;
    installApp.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInstall = resolve;
        }),
    );
    const apps = [makeApp('app1', 'App One', 'app1:store1')];

    const { rerender } = render(<InstallStep apps={apps} onComplete={onComplete} defaultExposureMode="local" />);
    await waitFor(() => expect(finishInstall).toBeDefined());
    // Cloudflare comes up mid-install, so the wizard passes a new exposure mode.
    rerender(<InstallStep apps={apps} onComplete={onComplete} defaultExposureMode="cloudflare" />);
    await act(async () => {
      finishInstall?.(sdkOk({}));
    });

    expect(await screen.findByTestId('status-running', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(installApp).toHaveBeenCalledTimes(1);
  });

  describe('a model that is still downloading', () => {
    const downloadingConfig = {
      agentFrameworks: [],
      remoteAccess: [],
      selectedModels: ['gemma3-270m'],
      installedCatalogIds: [],
      backend: 'ollama' as const,
      cloudProviders: [],
      preferredModelId: 'gemma3-270m',
      skipped: false,
    };
    const excalidraw = makeApp('excalidraw', 'Excalidraw', 'excalidraw:store1');

    beforeEach(() => {
      fetchTrackedModels.mockResolvedValue([{ catalogId: 'gemma3-270m', state: 'pulling', pullProgress: 10 }] as never);
    });

    it('asks for the apps without waiting for it, after saving the settings they are installed with', async () => {
      render(<InstallStep apps={[excalidraw]} onComplete={onComplete} aiSetupConfig={downloadingConfig} />);

      expect(await screen.findByText('10%')).toBeInTheDocument();
      await waitFor(() => expect(installApp).toHaveBeenCalledWith(expect.objectContaining({ path: { urn: 'excalidraw:store1' } })));
      // An AI app gets its inference config when its install starts, so the choice is saved first.
      expect(saveInferencePreferences).toHaveBeenCalledWith(expect.objectContaining({ backend: 'ollama', model: 'gemma3-270m' }));
      expect(saveInferencePreferences.mock.invocationCallOrder[0]).toBeLessThan(installApp.mock.invocationCallOrder[0] ?? 0);
    });

    it('still follows the apps to the end when the download poll cannot reach the Hub', async () => {
      getInstalledApps
        .mockResolvedValueOnce(sdkOk({ installed: [] }))
        .mockResolvedValue(sdkOk({ installed: [{ info: { urn: 'excalidraw:store1' }, app: { status: 'running' } }] }));
      fetchTrackedModels
        .mockResolvedValueOnce([{ catalogId: 'gemma3-270m', state: 'pulling', pullProgress: 10 }] as never)
        .mockRejectedValue(new Error('Network error'));

      render(<InstallStep apps={[excalidraw]} onComplete={onComplete} aiSetupConfig={downloadingConfig} />);

      expect(await screen.findByTestId('status-running', {}, { timeout: 5000 })).toBeInTheDocument();
      // The download poll keeps asking until the Hub answers, so only the AI setup carries on.
      expect(screen.getByTestId('install-continue-btn')).toHaveTextContent('Continue (AI setup in background)');
    });

    it('still installs the apps when Continue is pressed during the download', async () => {
      const { unmount } = render(<InstallStep apps={[excalidraw]} onComplete={onComplete} aiSetupConfig={downloadingConfig} />);
      expect(await screen.findByText('10%')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('install-continue-btn'));
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ continuedInBackground: true }));
      // Continue takes the wizard to Home, which unmounts the step.
      unmount();

      await waitFor(() => expect(installApp).toHaveBeenCalledWith(expect.objectContaining({ path: { urn: 'excalidraw:store1' } })));
    });
  });

  it('still installs the apps when Continue is pressed while the desktop app sets up the engine', async () => {
    let finishRunners: ((results: unknown) => void) | undefined;
    const invoke = vi.fn(
      () =>
        new Promise((resolve) => {
          finishRunners = resolve;
        }),
    );
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };

    const { unmount } = render(
      <InstallStep
        apps={[makeApp('excalidraw', 'Excalidraw', 'excalidraw:store1')]}
        onComplete={onComplete}
        aiSetupConfig={{
          agentFrameworks: [],
          remoteAccess: [],
          selectedModels: [],
          installedCatalogIds: [],
          backend: 'ollama',
          cloudProviders: [],
          skipped: false,
        }}
      />,
    );
    await waitFor(() => expect(finishRunners).toBeDefined());

    fireEvent.click(screen.getByTestId('install-continue-btn'));
    unmount();
    await act(async () => {
      finishRunners?.([{ runner: 'ollama', state: 'already_running', endpointUrl: 'http://127.0.0.1:11434' }]);
    });

    await waitFor(() => expect(installApp).toHaveBeenCalledWith(expect.objectContaining({ path: { urn: 'excalidraw:store1' } })));
    expect(saveInferencePreferences).toHaveBeenCalledWith(expect.objectContaining({ backend: 'ollama' }));
  });

  it('asks for each app once when the step closes and comes back before the request goes out', async () => {
    let finishRunners: ((results: unknown) => void) | undefined;
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: vi.fn(
        () =>
          new Promise((resolve) => {
            finishRunners = resolve;
          }),
      ),
    };
    const excalidraw = makeApp('excalidraw', 'Excalidraw', 'excalidraw:store1');
    const config = {
      agentFrameworks: [],
      remoteAccess: [],
      selectedModels: [],
      installedCatalogIds: [],
      backend: 'ollama' as const,
      cloudProviders: [],
      skipped: false,
    };

    const first = render(<InstallStep apps={[excalidraw]} onComplete={onComplete} aiSetupConfig={config} />);
    await waitFor(() => expect(finishRunners).toBeDefined());
    // Back and Forward in the browser: the wizard comes back from the saved session while the first
    // pass still waits on the engine, and that pass still sends its request afterwards.
    first.unmount();
    render(<InstallStep apps={[excalidraw]} onComplete={onComplete} aiSetupConfig={config} resume />);
    expect(await screen.findByTestId('status-installing')).toBeInTheDocument();

    await act(async () => {
      finishRunners?.([{ runner: 'ollama', state: 'already_running', endpointUrl: 'http://127.0.0.1:11434' }]);
    });
    // Each pass saves the preferences once; the first pass's save comes right before its request.
    await waitFor(() => expect(saveInferencePreferences).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(installApp).toHaveBeenCalledTimes(1);
    expect(installApp).toHaveBeenCalledWith(expect.objectContaining({ path: { urn: 'excalidraw:store1' } }));
  });

  it('does not ask again for an install this tab already started', async () => {
    claimOnboardingInstallUrn('plane:store1');
    getInstalledApps.mockResolvedValue(
      sdkOk({
        installed: [
          {
            info: { urn: 'plane:store1', name: 'Plane' },
            app: { status: 'installing' },
          },
        ],
      }),
    );

    render(<InstallStep apps={[makeApp('plane', 'Plane', 'plane:store1')]} onComplete={onComplete} />);

    expect(await screen.findByTestId('status-installing')).toBeInTheDocument();
    expect(installApp).not.toHaveBeenCalled();
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
    getInstalledApps.mockResolvedValueOnce(sdkOk({ installed: [] })).mockResolvedValue(
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
    getInstalledApps.mockResolvedValueOnce(sdkOk({ installed: [] })).mockResolvedValue(
      sdkOk({
        installed: [
          {
            info: { urn: 'ci-memory:store1', name: 'CI Memory' },
            app: { status: 'running' },
          },
        ],
      }),
    );

    const app: OnboardingApp = {
      ...makeApp('ci-memory', 'CI Memory', 'ci-memory:store1'),
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
    getInstalledApps.mockResolvedValueOnce(sdkOk({ installed: [] })).mockResolvedValue(
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

  /*
   * The step used to watch the downloads for 60 s and the apps for 120 s. A model already on disk was left out of
   * the progress and read "Queued", a download still running fell back to "Queued" and failed its pin, and an app
   * that came up later never turned Running.
   */
  describe('following the downloads and the apps to the end', () => {
    const hermes = makeApp('ci-hermes', 'Hermes', 'ci-hermes:store1');
    const modelRow = (modelId: string) => screen.getByTestId(`model-row-${modelId}`);
    const pinRow = () => screen.getByTestId('pin-models-row');
    const advance = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    const modelConfig = (selectedModels: string[], installedCatalogIds: string[]) => ({
      agentFrameworks: ['hermes' as const],
      remoteAccess: [],
      selectedModels,
      installedCatalogIds,
      backend: 'ollama' as const,
      cloudProviders: [],
      skipped: false,
    });
    const hermesIs = (status: string) => sdkOk({ installed: [{ info: { urn: 'ci-hermes:store1' }, app: { status } }] });

    it('shows a model the engine already had as downloaded from the first frame to the last', async () => {
      vi.useFakeTimers();
      let gemma12b: Record<string, unknown> = { catalogId: 'gemma4-12b', state: 'pulling', pullProgress: 40 };
      fetchTrackedModels.mockImplementation(async () => [gemma12b]);
      getInstalledApps.mockResolvedValueOnce(sdkOk({ installed: [] })).mockResolvedValue(hermesIs('running'));
      const onDisk = ['gemma4-26b', 'nomic-embed-text'];

      render(
        <InstallStep apps={[hermes]} onComplete={onComplete} aiSetupConfig={modelConfig(['gemma4-26b', 'nomic-embed-text', 'gemma4-12b'], onDisk)} />,
      );

      for (const modelId of onDisk) {
        expect(modelRow(modelId)).toHaveTextContent('Downloaded');
        expect(within(modelRow(modelId)).getByText('✓')).toBeInTheDocument();
      }

      await advance(5_000);
      expect(modelRow('gemma4-12b')).toHaveTextContent('Downloading...');
      expect(modelRow('gemma4-12b')).toHaveTextContent('40%');
      for (const modelId of onDisk) {
        expect(modelRow(modelId)).toHaveTextContent('Downloaded');
        expect(modelRow(modelId)).not.toHaveTextContent(/Queued|Downloading|Installing/);
      }

      gemma12b = { catalogId: 'gemma4-12b', state: 'pulled' };
      await advance(2_000);

      expect(screen.getByText('Installation Complete')).toBeInTheDocument();
      for (const modelId of [...onDisk, 'gemma4-12b']) {
        expect(modelRow(modelId)).toHaveTextContent('Downloaded');
        expect(modelRow(modelId)).not.toHaveTextContent('Queued');
        expect(pinInferenceModel).toHaveBeenCalledWith(modelId);
      }
      expect(within(pinRow()).getByText('✓')).toBeInTheDocument();
    });

    it('follows a download that takes longer than a minute, then pins it once it lands', async () => {
      vi.useFakeTimers();
      let progress = 5;
      fetchTrackedModels.mockImplementation(async () => [
        progress >= 100 ? { catalogId: 'gemma4-12b', state: 'pulled' } : { catalogId: 'gemma4-12b', state: 'pulling', pullProgress: progress },
      ]);

      render(
        <InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={{ ...modelConfig(['gemma4-12b'], []), preferredModelId: 'gemma4-12b' }} />,
      );

      await advance(30_000);
      progress = 70;
      await advance(45_000);

      expect(modelRow('gemma4-12b')).toHaveTextContent('Downloading...');
      expect(modelRow('gemma4-12b')).toHaveTextContent('70%');
      expect(modelRow('gemma4-12b')).not.toHaveTextContent('Queued');
      expect(within(pinRow()).getByText('●')).toBeInTheDocument();
      expect(screen.queryByTestId('pin-models-failures')).not.toBeInTheDocument();
      expect(screen.queryByTestId('ai-phase-warning')).not.toBeInTheDocument();
      expect(pinInferenceModel).not.toHaveBeenCalled();
      expect(screen.getByTestId('install-continue-btn')).toHaveTextContent('Continue (AI setup in background)');

      progress = 100;
      await advance(2_000);

      expect(pinInferenceModel).toHaveBeenCalledWith('gemma4-12b');
      expect(modelRow('gemma4-12b')).toHaveTextContent('Downloaded');
      expect(within(pinRow()).getByText('✓')).toBeInTheDocument();
      expect(screen.queryByTestId('pin-models-failures')).not.toBeInTheDocument();
      expect(screen.getByTestId('install-continue-btn')).toHaveTextContent(/^Continue$/);
    });

    it.each([
      ['running', 'status-running', 'Running'],
      ['install_failed', 'status-failed', 'Install failed - retry from My Apps'],
    ])('turns an app the Hub reports as %s after the confirm window', async (hubStatus, testId, text) => {
      vi.useFakeTimers();
      let status = 'installing';
      getInstalledApps.mockResolvedValueOnce(sdkOk({ installed: [] })).mockImplementation(async () => hermesIs(status));

      render(<InstallStep apps={[hermes]} onComplete={onComplete} />);

      await advance(121_000);
      expect(screen.getByTestId('status-incomplete')).toBeInTheDocument();
      expect(screen.getByText('Install started but not yet confirmed running')).toBeInTheDocument();
      expect(screen.getByText('Installing Apps')).toBeInTheDocument();

      status = hubStatus;
      // Past the confirm window the app is asked about every 5 s.
      await advance(6_000);

      expect(screen.getByTestId(testId)).toBeInTheDocument();
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.queryByText('Install started but not yet confirmed running')).not.toBeInTheDocument();
      expect(screen.getByText('Installation Complete')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('install-continue-btn'));
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ continuedInBackground: false, incomplete: 0 }));
    });

    it('keeps polling when a status request never answers', async () => {
      vi.useFakeTimers();
      getInstalledApps
        .mockResolvedValueOnce(sdkOk({ installed: [] }))
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValue(hermesIs('running'));
      fetchTrackedModels
        .mockResolvedValueOnce([{ catalogId: 'gemma4-12b', state: 'pulling', pullProgress: 50 }] as never)
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValue([{ catalogId: 'gemma4-12b', state: 'pulled' }] as never);

      render(<InstallStep apps={[hermes]} onComplete={onComplete} aiSetupConfig={modelConfig(['gemma4-12b'], [])} />);

      await advance(10_000);
      expect(screen.getByTestId('status-installing')).toBeInTheDocument();
      expect(pinInferenceModel).not.toHaveBeenCalled();

      await advance(10_000);
      expect(screen.getByTestId('status-running')).toBeInTheDocument();
      expect(pinInferenceModel).toHaveBeenCalledWith('gemma4-12b');
      expect(modelRow('gemma4-12b')).toHaveTextContent('Downloaded');
    });

    it('saves a chat model as the default once it starts pulling, before its download finishes', async () => {
      vi.useFakeTimers();
      // The Hub pulls one model at a time, so the chat model has no tracked row while the embedder downloads.
      let embedderFirst = true;
      fetchTrackedModels.mockImplementation(async () =>
        embedderFirst
          ? [{ catalogId: 'nomic-embed-text', state: 'pulling', pullProgress: 50 }]
          : [
              { catalogId: 'nomic-embed-text', state: 'pulled' },
              { catalogId: 'llama3-3-70b', state: 'pulling', pullProgress: 5 },
            ],
      );

      render(
        <InstallStep
          apps={[]}
          onComplete={onComplete}
          aiSetupConfig={{
            ...modelConfig(['nomic-embed-text', 'llama3-3-70b'], []),
            preferredModelId: 'llama3-3-70b',
            preferredEmbeddingModelId: 'nomic-embed-text',
          }}
        />,
      );

      await advance(29_000);
      expect(saveInferencePreferences).toHaveBeenCalledTimes(1);
      expect(saveInferencePreferences.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ model: null, embeddingModel: 'nomic-embed-text' }));

      embedderFirst = false;
      await advance(2_000);

      expect(saveInferencePreferences).toHaveBeenCalledTimes(2);
      expect(saveInferencePreferences.mock.calls[1]?.[0]).toEqual({
        backend: 'ollama',
        model: 'llama3-3-70b',
        embeddingModel: 'nomic-embed-text',
        visionModel: null,
      });
      expect(modelRow('llama3-3-70b')).toHaveTextContent('Downloading...');

      // Saved once, not on every poll that sees the same choice.
      await advance(60_000);
      expect(saveInferencePreferences).toHaveBeenCalledTimes(2);
    });

    it('keeps a saved default whose download fails until the other downloads settle', async () => {
      vi.useFakeTimers();
      let chat: Record<string, unknown> = { catalogId: 'chat-model', state: 'pulling', pullProgress: 10 };
      let vision: Record<string, unknown> = { catalogId: 'vision-model', state: 'pulling', pullProgress: 10 };
      fetchTrackedModels.mockImplementation(async () => [chat, vision]);

      render(
        <InstallStep
          apps={[]}
          onComplete={onComplete}
          aiSetupConfig={{
            ...modelConfig(['chat-model', 'vision-model'], []),
            preferredModelId: 'chat-model',
            preferredVisionModelId: 'vision-model',
          }}
        />,
      );

      await advance(5_000);
      expect(saveInferencePreferences).toHaveBeenCalledTimes(1);
      expect(saveInferencePreferences.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ model: 'chat-model', visionModel: 'vision-model' }));

      vision = { catalogId: 'vision-model', state: 'error', errorMessage: 'disk full' };
      await advance(10_000);
      expect(saveInferencePreferences).toHaveBeenCalledTimes(1);

      chat = { catalogId: 'chat-model', state: 'pulled' };
      await advance(2_000);
      expect(saveInferencePreferences).toHaveBeenCalledTimes(2);
      expect(saveInferencePreferences.mock.calls[1]?.[0]).toEqual({
        backend: 'ollama',
        model: 'chat-model',
        embeddingModel: null,
        visionModel: null,
      });
    });

    it('treats a download the Hub refused to start as failed, so the pins can finish', async () => {
      vi.useFakeTimers();
      fetchTrackedModels.mockResolvedValue([{ catalogId: 'gemma4-12b', state: 'pulled' }] as never);
      getInstalledApps.mockResolvedValueOnce(sdkOk({ installed: [] })).mockResolvedValue(hermesIs('running'));
      const apps = [hermes];
      const config = modelConfig(['gemma4-12b', 'gemma4-26b'], []);

      const { rerender } = render(<InstallStep apps={apps} onComplete={onComplete} aiSetupConfig={config} />);
      await advance(5_000);
      // Never tracked, and the page has not heard the refusal yet: as far as the step knows it is still coming.
      expect(modelRow('gemma4-26b')).toHaveTextContent('Downloading...');
      expect(within(pinRow()).getByText('●')).toBeInTheDocument();

      const refusal = 'Not enough free disk space to download gemma4-26b.';
      rerender(<InstallStep apps={apps} onComplete={onComplete} aiSetupConfig={config} pullErrorsById={{ 'gemma4-26b': refusal }} />);
      await advance(2_000);

      expect(modelRow('gemma4-26b')).toHaveTextContent('Failed');
      expect(within(modelRow('gemma4-26b')).getByText('Skipped')).toHaveAttribute('title', refusal);
      expect(screen.getByTestId('pin-models-failures')).toHaveTextContent('gemma4-26b is not pinned: its download failed.');
      expect(within(pinRow()).getByText('✕')).toBeInTheDocument();
      expect(pinInferenceModel).toHaveBeenCalledWith('gemma4-12b');
      expect(pinInferenceModel).not.toHaveBeenCalledWith('gemma4-26b');
      expect(screen.getByText('Installation Complete')).toBeInTheDocument();
    });

    it('asks about an unconfirmed app and a long download every 5 s instead of every second', async () => {
      vi.useFakeTimers();
      fetchTrackedModels.mockResolvedValue([{ catalogId: 'gemma4-12b', state: 'pulling', pullProgress: 10 }] as never);
      getInstalledApps.mockResolvedValueOnce(sdkOk({ installed: [] })).mockResolvedValue(hermesIs('installing'));
      const readsDuring = async (ms: number) => {
        const models = fetchTrackedModels.mock.calls.length;
        const apps = getInstalledApps.mock.calls.length;
        await advance(ms);
        return { models: fetchTrackedModels.mock.calls.length - models, apps: getInstalledApps.mock.calls.length - apps };
      };

      render(<InstallStep apps={[hermes]} onComplete={onComplete} aiSetupConfig={modelConfig(['gemma4-12b'], [])} />);
      await advance(60_000);

      const early = await readsDuring(50_000);
      expect(early.models).toBeGreaterThanOrEqual(49);
      expect(early.apps).toBeGreaterThanOrEqual(49);

      await advance(20_000);
      const late = await readsDuring(50_000);
      expect(late.models).toBeGreaterThanOrEqual(9);
      expect(late.models).toBeLessThanOrEqual(11);
      expect(late.apps).toBeGreaterThanOrEqual(9);
      expect(late.apps).toBeLessThanOrEqual(11);
    });

    it('stops asking the Hub once the step is gone', async () => {
      vi.useFakeTimers();
      fetchTrackedModels.mockResolvedValue([{ catalogId: 'gemma4-12b', state: 'pulling', pullProgress: 10 }] as never);
      getInstalledApps.mockResolvedValueOnce(sdkOk({ installed: [] })).mockResolvedValue(hermesIs('installing'));

      const { unmount } = render(<InstallStep apps={[hermes]} onComplete={onComplete} aiSetupConfig={modelConfig(['gemma4-12b'], [])} />);
      await advance(5_000);
      expect(fetchTrackedModels.mock.calls.length).toBeGreaterThan(2);
      expect(getInstalledApps.mock.calls.length).toBeGreaterThan(2);

      unmount();
      const modelReads = fetchTrackedModels.mock.calls.length;
      const appReads = getInstalledApps.mock.calls.length;
      await advance(180_000);

      expect(fetchTrackedModels).toHaveBeenCalledTimes(modelReads);
      expect(getInstalledApps).toHaveBeenCalledTimes(appReads);
    });

    it('fails a download the Hub never started once nothing has downloaded for a minute', async () => {
      vi.useFakeTimers();
      // The Hub refused it when its turn came, so it was never tracked, and the page heard only "queued".
      let gemma12b: Record<string, unknown> = { catalogId: 'gemma4-12b', state: 'pulling', pullProgress: 50 };
      fetchTrackedModels.mockImplementation(async () => [gemma12b]);

      render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={modelConfig(['gemma4-12b', 'gemma4-26b'], [])} />);

      // Queued behind a running download, it is still on its way.
      await advance(90_000);
      expect(modelRow('gemma4-26b')).toHaveTextContent('Downloading...');

      gemma12b = { catalogId: 'gemma4-12b', state: 'pulled' };
      await advance(30_000);
      expect(modelRow('gemma4-26b')).toHaveTextContent('Downloading...');
      expect(within(pinRow()).getByText('●')).toBeInTheDocument();

      await advance(40_000);
      expect(modelRow('gemma4-26b')).toHaveTextContent('Failed');
      expect(screen.getByTestId('pin-models-failures')).toHaveTextContent('gemma4-26b is not pinned: its download failed.');
      expect(pinInferenceModel).toHaveBeenCalledWith('gemma4-12b');
      expect(screen.getByTestId('install-progress-text')).toHaveTextContent('AI setup complete.');
    });

    it("does not read a landed model's failed load as a failed download", async () => {
      vi.useFakeTimers();
      let gemma12b: Record<string, unknown> = { catalogId: 'gemma4-12b', state: 'pulled' };
      const gemma26b = { catalogId: 'gemma4-26b', state: 'pulling', pullProgress: 20 };
      fetchTrackedModels.mockImplementation(async () => [gemma12b, gemma26b]);
      pinInferenceModel.mockImplementation(async (modelId: string) => {
        if (modelId === 'gemma4-12b') {
          gemma12b = { catalogId: 'gemma4-12b', state: 'error', errorMessage: 'out of memory' };
          throw new Error('out of memory');
        }
      });

      render(<InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={modelConfig(['gemma4-12b', 'gemma4-26b'], [])} />);
      await advance(5_000);

      expect(modelRow('gemma4-12b')).toHaveTextContent('Downloaded');
      expect(screen.queryByTestId('ai-phase-warning')).not.toBeInTheDocument();
      expect(screen.getByTestId('pin-models-failures')).toHaveTextContent('gemma4-12b is not pinned: out of memory');
    });

    it('stops following an app the Hub lists as stopped once the confirm window has passed', async () => {
      vi.useFakeTimers();
      getInstalledApps.mockResolvedValueOnce(sdkOk({ installed: [] })).mockResolvedValue(hermesIs('stopped'));

      render(<InstallStep apps={[hermes]} onComplete={onComplete} />);
      await advance(60_000);
      expect(screen.getByTestId('status-installing')).toBeInTheDocument();

      await advance(70_000);
      expect(screen.getByTestId('status-incomplete')).toBeInTheDocument();
      expect(screen.getByText('Installation Complete')).toBeInTheDocument();
      const reads = getInstalledApps.mock.calls.length;
      await advance(60_000);
      expect(getInstalledApps).toHaveBeenCalledTimes(reads);
    });

    it('saves the settled defaults again after a save mid-way failed', async () => {
      vi.useFakeTimers();
      let chat: Record<string, unknown> | null = null;
      fetchTrackedModels.mockImplementation(async () => [
        { catalogId: 'nomic-embed-text', state: 'pulling', pullProgress: 50 },
        ...(chat ? [chat] : []),
      ]);

      render(
        <InstallStep
          apps={[]}
          onComplete={onComplete}
          aiSetupConfig={{
            ...modelConfig(['nomic-embed-text', 'llama3-3-70b'], []),
            preferredModelId: 'llama3-3-70b',
          }}
        />,
      );
      await advance(3_000);
      expect(saveInferencePreferences).toHaveBeenCalledTimes(1);

      saveInferencePreferences.mockRejectedValueOnce(new Error('Hub restarting'));
      chat = { catalogId: 'llama3-3-70b', state: 'pulling', pullProgress: 5 };
      await advance(10_000);
      expect(saveInferencePreferences).toHaveBeenCalledTimes(2);

      chat = { catalogId: 'llama3-3-70b', state: 'pulled' };
      fetchTrackedModels.mockImplementation(async () => [{ catalogId: 'nomic-embed-text', state: 'pulled' }, chat]);
      await advance(2_000);
      expect(saveInferencePreferences).toHaveBeenCalledTimes(3);
      expect(saveInferencePreferences.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ model: 'llama3-3-70b' }));
    });
  });
});
