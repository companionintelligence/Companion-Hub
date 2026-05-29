import { Button } from '@/components/ui/Button';
import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { apiFetch } from '@/lib/api-fetch';
import { getLogo } from '@/lib/theme/theme';
import { Suspense, useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { AiSetupStep } from '../components/ai-setup-step';
import { CompleteStep } from '../components/complete-step';
import { InstallStep } from '../components/install-step';
import { RecommendationsStep } from '../components/recommendations-step';
import { TailscaleSetupStep } from '../components/tailscale-setup-step';
import { identifyServices, type DetectedService } from '../helpers/service-detection';
import type { AiSetupConfig, InstallSummary, OnboardingApp } from '../helpers/types';

/** Page chrome shared by every onboarding phase: brand header + centered container. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center px-4 py-8" style={{ minHeight: 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <div className="w-full max-w-3xl">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-3xl border border-primary/30 bg-primary/5 shadow-lg shadow-primary/15">
            <img alt="Companion Hub logo" src={getLogo(true)} height={56} width={56} style={{ maxWidth: '100%', height: 'auto' }} />
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Set Up Your Hub</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Configure your private, local-first companion.</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function OnboardingWizard() {
  const { user, cloudflareAvailable, tailscaleAvailable } = useAppContext();

  const [phase, setPhase] = useState<'form' | 'installing' | 'done'>('form');
  const [detectedServices, setDetectedServices] = useState<DetectedService[]>([]);
  const [selectedApps, setSelectedApps] = useState<OnboardingApp[]>([]);
  const [aiSetupConfig, setAiSetupConfig] = useState<AiSetupConfig | undefined>();
  const [installSummary, setInstallSummary] = useState<InstallSummary | undefined>();

  // Detect Docker services once, to seed the Local Apps recommendations.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/system/detect-services', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setDetectedServices(identifyServices(data.services || []));
      } catch {
        // Non-fatal — recommendations fall back to popular apps.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const contextExposureMode = cloudflareAvailable ? 'cloudflare' : tailscaleAvailable ? 'tailscale' : 'local';
  const installExposureMode = aiSetupConfig?.exposureMode ?? contextExposureMode;
  const canFinish = aiSetupConfig !== undefined;

  if (user.hasCompletedOnboarding) {
    return <Navigate to="/dashboard" replace />;
  }

  if (phase === 'installing') {
    return (
      <Shell>
        <InstallStep
          apps={selectedApps}
          defaultExposureMode={installExposureMode}
          aiSetupConfig={aiSetupConfig}
          onComplete={(summary) => {
            setInstallSummary(summary);
            setPhase('done');
          }}
        />
      </Shell>
    );
  }

  if (phase === 'done') {
    return (
      <Shell>
        <CompleteStep installSummary={installSummary} aiSetupConfig={aiSetupConfig} />
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-6">
        <AiSetupStep embedded onConfigChange={setAiSetupConfig} cloudflareAvailable={cloudflareAvailable} tailscaleAvailable={tailscaleAvailable} />
        <RecommendationsStep embedded detectedServices={detectedServices} onChange={setSelectedApps} />
        <TailscaleSetupStep embedded />

        <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-2xl border border-border bg-card/90 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {canFinish
              ? `${selectedApps.length} app${selectedApps.length === 1 ? '' : 's'} selected. You can change everything later in Settings.`
              : 'Detecting your hardware…'}
          </p>
          <Button intent="primary" size="lg" disabled={!canFinish} onClick={() => setPhase('installing')} data-testid="finish-setup-btn">
            Finish setup
          </Button>
        </div>
      </div>
    </Shell>
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
