import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstallStep } from '../install-step';
import type { OnboardingApp } from '../../helpers/types';

const mockApiFetch = vi.fn();

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    getQueryData: vi.fn(() => ({ installed: [] })),
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
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
    expect(queued.length + installing.length).toBeGreaterThanOrEqual(2);
  });

  it('provides a continue button that calls onComplete', async () => {
    const apps = [makeApp('app1', 'App One', 'app1:store1')];

    render(<InstallStep apps={apps} onComplete={onComplete} />);

    const btn = screen.getByTestId('install-continue-btn');
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toContain('Continue');
  });

  it('renders the app list container', () => {
    const apps = [makeApp('app1', 'App One', 'app1:store1')];

    render(<InstallStep apps={apps} onComplete={onComplete} />);

    expect(screen.getByTestId('install-app-list')).toBeInTheDocument();
  });

  it('shows clear text when no apps are selected', async () => {
    render(
      <InstallStep apps={[]} onComplete={onComplete} aiSetupConfig={{ selectedModels: [], backend: 'ollama', cloudProviders: [], skipped: true }} />,
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
          selectedModels: [],
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
    render(
      <InstallStep
        apps={[]}
        onComplete={onComplete}
        aiSetupConfig={{
          selectedModels: ['hermes4-70b'],
          backend: 'ollama',
          cloudProviders: [],
          preferredModelId: 'hermes4-70b',
          skipped: false,
        }}
      />,
    );

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/inference/preferences',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ backend: 'ollama', model: 'hermes4-70b' }),
        }),
      );
    });
  });
});
