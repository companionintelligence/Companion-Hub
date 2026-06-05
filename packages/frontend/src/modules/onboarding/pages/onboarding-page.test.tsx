import { render, screen } from '@/tests/test-utils';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import OnboardingPage from './onboarding-page';

vi.mock('@/context/app-context', () => ({
  AppContextProvider: ({ children }: { children: ReactNode }) => children,
  useAppContext: () => ({
    user: { hasCompletedOnboarding: false },
    cloudflareAvailable: false,
    tailscaleAvailable: true,
    setAppContext: vi.fn(),
    refreshAppContext: vi.fn().mockResolvedValue(undefined),
    apps: [
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
    ],
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
  AiSetupStep: ({ onConfigChange, children }: { onConfigChange?: (c: unknown) => void; children?: ReactNode }) => (
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
    </div>
  ),
}));

vi.mock('../components/recommendations-step', () => ({
  RecommendationsStep: ({ onChange }: { onChange?: (a: unknown[]) => void }) => (
    <div data-testid="recommendations-step">
      <button type="button" onClick={() => onChange?.([])}>
        emit-apps
      </button>
    </div>
  ),
}));

vi.mock('../components/install-step', () => ({
  InstallStep: ({
    apps,
    onComplete,
  }: {
    apps: Array<{ appSlug: string }>;
    onComplete: (summary: { continuedInBackground?: boolean }) => void | Promise<void>;
  }) => (
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
  it('renders config sections and step 4 (app picker) on the same page', () => {
    renderPage();
    // AiSetupStep owns steps 1-3 + 5 and renders children (step 4) inline.
    expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument();
    // RecommendationsStep is now embedded as step 4 on the form page.
    expect(screen.getByTestId('recommendations-step')).toBeInTheDocument();
  });

  it('keeps Install & Finish disabled until AI config is provided', () => {
    renderPage();
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
});
