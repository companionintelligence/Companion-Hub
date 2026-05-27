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
  WelcomeStep: ({ onDetected, onSkip }: { onDetected: (services: []) => void; onSkip: () => void }) => (
    <div>
      <button type="button" onClick={() => onDetected([])}>
        welcome-next
      </button>
      <button type="button" onClick={onSkip}>
        welcome-skip
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
  TailscaleSetupStep: () => <div data-testid="tailscale-setup-step">Tailscale Setup</div>,
}));

vi.mock('../components/install-step', () => ({
  InstallStep: () => <div data-testid="install-step">Install</div>,
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
  it('shows the renamed Select Apps step title in the stepper', () => {
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Select Apps')).toBeInTheDocument();
    expect(screen.queryByText('Select')).not.toBeInTheDocument();
  });

  it('routes Welcome continue to AI Setup', async () => {
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

  it('routes Welcome skip to AI Setup', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'welcome-skip' }));

    expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument();
    expect(screen.queryByTestId('complete-step')).not.toBeInTheDocument();
  });

  it('routes AI Setup continue to Discover', async () => {
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

  it('routes AI Setup skip to Discover', async () => {
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

  it('routes Discover skip to Select Apps', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'welcome-next' }));
    await user.click(screen.getByRole('button', { name: 'ai-next' }));
    await user.click(screen.getByRole('button', { name: 'recommend-skip' }));

    expect(screen.getByRole('button', { name: 'finish-setup' })).toBeInTheDocument();
  });
});
