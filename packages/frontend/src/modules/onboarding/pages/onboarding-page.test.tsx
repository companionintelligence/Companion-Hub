import { render, screen } from '@/tests/test-utils';
import userEvent from '@testing-library/user-event';
import { createContext, useContext, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import OnboardingPage from './onboarding-page';

vi.mock('@/context/app-context', () => ({
  AppContextProvider: ({ children }: { children: ReactNode }) => children,
  useAppContext: () => ({
    user: { hasCompletedOnboarding: false },
    cloudflareAvailable: false,
    tailscaleAvailable: false,
  }),
}));

vi.mock('@/context/user-context', () => ({
  useUserContext: () => ({
    isLoggedIn: true,
  }),
}));

vi.mock('@/lib/theme/theme', () => ({
  getLogo: () => '/logo.svg',
}));

vi.mock('../components/welcome-step', () => ({
  WelcomeStep: ({ onDetected }: { onDetected: (services: []) => void }) => (
    <div>
      <button type="button" onClick={() => onDetected([])}>
        welcome-next
      </button>
    </div>
  ),
}));

vi.mock('../components/recommendations-step', () => ({
  RecommendationsStep: ({ onSelect, onSkip }: { onSelect: (apps: []) => void; onSkip: () => void }) => (
    <div data-testid="recommendations-step">
      <button type="button" onClick={() => onSelect([])}>
        recommend-next
      </button>
      <button type="button" onClick={onSkip}>
        recommend-skip
      </button>
    </div>
  ),
}));

vi.mock('../components/select-apps-step', () => ({
  SelectAppsStep: ({ onConfirm }: { onConfirm: (apps: Array<{ appSlug: string }>) => void }) => (
    <div>
      <button type="button" onClick={() => onConfirm([])}>
        finish-setup
      </button>
      <button type="button" onClick={() => onConfirm([{ appSlug: 'app-1' }])}>
        install-app
      </button>
    </div>
  ),
}));

vi.mock('../components/ai-setup-step', () => ({
  AiSetupStep: ({ onComplete, onSkip }: { onComplete: (config: unknown) => void; onSkip: () => void }) => (
    <div data-testid="ai-setup-step">
      AI Setup
      <button type="button" onClick={() => onComplete({ selectedModels: [], backend: 'ollama', cloudProviders: [], skipped: false })}>
        ai-next
      </button>
      <button type="button" onClick={onSkip}>
        ai-skip
      </button>
    </div>
  ),
}));

vi.mock('../components/tailscale-setup-step', () => ({
  TailscaleSetupStep: ({ onComplete, onSkip }: { onComplete: () => void; onSkip: () => void }) => (
    <div data-testid="tailscale-setup-step">
      Tailscale Setup
      <button type="button" onClick={onComplete}>
        tailscale-next
      </button>
      <button type="button" onClick={onSkip}>
        tailscale-skip
      </button>
    </div>
  ),
}));

vi.mock('../components/install-step', () => ({
  InstallStep: ({ onComplete }: { onComplete: (summary: unknown) => void }) => (
    <div data-testid="install-step">
      Install
      <button type="button" onClick={() => onComplete({ results: [], running: 0, incomplete: 0, failed: 0, total: 0 })}>
        install-complete
      </button>
    </div>
  ),
}));

vi.mock('../components/complete-step', () => ({
  CompleteStep: () => <div data-testid="complete-step">Done</div>,
}));

const StepperContext = createContext(0);

vi.mock('@/components/ui/Stepper/Stepper', () => ({
  Stepper: ({ currentStep, children }: { currentStep: number; children: ReactNode }) => (
    <StepperContext.Provider value={currentStep}>{children}</StepperContext.Provider>
  ),
  StepTriggerList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StepTrigger: ({ title }: { title: string }) => <div>{title}</div>,
  StepContent: ({ step, children }: { step: number; children: ReactNode }) => {
    const currentStep = useContext(StepperContext);
    return currentStep === step ? <div>{children}</div> : null;
  },
}));

describe('OnboardingPage', () => {
  it('renders the reordered step titles in the stepper', () => {
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );

    for (const title of ['Start up', 'AI Setup', 'Local Apps', 'Confirm & Download', 'VPN Setup', 'Done']) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(screen.queryByText('Welcome')).not.toBeInTheDocument();
    expect(screen.queryByText('Private VPN')).not.toBeInTheDocument();
    expect(screen.queryByText('Discover')).not.toBeInTheDocument();
    expect(screen.queryByText('Select Apps')).not.toBeInTheDocument();
    expect(screen.queryByText('Install')).not.toBeInTheDocument();
  });

  it('routes Start up continue to AI Setup', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'welcome-next' }));

    expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument();
    expect(screen.queryByTestId('complete-step')).not.toBeInTheDocument();
  });

  it('routes AI Setup continue to Local Apps (Discover)', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'welcome-next' }));
    await user.click(screen.getByRole('button', { name: 'ai-next' }));

    expect(screen.getByTestId('recommendations-step')).toBeInTheDocument();
  });

  it('routes AI Setup skip to Local Apps (Discover)', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'welcome-next' }));
    await user.click(screen.getByRole('button', { name: 'ai-skip' }));

    expect(screen.getByTestId('recommendations-step')).toBeInTheDocument();
  });

  it('routes Local Apps select to the Select review sub-screen', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'welcome-next' }));
    await user.click(screen.getByRole('button', { name: 'ai-next' }));
    await user.click(screen.getByRole('button', { name: 'recommend-next' }));

    expect(screen.getByRole('button', { name: 'finish-setup' })).toBeInTheDocument();
    expect(screen.queryByTestId('recommendations-step')).not.toBeInTheDocument();
  });

  it('routes Local Apps skip to Confirm & Download (Install)', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'welcome-next' }));
    await user.click(screen.getByRole('button', { name: 'ai-next' }));
    await user.click(screen.getByRole('button', { name: 'recommend-skip' }));

    expect(screen.getByTestId('install-step')).toBeInTheDocument();
  });

  it('routes Confirm & Download complete to VPN Setup before Done', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'welcome-next' }));
    await user.click(screen.getByRole('button', { name: 'ai-next' }));
    await user.click(screen.getByRole('button', { name: 'recommend-skip' }));
    await user.click(screen.getByRole('button', { name: 'install-complete' }));

    expect(screen.getByTestId('tailscale-setup-step')).toBeInTheDocument();
    expect(screen.queryByTestId('complete-step')).not.toBeInTheDocument();
  });

  it('routes VPN Setup continue to Done', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'welcome-next' }));
    await user.click(screen.getByRole('button', { name: 'ai-next' }));
    await user.click(screen.getByRole('button', { name: 'recommend-skip' }));
    await user.click(screen.getByRole('button', { name: 'install-complete' }));
    await user.click(screen.getByRole('button', { name: 'tailscale-next' }));

    expect(screen.getByTestId('complete-step')).toBeInTheDocument();
  });
});
