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
import { buildAgentApp, exposureModeLabel, resolveExposureMode } from '../helpers/agent-onboarding';
import { CLOUD_KEY_PATTERNS } from '../helpers/ai-setup-types';
import { identifyServices, type DetectedService } from '../helpers/service-detection';
import type { AiSetupConfig, InstallSummary, OnboardingApp } from '../helpers/types';

/** Page chrome shared by every onboarding phase: brand header + centered container. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center overflow-y-auto px-4 py-8" style={{ height: 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <div className="w-full max-w-[57.6rem]">
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

  const [phase, setPhase] = useState<'form' | 'installing' | 'done'>('form');
  const [selectedApps, setSelectedApps] = useState<OnboardingApp[]>([]);
  const [aiSetupConfig, setAiSetupConfig] = useState<AiSetupConfig | undefined>();
  const [installSummary, setInstallSummary] = useState<InstallSummary | undefined>();
  const [detectedServices, setDetectedServices] = useState<DetectedService[]>([]);
  // The install/review page defers the actual install until the user confirms their app selection.
  const [installStarted, setInstallStarted] = useState(false);
  // Lets the user opt out of installing individual chosen agents on the app-selection page (by slug).
  const [excludedAgentSlugs, setExcludedAgentSlugs] = useState<Set<string>>(new Set());

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

  // The agent apps chosen in the AI step, resolved against the synced store apps. Memoized so the
  // install list keeps a stable reference (InstallStep syncs off the `apps` identity).
  const agentFrameworks = aiSetupConfig?.agentFrameworks ?? [];
  const agentApps = useMemo(
    () => agentFrameworks.map((framework) => ({ framework, app: buildAgentApp(framework, storeApps) })),
    [agentFrameworks, storeApps],
  );
  // Agents the user is actually installing: present in the store and not toggled off.
  const includedAgentApps = useMemo(
    () => agentApps.filter(({ app }) => !!app.urn && !excludedAgentSlugs.has(app.appSlug)),
    [agentApps, excludedAgentSlugs],
  );

  // Final install list: the included agents ahead of the picked apps, de-duplicated by slug.
  const installApps = useMemo(() => {
    const merged: OnboardingApp[] = includedAgentApps.map(({ app }) => app);
    for (const a of selectedApps) {
      if (!merged.some((m) => m.appSlug === a.appSlug)) merged.push(a);
    }
    return merged;
  }, [includedAgentApps, selectedApps]);

  if (user.hasCompletedOnboarding) {
    return <Navigate to="/dashboard" replace />;
  }

  if (phase === 'installing') {
    // Describe the model the agents will use. A configured cloud provider overrides the local model
    // (and buildConfig leaves selectedModels empty in that case), so drive the text by what's selected.
    const hasLocalModel = (aiSetupConfig?.selectedModels.length ?? 0) > 0;
    const enabledCloudProvider = aiSetupConfig?.cloudProviders.find((p) => p.enabled && p.apiKey.trim());
    const modelSourceText = hasLocalModel
      ? 'uses your downloaded model'
      : enabledCloudProvider
        ? `uses your ${CLOUD_KEY_PATTERNS[enabledCloudProvider.provider].label} model`
        : 'uses a recommended local model';

    const selectionSummary = (() => {
      const parts: string[] = [];
      if (includedAgentApps.length > 0) parts.push(`${includedAgentApps.length} agent${includedAgentApps.length === 1 ? '' : 's'}`);
      if (selectedApps.length > 0) parts.push(`${selectedApps.length} app${selectedApps.length === 1 ? '' : 's'}`);
      if (parts.length === 0) return 'No apps selected — you can add them anytime from the App Store.';
      return `${parts.join(' + ')} selected.`;
    })();

    return (
      <Shell>
        <div className="space-y-6">
          {/* The chosen agents are auto-queued at the top, above the recommendations picker. Once the
              install begins we hide the selection UI and let InstallStep drive the rest. */}
          {!installStarted && agentApps.length > 0 && (
            <div className="space-y-3">
              {agentApps.map(({ framework, app }) => {
                const AgentIcon = framework === 'hermes' ? HermesIcon : OpenClawIcon;
                const unavailable = !app.urn;
                const selected = !!app.urn && !excludedAgentSlugs.has(app.appSlug);
                const summary = app.urn
                  ? `${exposureModeLabel(installExposureMode)} · ${modelSourceText}`
                  : 'Not available in your app store yet — skipped.';
                return (
                  <button
                    key={app.appSlug}
                    type="button"
                    data-testid={`agent-install-card-${framework}`}
                    onClick={() =>
                      !unavailable &&
                      setExcludedAgentSlugs((prev) => {
                        const next = new Set(prev);
                        if (next.has(app.appSlug)) next.delete(app.appSlug);
                        else next.add(app.appSlug);
                        return next;
                      })
                    }
                    aria-pressed={selected}
                    disabled={unavailable}
                    className={cn(
                      'group relative flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition-colors',
                      selected
                        ? 'border-primary bg-primary/[0.08] ring-1 ring-primary/30'
                        : 'border-border bg-foreground/[0.015] hover:border-primary/40',
                      unavailable && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-foreground/10 text-primary [&_svg]:h-6 [&_svg]:w-6">
                      <AgentIcon />
                    </span>
                    <span className="min-w-0 flex-1 pr-6">
                      <span className="block text-sm font-medium">
                        {app.name}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">Your agent</span>
                      </span>
                      <span className="mt-0.5 block text-xs leading-snug text-muted-foreground" data-testid={`agent-summary-text-${framework}`}>
                        {summary}
                      </span>
                    </span>
                    {!unavailable && (
                      <span className="absolute right-2 top-2">
                        <SelectIndicator selected={selected} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
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
        {/* AiSetupStep (embedded) renders the full ordered form: Step 1 Agent Framework, Step 2
            Recommended Models (with Other Models), Step 3 Private VPN, then Advanced. */}
        <AiSetupStep embedded onConfigChange={setAiSetupConfig} cloudflareAvailable={cloudflareAvailable} tailscaleAvailable={tailscaleAvailable} />
        {/* Recommended apps section temporarily hidden.
        <RecommendationsStep embedded detectedServices={detectedServices} onChange={setSelectedApps} />
        */}

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
