import { createSignal, Show, For, Suspense } from 'solid-js';
import { useNavigate, Navigate } from '@solidjs/router';
import { api, rawApiFetch } from '@/api-client';
import { useUserContext } from '@/context/user-context';
import { AppContextProvider, useAppContext } from '@/context/app-context';
import { Card, CardContent, LoadingSpinner, Stepper, StepTrigger, StepTriggerList, StepContent } from '@/components/ui/shared';
import { Button } from '@/components/ui/Button';
import { toast } from '@/stores/toast-store';

interface OnboardingApp {
  appSlug: string;
  name: string;
  icon: string;
  category: string;
  replacesNames: string[];
  urn?: string;
}

// Welcome Step
function WelcomeStep(props: { onDetected: (services: Array<{ name: string; friendlyName: string }>) => void; onSkip: () => void }) {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const handleDetect = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await rawApiFetch('/system/detect-services');
      if (!res.ok) throw new Error('Failed to detect services');
      const data = await res.json();
      props.onDetected(data.services || []);
    } catch (e) {
      setError('Could not detect services. You can skip this step.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardContent class="p-8 text-center">
        <div class="mb-6">
          <div class="text-5xl mb-4">👋</div>
          <h2 class="text-xl font-semibold mb-2">Welcome to Companion Hub</h2>
          <p class="text-muted-foreground max-w-md mx-auto">
            Let's get your self-hosted ecosystem set up. We'll scan for existing services and recommend open-source alternatives.
          </p>
        </div>
        <div class="flex flex-col gap-3 items-center">
          <Button onClick={handleDetect} disabled={loading()} class="w-64">
            {loading() ? 'Scanning...' : 'Scan for existing services'}
          </Button>
          <Button variant="ghost" onClick={props.onSkip} disabled={loading()}>
            Skip — I'll browse the store myself
          </Button>
        </div>
        <Show when={error()}><p class="text-sm text-destructive mt-4">{error()}</p></Show>
      </CardContent>
    </Card>
  );
}

// Select Apps Step (simplified)
function SelectAppsStep(props: { selectedApps: OnboardingApp[]; onConfirm: (apps: OnboardingApp[]) => void; onBack: () => void }) {
  const [selected, setSelected] = createSignal<OnboardingApp[]>(props.selectedApps);

  const toggleApp = (app: OnboardingApp) => {
    setSelected((prev) => {
      const exists = prev.find((a) => a.appSlug === app.appSlug);
      return exists ? prev.filter((a) => a.appSlug !== app.appSlug) : [...prev, app];
    });
  };

  return (
    <Card>
      <CardContent class="p-8">
        <h2 class="text-xl font-semibold mb-4 text-center">Select Apps to Install</h2>
        <Show when={props.selectedApps.length > 0} fallback={
          <p class="text-center text-muted-foreground mb-4">No recommended apps detected. You can browse the App Store later.</p>
        }>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
            <For each={props.selectedApps}>
              {(app) => {
                const isSelected = () => selected().some((a) => a.appSlug === app.appSlug);
                return (
                  <button
                    type="button"
                    onClick={() => toggleApp(app)}
                    class={`p-3 rounded-lg border-2 transition-colors text-left cursor-pointer ${isSelected() ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
                  >
                    <Show when={app.icon}><img src={app.icon} alt={app.name} class="w-8 h-8 rounded mb-2" /></Show>
                    <p class="font-medium text-sm">{app.name}</p>
                    <p class="text-xs text-muted-foreground">{app.category}</p>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
        <div class="flex justify-between">
          <Button variant="outline" onClick={props.onBack}>Back</Button>
          <Button onClick={() => props.onConfirm(selected())}>{selected().length > 0 ? `Install ${selected().length} apps` : 'Skip'}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Install Step
function InstallStep(props: { apps: OnboardingApp[]; onComplete: () => void }) {
  const [installing, setInstalling] = createSignal(true);

  // Kick off installations
  (async () => {
    for (const app of props.apps) {
      try {
        if (app.urn) await api.installApp(app.urn, {});
      } catch (err) {
        toast.error(`Failed to install ${app.name}`);
      }
    }
    setInstalling(false);
  })();

  return (
    <Card>
      <CardContent class="p-8 text-center">
        <div class="text-5xl mb-4">📦</div>
        <h2 class="text-xl font-semibold mb-2">Installing Apps</h2>
        <p class="text-muted-foreground mb-6">
          {installing() ? 'Installing your selected apps...' : 'Installation requests sent! Apps will continue installing in the background.'}
        </p>
        <Show when={!installing()}>
          <Button onClick={props.onComplete} class="w-64">Continue</Button>
        </Show>
        <Show when={installing()}><LoadingSpinner /></Show>
      </CardContent>
    </Card>
  );
}

// Complete Step
function CompleteStep(props: { installed: boolean }) {
  const navigate = useNavigate();
  const { refetch } = useAppContext();
  const [loading, setLoading] = createSignal(false);

  const handleFinish = async () => {
    setLoading(true);
    try {
      await rawApiFetch('/complete-onboarding', { method: 'PATCH', headers: { 'Content-Type': 'application/json' } });
      refetch();
      navigate('/dashboard', { replace: true });
    } catch {
      navigate('/dashboard', { replace: true });
    }
  };

  return (
    <Card>
      <CardContent class="p-8 text-center">
        <div class="text-5xl mb-4">🎉</div>
        <h2 class="text-xl font-semibold mb-2">You're All Set!</h2>
        <p class="text-muted-foreground max-w-md mx-auto mb-6">
          {props.installed
            ? "Your apps are being installed in the background. They'll be ready shortly on your dashboard."
            : 'Your Hub is ready to go. You can install apps anytime from the App Store.'}
        </p>
        <Button onClick={handleFinish} disabled={loading()} class="w-64">
          {loading() ? 'Loading...' : 'Go to Dashboard'}
        </Button>
      </CardContent>
    </Card>
  );
}

// Wizard
function OnboardingWizard() {
  const { appContext } = useAppContext();
  const [currentStep, setCurrentStep] = createSignal(0);
  const [selectedApps, setSelectedApps] = createSignal<OnboardingApp[]>([]);
  const [installComplete, setInstallComplete] = createSignal(false);

  if (appContext().user.hasCompletedOnboarding) {
    return <Navigate href="/dashboard" />;
  }

  const stepTitles = ['Welcome', 'Select', 'Install', 'Done'];

  return (
    <div class="flex items-center justify-center bg-background px-4 py-8" style={{ "min-height": 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <div class="w-full max-w-3xl">
        <div class="text-center mb-6">
          <img alt="Companion Hub logo" src="/2024_CI__Logo_Banner_Color_small.svg" height={80} width={80} class="mx-auto mb-4 hidden dark:block" style={{ "max-width": '100%', height: 'auto' }} />
          <img alt="Companion Hub logo" src="/2024_CI__Logo_Banner_Color_small-lightmode2.svg" height={80} width={80} class="mx-auto mb-4 block dark:hidden" style={{ "max-width": '100%', height: 'auto' }} />
          <h1 class="text-2xl font-bold text-foreground">Set Up Your Hub</h1>
        </div>

        <Stepper currentStep={currentStep()}>
          <StepTriggerList>
            <For each={stepTitles}>
              {(title, i) => (
                <StepTrigger
                  step={i()}
                  title={title}
                  active={currentStep() === i()}
                  completed={currentStep() > i()}
                  disabled={i() > currentStep() && i() !== stepTitles.length - 1}
                  onClick={() => {
                    if (i() <= currentStep() || i() === stepTitles.length - 1) setCurrentStep(i());
                  }}
                />
              )}
            </For>
          </StepTriggerList>

          <div class="mt-6">
            <StepContent step={0} active={currentStep() === 0}>
              <WelcomeStep
                onDetected={() => setCurrentStep(1)}
                onSkip={() => setCurrentStep(3)}
              />
            </StepContent>

            <StepContent step={1} active={currentStep() === 1}>
              <SelectAppsStep
                selectedApps={selectedApps()}
                onConfirm={(apps) => {
                  setSelectedApps(apps);
                  if (apps.length === 0) setCurrentStep(3);
                  else setCurrentStep(2);
                }}
                onBack={() => setCurrentStep(0)}
              />
            </StepContent>

            <StepContent step={2} active={currentStep() === 2}>
              <InstallStep
                apps={selectedApps()}
                onComplete={() => { setInstallComplete(true); setCurrentStep(3); }}
              />
            </StepContent>

            <StepContent step={3} active={currentStep() === 3}>
              <CompleteStep installed={installComplete() && selectedApps().length > 0} />
            </StepContent>
          </div>
        </Stepper>
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  const { userContext } = useUserContext();

  if (!userContext().isLoggedIn) {
    return <Navigate href="/login" />;
  }

  return (
    <Suspense fallback={
      <div class="flex items-center justify-center bg-background" style={{ "min-height": 'calc(100vh - var(--titlebar-height, 0px))' }}>
        <div class="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    }>
      <AppContextProvider>
        <OnboardingWizard />
      </AppContextProvider>
    </Suspense>
  );
}
