import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { useState } from 'react';
import { Navigate } from 'react-router';
import { WelcomeStep } from '../components/welcome-step';
import { RecommendationsStep } from '../components/recommendations-step';
import { SelectAppsStep } from '../components/select-apps-step';
import { AiSetupStep } from '../components/ai-setup-step';
import { TailscaleSetupStep } from '../components/tailscale-setup-step';
import { InstallStep } from '../components/install-step';
import { CompleteStep } from '../components/complete-step';
import { Stepper, StepTrigger, StepTriggerList, StepContent } from '@/components/ui/Stepper/Stepper';
import type { OnboardingApp, InstallSummary, AiSetupConfig } from '../helpers/types';
import type { DetectedService } from '../helpers/service-detection';
import { getLogo } from '@/lib/theme/theme';
import { Suspense } from 'react';

function OnboardingWizard() {
  const { user, cloudflareAvailable, tailscaleAvailable } = useAppContext();
  const defaultExposureMode = cloudflareAvailable ? 'cloudflare' : tailscaleAvailable ? 'tailscale' : 'local';
  const [currentStep, setCurrentStep] = useState(0);
  const [detectedServices, setDetectedServices] = useState<DetectedService[]>([]);
  const [selectedApps, setSelectedApps] = useState<OnboardingApp[]>([]);
  const [aiSetupConfig, setAiSetupConfig] = useState<AiSetupConfig | undefined>();
  const [installSummary, setInstallSummary] = useState<InstallSummary | undefined>();

  // If already completed onboarding, redirect to dashboard
  if (user.hasCompletedOnboarding) {
    return <Navigate to="/dashboard" replace />;
  }

  const stepTitles = ['Welcome', 'Discover', 'Select', 'AI Setup', 'Private VPN', 'Install', 'Done'];

  return (
    <div className="flex items-center justify-center bg-background px-4 py-8" style={{ minHeight: 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <div className="w-full max-w-3xl">
        <div className="text-center mb-6">
          <img
            alt="Companion Hub logo"
            src={getLogo(true)}
            height={80}
            width={80}
            className="mx-auto mb-4"
            style={{ maxWidth: '100%', height: 'auto' }}
          />
          <h1 className="text-2xl font-bold text-foreground">Set Up Your Hub</h1>
        </div>

        <Stepper currentStep={currentStep}>
          <StepTriggerList>
            {stepTitles.map((title, i) => {
              const isLastStep = i === stepTitles.length - 1;
              // Allow clicking the last step from any step as a "skip to end" shortcut
              const alwaysClickable = isLastStep && currentStep < i;
              const disabled = !alwaysClickable && i > currentStep;
              const allowStepChange = (s: number) => s <= currentStep || s === stepTitles.length - 1;
              return (
                <StepTrigger
                  key={title}
                  step={i}
                  title={title}
                  disabled={disabled}
                  alwaysClickable={alwaysClickable}
                  onStepChange={(s) => allowStepChange(s) && setCurrentStep(s)}
                />
              );
            })}
          </StepTriggerList>

          <div className="mt-6">
            <StepContent step={0}>
              <WelcomeStep
                onDetected={(services) => {
                  setDetectedServices(services);
                  setCurrentStep(1);
                }}
                onSkip={() => setCurrentStep(3)}
              />
            </StepContent>

            <StepContent step={1}>
              <RecommendationsStep
                detectedServices={detectedServices}
                onSelect={(apps) => {
                  setSelectedApps(apps);
                  setCurrentStep(2);
                }}
                onSkip={() => setCurrentStep(3)}
                onBack={() => setCurrentStep(0)}
              />
            </StepContent>

            <StepContent step={2}>
              <SelectAppsStep
                selectedApps={selectedApps}
                onConfirm={(apps) => {
                  setSelectedApps(apps);
                  setCurrentStep(3);
                }}
                onBack={() => setCurrentStep(1)}
              />
            </StepContent>

            <StepContent step={3}>
              <AiSetupStep
                onComplete={(config) => {
                  setAiSetupConfig(config);
                  setCurrentStep(4);
                }}
                onSkip={() => {
                  setAiSetupConfig({ selectedModels: [], backend: 'ollama', cloudProviders: [], skipped: true });
                  setCurrentStep(4);
                }}
                onBack={() => setCurrentStep(2)}
              />
            </StepContent>

            <StepContent step={4}>
              <TailscaleSetupStep onComplete={() => setCurrentStep(5)} onSkip={() => setCurrentStep(5)} onBack={() => setCurrentStep(3)} />
            </StepContent>

            <StepContent step={5}>
              <InstallStep
                apps={selectedApps}
                defaultExposureMode={defaultExposureMode}
                aiSetupConfig={aiSetupConfig}
                onComplete={(summary) => {
                  setInstallSummary(summary);
                  setCurrentStep(6);
                }}
              />
            </StepContent>

            <StepContent step={6}>
              <CompleteStep installSummary={installSummary} aiSetupConfig={aiSetupConfig} />
            </StepContent>
          </div>
        </Stepper>
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  const { isLoggedIn } = useUserContext();

  if (!isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center bg-background" style={{ minHeight: 'calc(100vh - var(--titlebar-height, 0px))' }}>
          <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
      }
    >
      <AppContextProvider>
        <OnboardingWizard />
      </AppContextProvider>
    </Suspense>
  );
}
