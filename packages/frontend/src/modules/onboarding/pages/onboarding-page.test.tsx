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
        onClick={() => onConfigChange?.({ agentFramework: 'openclaw', selectedModels: [], backend: 'ollama', cloudProviders: [], skipped: false })}
      >
        emit-ai-config
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

vi.mock('../components/tailscale-setup-step', () => ({
  TailscaleSetupStep: () => <div data-testid="tailscale-setup-step">VPN</div>,
}));

vi.mock('../components/install-step', () => ({
  InstallStep: ({ onComplete }: { onComplete: (summary: unknown) => void }) => (
    <div data-testid="install-step">
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
    expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument();
    // App selection moved to the install/review page, so it is not on the first form page.
    expect(screen.queryByTestId('recommendations-step')).not.toBeInTheDocument();
    expect(screen.getByTestId('tailscale-setup-step')).toBeInTheDocument();
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

    // Confirming the selection begins the install and hides the picker.
    await user.click(screen.getByTestId('start-install-btn'));
    expect(screen.queryByTestId('recommendations-step')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'install-complete' }));
    expect(screen.getByTestId('complete-step')).toBeInTheDocument();
  });
});
