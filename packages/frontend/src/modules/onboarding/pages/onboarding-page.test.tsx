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
    apps: [
      {
        id: 'openclaw',
        name: 'OpenClaw',
        urn: 'urn:store:openclaw',
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
  AiSetupStep: ({ onConfigChange }: { onConfigChange?: (c: unknown) => void }) => (
    <div data-testid="ai-setup-step">
      AI Setup
      <button
        type="button"
        onClick={() =>
          onConfigChange?.({
            agentFrameworks: ['openclaw'],
            selectedModels: [],
            backend: 'ollama',
            cloudProviders: [],
            remoteAccess: [],
            skipped: false,
          })
        }
      >
        emit-ai-config
      </button>
      <button
        type="button"
        onClick={() =>
          onConfigChange?.({ agentFrameworks: [], selectedModels: [], backend: 'ollama', cloudProviders: [], remoteAccess: [], skipped: false })
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
            backend: 'ollama',
            cloudProviders: [{ provider: 'openai', apiKey: 'sk-test', enabled: true }],
            remoteAccess: [],
            skipped: false,
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
  InstallStep: ({ apps, onComplete }: { apps: Array<{ appSlug: string }>; onComplete: (summary: unknown) => void }) => (
    <div data-testid="install-step" data-apps={apps.map((a) => a.appSlug).join(',')}>
      <button type="button" onClick={() => onComplete({ results: [], running: 0, incomplete: 0, failed: 0, total: 0 })}>
        install-complete
      </button>
    </div>
  ),
}));

vi.mock('../components/complete-step', () => ({
  CompleteStep: () => <div data-testid="complete-step">Done</div>,
}));

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <OnboardingPage />
    </MemoryRouter>,
  );

describe('OnboardingPage (single vertical form)', () => {
  it('renders config sections on the first page (app picker lives on the next page)', () => {
    renderPage();
    // AiSetupStep now owns the whole ordered form, including the Private VPN step (Step 3).
    expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument();
    // App selection moved to the install/review page, so it is not on the first form page.
    expect(screen.queryByTestId('recommendations-step')).not.toBeInTheDocument();
  });

  it('keeps Continue disabled until AI config is provided', () => {
    renderPage();
    expect(screen.getByTestId('finish-setup-btn')).toBeDisabled();
  });

  it('flows: AI config → Continue → select apps + install on one page → done', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config' }));
    const finish = screen.getByTestId('finish-setup-btn');
    expect(finish).toBeEnabled();

    await user.click(finish);
    // The selector and the install/review card appear together on the same page.
    expect(screen.getByTestId('recommendations-step')).toBeInTheDocument();
    expect(screen.getByTestId('install-step')).toBeInTheDocument();
    // The chosen agent is auto-queued at the top and included in the install list.
    expect(screen.getByTestId('agent-install-card-openclaw')).toBeInTheDocument();
    expect(screen.getByTestId('install-step')).toHaveAttribute('data-apps', 'openclaw');

    // Confirming the selection begins the install and hides the picker.
    await user.click(screen.getByTestId('start-install-btn'));
    expect(screen.queryByTestId('recommendations-step')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'install-complete' }));
    expect(screen.getByTestId('complete-step')).toBeInTheDocument();
  });

  it('queues no agent (and shows no agent card) when none was selected', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config-no-agent' }));
    await user.click(screen.getByTestId('finish-setup-btn'));

    expect(screen.queryByTestId('agent-install-card-openclaw')).not.toBeInTheDocument();
    expect(screen.getByTestId('install-step')).toHaveAttribute('data-apps', '');
  });

  it('describes the agent model source as local when a model is selected', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config' }));
    await user.click(screen.getByTestId('finish-setup-btn'));

    // The base 'emit-ai-config' config selects no local model and no cloud provider, so the agent
    // falls back to a recommended local model (not the misleading "downloaded model" claim).
    expect(screen.getByTestId('agent-summary-text-openclaw')).toHaveTextContent('recommended local model');
  });

  it('describes the agent model source as the cloud provider when one is configured', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config-cloud' }));
    await user.click(screen.getByTestId('finish-setup-btn'));

    expect(screen.getByTestId('agent-summary-text-openclaw')).toHaveTextContent('OpenAI');
    expect(screen.getByTestId('agent-summary-text-openclaw')).not.toHaveTextContent('downloaded model');
  });

  it('lets the user deselect the auto-queued agent on the install page', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'emit-ai-config' }));
    await user.click(screen.getByTestId('finish-setup-btn'));

    expect(screen.getByTestId('install-step')).toHaveAttribute('data-apps', 'openclaw');
    // Toggling the agent card off removes it from the install list.
    await user.click(screen.getByTestId('agent-install-card-openclaw'));
    expect(screen.getByTestId('install-step')).toHaveAttribute('data-apps', '');
  });
});
