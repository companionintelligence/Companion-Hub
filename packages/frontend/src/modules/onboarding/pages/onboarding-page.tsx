import { Button } from '@/components/ui/Button';
import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { apiFetch } from '@/lib/api-fetch';
import { getLogo } from '@/lib/theme/theme';
import { cn } from '@/lib/utils';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router';
import { AiSetupStep } from '../components/ai-setup-step';
import { HermesIcon, OpenClawIcon } from '../components/ai-setup/icons';
import { SelectIndicator } from '../components/ai-setup/primitives';
import { CompleteStep } from '../components/complete-step';
import { InstallStep } from '../components/install-step';
import { RecommendationsStep } from '../components/recommendations-step';
import { TailscaleSetupStep } from '../components/tailscale-setup-step';
import { buildAgentApp, exposureModeLabel, resolveExposureMode } from '../helpers/agent-onboarding';
import { identifyServices, type DetectedService } from '../helpers/service-detection';
import type { AiSetupConfig, InstallSummary, OnboardingApp } from '../helpers/types';

/** Page chrome shared by every onboarding phase: brand header + centered container. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center overflow-y-auto px-4 py-8" style={{ height: 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <div className="w-full max-w-3xl">
        <div className="mb-8 text-center">
          <img
            alt="Companion Hub logo"
            src={getLogo(true)}
            height={64}
            width={64}
            className="mx-auto mb-4"
            style={{ maxWidth: '100%', height: 'auto' }}
          />
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Set Up Your Hub</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Configure your private, local-first companion.</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function OnboardingWizard() {
  const { user, apps: storeApps, cloudflareAvailable, tailscaleAvailable } = useAppContext();

  const [phase, setPhase] = useState<'form' | 'installing' | 'done'>('form');
  const [selectedApps, setSelectedApps] = useState<OnboardingApp[]>([]);
  const [aiSetupConfig, setAiSetupConfig] = useState<AiSetupConfig | undefined>();
  const [installSummary, setInstallSummary] = useState<InstallSummary | undefined>();
  const [detectedServices, setDetectedServices] = useState<DetectedService[]>([]);
  // The install/review page defers the actual install until the user confirms their app selection.
  const [installStarted, setInstallStarted] = useState(false);
  // Lets the user opt out of installing their chosen agent on the app-selection page.
  const [agentExcluded, setAgentExcluded] = useState(false);

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

  const canFinish = aiSetupConfig !== undefined;

  // Resolve the exposure mode we will actually install with (honoring the user's choice when its
  // transport is available, otherwise falling back gracefully — see resolveExposureMode).
  const installExposureMode = resolveExposureMode(aiSetupConfig?.exposureMode, { cloudflareAvailable, tailscaleAvailable });

  // The agent app chosen in the AI step (if any), resolved against the synced store apps. Memoized
  // so the install list keeps a stable reference (InstallStep syncs off the `apps` identity).
  const agentFramework = aiSetupConfig?.agentFramework;
  const agentApp = useMemo(() => (agentFramework ? buildAgentApp(agentFramework, storeApps) : null), [agentFramework, storeApps]);
  const agentSelected = !!agentApp?.urn && !agentExcluded;

  // Final install list: the selected agent (when included + available) ahead of the picked apps,
  // de-duplicated by slug. Memoized to avoid handing InstallStep a fresh array every render.
  const installApps = useMemo(() => {
    if (!agentApp || !agentSelected) return selectedApps;
    if (selectedApps.some((a) => a.appSlug === agentApp.appSlug)) return selectedApps;
    return [agentApp, ...selectedApps];
  }, [agentApp, agentSelected, selectedApps]);

  if (user.hasCompletedOnboarding) {
    return <Navigate to="/dashboard" replace />;
  }

  if (phase === 'installing') {
    const AgentIcon = agentFramework === 'hermes' ? HermesIcon : OpenClawIcon;
    const agentUnavailable = !!agentApp && !agentApp.urn;
    const agentSummary = agentApp?.urn
      ? `${exposureModeLabel(installExposureMode)} · uses your downloaded model`
      : 'Not available in your app store yet — skipped.';

    const selectionSummary = (() => {
      const parts: string[] = [];
      if (agentSelected && agentApp) parts.push(`${agentApp.name} agent`);
      if (selectedApps.length > 0) parts.push(`${selectedApps.length} app${selectedApps.length === 1 ? '' : 's'}`);
      if (parts.length === 0) return 'No apps selected — you can add them anytime from the App Store.';
      return `${parts.join(' + ')} selected.`;
    })();

    return (
      <Shell>
        <div className="space-y-6">
          {/* The chosen agent is auto-queued at the top, above the recommendations picker. Once the
              install begins we hide the selection UI and let InstallStep drive the rest. */}
          {!installStarted && agentApp && (
            <button
              type="button"
              data-testid="agent-install-card"
              onClick={() => !agentUnavailable && setAgentExcluded((v) => !v)}
              aria-pressed={agentSelected}
              disabled={agentUnavailable}
              className={cn(
                'group relative flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition-colors',
                agentSelected
                  ? 'border-primary bg-primary/[0.08] ring-1 ring-primary/30'
                  : 'border-border bg-foreground/[0.015] hover:border-primary/40',
                agentUnavailable && 'cursor-not-allowed opacity-60',
              )}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-foreground/10 text-primary [&_svg]:h-6 [&_svg]:w-6">
                <AgentIcon />
              </span>
              <span className="min-w-0 flex-1 pr-6">
                <span className="block text-sm font-medium">
                  {agentApp.name}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">Your agent</span>
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{agentSummary}</span>
              </span>
              {!agentUnavailable && (
                <span className="absolute right-2 top-2">
                  <SelectIndicator selected={agentSelected} />
                </span>
              )}
            </button>
          )}
          {!installStarted && <RecommendationsStep embedded detectedServices={detectedServices} onChange={setSelectedApps} />}
          <InstallStep
            apps={installApps}
            start={installStarted}
            defaultExposureMode={installExposureMode}
            aiSetupConfig={aiSetupConfig}
            onComplete={(summary) => {
              setInstallSummary(summary);
              setPhase('done');
            }}
          />
          {!installStarted && (
            <>
              {/* Breathing room so the sticky bar rests below all content instead of overlapping it. */}
              <div aria-hidden className="h-2" />
              <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-2xl border border-border bg-card/90 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">{selectionSummary}</p>
                <Button intent="primary" size="lg" onClick={() => setInstallStarted(true)} data-testid="start-install-btn">
                  Finish setup
                </Button>
              </div>
            </>
          )}
        </div>
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
        {/* Recommended apps section temporarily hidden.
        <RecommendationsStep embedded detectedServices={detectedServices} onChange={setSelectedApps} />
        */}
        <TailscaleSetupStep embedded />

        {/* Breathing room so the sticky finish bar rests below all content instead of overlapping it. */}
        <div aria-hidden className="h-2" />

        <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-2xl border border-border bg-card/90 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">{canFinish ? 'You can change everything later in Settings.' : 'Detecting your hardware…'}</p>
          <Button intent="primary" size="lg" disabled={!canFinish} onClick={() => setPhase('installing')} data-testid="finish-setup-btn">
            Continue
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
