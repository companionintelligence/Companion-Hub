import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { useState } from 'react';
import { Navigate } from 'react-router';
import { WelcomeStep } from '../components/welcome-step';
import { RecommendationsStep } from '../components/recommendations-step';
import { SelectAppsStep } from '../components/select-apps-step';
import { InstallStep } from '../components/install-step';
import { CompleteStep } from '../components/complete-step';
import { Stepper, StepTrigger, StepTriggerList, StepContent } from '@/components/ui/Stepper/Stepper';
import type { OnboardingApp } from '../helpers/types';
import type { DetectedService } from '../helpers/service-detection';
import { getLogo } from '@/lib/theme/theme';
import { Suspense } from 'react';

function OnboardingWizard() {
  const { user } = useAppContext();
  const [currentStep, setCurrentStep] = useState(0);
  const [detectedServices, setDetectedServices] = useState<DetectedService[]>([]);
  const [selectedApps, setSelectedApps] = useState<OnboardingApp[]>([]);
  const [installComplete, setInstallComplete] = useState(false);

  // If already completed onboarding, redirect to dashboard
  if (user.hasCompletedOnboarding) {
    return <Navigate to="/dashboard" replace />;
  }

  const stepTitles = ['Welcome', 'Discover', 'Select', 'Install', 'Done'];

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
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
            {stepTitles.map((title, i) => (
              <StepTrigger
                key={title}
                step={i}
                title={title}
                disabled={i > currentStep}
                onStepChange={(s) => s <= currentStep && setCurrentStep(s)}
              />
            ))}
          </StepTriggerList>

          <div className="mt-6">
            <StepContent step={0}>
              <WelcomeStep
                onDetected={(services) => {
                  setDetectedServices(services);
                  setCurrentStep(1);
                }}
                onSkip={() => setCurrentStep(1)}
              />
            </StepContent>

            <StepContent step={1}>
              <RecommendationsStep
                detectedServices={detectedServices}
                onSelect={(apps) => {
                  setSelectedApps(apps);
                  setCurrentStep(2);
                }}
                onSkip={() => setCurrentStep(4)}
                onBack={() => setCurrentStep(0)}
              />
            </StepContent>

            <StepContent step={2}>
              <SelectAppsStep
                selectedApps={selectedApps}
                onConfirm={(apps) => {
                  setSelectedApps(apps);
                  if (apps.length === 0) {
                    setCurrentStep(4);
                  } else {
                    setCurrentStep(3);
                  }
                }}
                onBack={() => setCurrentStep(1)}
              />
            </StepContent>

            <StepContent step={3}>
              <InstallStep
                apps={selectedApps}
                onComplete={() => {
                  setInstallComplete(true);
                  setCurrentStep(4);
                }}
              />
            </StepContent>

            <StepContent step={4}>
              <CompleteStep installed={installComplete && selectedApps.length > 0} />
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
        <div className="flex min-h-screen items-center justify-center bg-background">
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
