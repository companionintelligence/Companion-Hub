import { render, screen } from '@/tests/test-utils';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { InstallSummary } from '../helpers/types';
import OnboardingPage from './onboarding-page';

const { mockCatalogState } = vi.hoisted(() => ({
  mockCatalogState: {
    isLoading: false,
    isError: false,
  },
}));

vi.mock('@/context/app-context', () => ({
  AppContextProvider: ({ children }: { children: ReactNode }) => children,
  useAppContext: () => ({
    user: { hasCompletedOnboarding: false },
    cloudflareAvailable: false,
    tailscaleAvailable: true,
    setAppContext: vi.fn(),
    refreshAppContext: vi.fn().mockResolvedValue(undefined),
  }),
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
    isError: mockCatalogState.isError,
    refetch: vi.fn(),
  }),
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
    afterHarness,
  }: {
    onConfigChange?: (c: unknown) => void;
    children?: ReactNode;
    afterHarness?: ReactNode;
  }) => (
    <div data-testid="ai-setup-step">
      AI Setup
      {afterHarness}
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
              name: 'Companion Memory',
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

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <OnboardingPage />
    </MemoryRouter>,
  );

describe('OnboardingPage (single vertical form)', () => {
  beforeEach(() => {
    mockCatalogState.isLoading = false;
    mockCatalogState.isError = false;
  });

  it('renders config sections and step 4 (app picker) on the same page', () => {
    renderPage();
    // AiSetupStep owns steps 1-3 + 5 and renders children (step 4) inline.
    expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument();
    expect(screen.getByTestId('companion-apps-card')).toBeInTheDocument();
    // RecommendationsStep is now embedded as step 4 on the form page.
    expect(screen.getByTestId('recommendations-step')).toBeInTheDocument();
  });

  it('keeps Install & Finish disabled until AI config is provided', () => {
    renderPage();
    expect(screen.getByTestId('finish-setup-btn')).toBeDisabled();
  });

  it('keeps Install & Finish disabled while the marketplace catalog is loading', async () => {
    mockCatalogState.isLoading = true;
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config' }));
    expect(screen.getByTestId('finish-setup-btn')).toBeDisabled();
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
        return { ok: true, json: async () => ({ services: [] }) };
      }
      if (url === '/api/inference/ollama/status') {
        return { ok: true, json: async () => ({ ready: true, running: true }) };
      }
      if (url === '/api/inference/models/pull/start') {
        return { ok: true, json: async () => ({ status: 'queued' }) };
      }
      if (url === '/api/inference/models/tracked') {
        return { ok: true, json: async () => [{ catalogId: 'llama3-3-70b', state: 'pulling', pullProgress: 34 }] };
      }
      return { ok: true, json: async () => ({}) };
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
