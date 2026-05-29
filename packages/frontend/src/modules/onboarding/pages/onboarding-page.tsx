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
  const contextExposureMode = cloudflareAvailable ? 'cloudflare' : tailscaleAvailable ? 'tailscale' : 'local';
  const [currentStep, setCurrentStep] = useState(0);
  // Within the "Local Apps" step (step 2), 'recommend' shows the discovery
  // sub-screen and 'select' shows the review/select sub-screen.
  const [localAppsSubStep, setLocalAppsSubStep] = useState<'recommend' | 'select'>('recommend');
  const [detectedServices, setDetectedServices] = useState<DetectedService[]>([]);
  const [selectedApps, setSelectedApps] = useState<OnboardingApp[]>([]);
  const [aiSetupConfig, setAiSetupConfig] = useState<AiSetupConfig | undefined>();
  const [installSummary, setInstallSummary] = useState<InstallSummary | undefined>();

  // If already completed onboarding, redirect to dashboard
  if (user.hasCompletedOnboarding) {
    return <Navigate to="/dashboard" replace />;
  }

  const stepTitles = ['Start up', 'AI Setup', 'Local Apps', 'Confirm & Download', 'VPN Setup', 'Done'];

  return (
    <div className="flex items-center justify-center px-4 py-8" style={{ minHeight: 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <div className="w-full max-w-4xl">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-3xl border border-primary/30 bg-primary/5 shadow-lg shadow-primary/15">
            <img alt="Companion Hub logo" src={getLogo(true)} height={56} width={56} style={{ maxWidth: '100%', height: 'auto' }} />
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Set Up Your Hub</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Configure your private, local-first companion.</p>
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
              />
            </StepContent>

            <StepContent step={1}>
              <AiSetupStep
                cloudflareAvailable={cloudflareAvailable}
                tailscaleAvailable={tailscaleAvailable}
                onComplete={(config) => {
                  setAiSetupConfig(config);
                  setLocalAppsSubStep('recommend');
                  setCurrentStep(2);
                }}
                onSkip={() => {
                  setAiSetupConfig({ agentFramework: 'openclaw', selectedModels: [], backend: 'ollama', cloudProviders: [], skipped: true });
                  setLocalAppsSubStep('recommend');
                  setCurrentStep(2);
                }}
                onBack={() => setCurrentStep(0)}
              />
            </StepContent>

            <StepContent step={2}>
              {localAppsSubStep === 'recommend' ? (
                <RecommendationsStep
                  detectedServices={detectedServices}
                  onSelect={(apps) => {
                    setSelectedApps(apps);
                    setLocalAppsSubStep('select');
                  }}
                  onSkip={() => setCurrentStep(3)}
                  onBack={() => setCurrentStep(1)}
                />
              ) : (
                <SelectAppsStep
                  selectedApps={selectedApps}
                  onConfirm={(apps) => {
                    setSelectedApps(apps);
                    setCurrentStep(3);
                  }}
                  onBack={() => setLocalAppsSubStep('recommend')}
                />
              )}
            </StepContent>

            <StepContent step={3}>
              <InstallStep
                apps={selectedApps}
                defaultExposureMode={aiSetupConfig?.exposureMode ?? contextExposureMode}
                aiSetupConfig={aiSetupConfig}
                onComplete={(summary) => {
                  setInstallSummary(summary);
                  setCurrentStep(4);
                }}
              />
            </StepContent>

            <StepContent step={4}>
              <TailscaleSetupStep onComplete={() => setCurrentStep(5)} onSkip={() => setCurrentStep(5)} onBack={() => setCurrentStep(3)} />
            </StepContent>

            <StepContent step={5}>
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
