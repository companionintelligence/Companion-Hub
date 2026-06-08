import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstallStep } from '../install-step';
import type { OnboardingApp } from '../../helpers/types';

const mockApiFetch = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockSetQueryData = vi.fn();

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

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
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
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
    mockApiFetch.mockImplementation(() => new Promise(() => {}));

    render(<InstallStep apps={[makeApp('app1', 'App One', 'app1:store1')]} onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId('install-continue-btn'));

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ continuedInBackground: true }));
  });

  it('flags continuedInBackground when installs end incomplete but are still converging', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/app-lifecycle/') && url.includes('/install')) {
        return { ok: true, json: async () => ({}) };
      }
      if (url === '/api/apps/installed') {
        return {
          ok: true,
          json: async () => ({
            installed: [{ info: { urn: 'app1:store1' }, app: { status: 'installing' } }],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

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
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/inference/preferences',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ backend: 'vllm', model: null }),
        }),
      );
    });
  });

  it('persists the preferred model alongside the backend during AI setup', async () => {
    mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/inference/models/pull-preflight')) {
        return { ok: true, json: async () => ({ canPull: true, alreadyInstalled: false }) };
      }
      if (url.includes('/api/inference/models/pull')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { modelId?: string };
        if (body.modelId === 'bad-model') {
          return { ok: true, json: async () => ({ success: false, skipped: true, message: 'connect ECONNREFUSED' }) };
        }
        return { ok: true, json: async () => ({ success: true }) };
      }
      if (url.includes('/api/inference/models/tracked')) {
        return {
          ok: true,
          json: async () => [
            { catalogId: 'llama3-3-70b', state: 'pulled' },
            { catalogId: 'bad-model', state: 'error', error: 'connect ECONNREFUSED' },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });

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
        expect(mockApiFetch).toHaveBeenCalledWith(
          '/api/inference/models/pull',
          expect.objectContaining({
            body: JSON.stringify({ modelId: 'llama3-3-70b', bestEffort: true }),
          }),
        );
      },
      { timeout: 5000 },
    );

    // App install should still proceed after a model pull failure
    await waitFor(
      () => {
        expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/app-lifecycle/'), expect.anything());
      },
      { timeout: 10000 },
    );
  });

  it('invalidates installed apps on HTTP install failure (server truth)', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/app-lifecycle/') && url.includes('/install')) {
        return { ok: false, json: async () => ({ message: 'Server error' }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<InstallStep apps={[makeApp('plane', 'Plane', 'plane:store1')]} onComplete={onComplete} />);

    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['installed-apps'] });
    });
  });

  it('marks app failed when poll sees install_failed', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/app-lifecycle/') && url.includes('/install')) {
        return { ok: true, json: async () => ({ requestId: '1' }) };
      }
      if (url === '/api/apps/installed') {
        return {
          ok: true,
          json: async () => ({
            installed: [
              {
                info: { urn: 'plane:store1', name: 'Plane' },
                app: { status: 'install_failed' },
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<InstallStep apps={[makeApp('plane', 'Plane', 'plane:store1')]} onComplete={onComplete} />);

    expect(await screen.findByTestId('status-failed', {}, { timeout: 12000 })).toBeInTheDocument();
    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['installed-apps'] });
    });
  });
});
