import { Button } from '@/components/ui/Button';
import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { apiFetch } from '@/lib/api-fetch';
import { getLogo } from '@/lib/theme/theme';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { AiSetupStep } from '../components/ai-setup-step';
import { StepSection } from '../components/ai-setup/primitives';
import { InstallStep } from '../components/install-step';
import { RecommendationsStep } from '../components/recommendations-step';
import { buildAgentApp, resolveExposureMode } from '../helpers/agent-onboarding';
import { identifyServices, type DetectedService } from '../helpers/service-detection';
import type { AiSetupConfig, OnboardingApp } from '../helpers/types';

/** Page chrome shared by every onboarding phase: brand header + centered container. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center overflow-y-auto px-4 py-8" style={{ height: 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <div className="w-full max-w-[82.94rem]">
        <div className="mb-6 flex items-center gap-3">
          <img
            alt="Companion Hub logo"
            src={getLogo(true)}
            height={48}
            width={48}
            className="flex-shrink-0"
            style={{ maxWidth: '100%', height: 'auto' }}
          />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Set Up Your Hub</h1>
            <p className="text-sm text-muted-foreground">Configure your private, local-first companion.</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function OnboardingWizard() {
  const { user, apps: storeApps, cloudflareAvailable, tailscaleAvailable } = useAppContext();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<'form' | 'installing'>('form');
  const [selectedApps, setSelectedApps] = useState<OnboardingApp[]>([]);
  const [aiSetupConfig, setAiSetupConfig] = useState<AiSetupConfig | undefined>();
  const [detectedServices, setDetectedServices] = useState<DetectedService[]>([]);

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

  const canFinish = aiSetupConfig !== undefined && !aiSetupConfig.installBlocked;
  const installExposureMode = resolveExposureMode(aiSetupConfig?.exposureMode, { cloudflareAvailable, tailscaleAvailable });

  const agentFrameworks = aiSetupConfig?.agentFrameworks ?? [];
  const agentApps = useMemo(
    () => agentFrameworks.map((framework) => ({ framework, app: buildAgentApp(framework, storeApps) })),
    [agentFrameworks, storeApps],
  );
  const includedAgentApps = useMemo(() => agentApps.filter(({ app }) => !!app.urn), [agentApps]);
  const installApps = useMemo(() => {
    const merged: OnboardingApp[] = includedAgentApps.map(({ app }) => app);
    for (const a of selectedApps) {
      if (!merged.some((m) => m.appSlug === a.appSlug)) merged.push(a);
    }
    return merged;
  }, [includedAgentApps, selectedApps]);

  if (user.hasCompletedOnboarding) {
    return <Navigate to="/home" replace />;
  }

  if (phase === 'installing') {
    return (
      <Shell>
        <InstallStep
          apps={installApps}
          start={true}
          defaultExposureMode={installExposureMode}
          aiSetupConfig={aiSetupConfig}
          onComplete={async () => {
            try {
              await apiFetch('/api/complete-onboarding', { method: 'PATCH', credentials: 'include' });
            } catch {
              // Non-fatal — navigate anyway.
            }
            navigate('/store', { replace: true });
          }}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-5">
        {/* Steps 1–3 + step 5 (Advanced) rendered by AiSetupStep in embedded mode.
            Step 4 (Recommended Apps) is passed as children, inserted between step 3 and step 5. */}
        <AiSetupStep embedded onConfigChange={setAiSetupConfig} cloudflareAvailable={cloudflareAvailable} tailscaleAvailable={tailscaleAvailable}>
          <StepSection
            number={4}
            title="Recommended Apps"
            description="Here are some popular open-source apps you can self-host. Select any you'd like installed."
          >
            <RecommendationsStep
              embedded
              detectedServices={detectedServices}
              pinnedSlugs={['steam-headless', 'comfyui']}
              onChange={setSelectedApps}
            />
          </StepSection>
        </AiSetupStep>

        <div aria-hidden className="h-2" />

        <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-2xl border border-border bg-card/90 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {aiSetupConfig?.installBlockReason ?? (canFinish ? 'You can change everything later in Settings.' : 'Detecting your hardware…')}
          </p>
          <Button intent="primary" size="lg" disabled={!canFinish} onClick={() => setPhase('installing')} data-testid="finish-setup-btn">
            Install & Finish
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
