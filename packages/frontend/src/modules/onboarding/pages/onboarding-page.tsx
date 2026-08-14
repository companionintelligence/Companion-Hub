import { Button } from '@/components/ui/Button';
import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { completeOnboarding, detectServices } from '@/api-client/sdk.gen';
import { sdkResult, unwrapSdkOrNull } from '@/lib/sdk-unwrap';
import { getLogo } from '@/lib/theme/theme';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { AGENT_APP_SLUG } from '../helpers/ai-setup-types';
import { AiSetupStep } from '../components/ai-setup-step';
import { StepSection } from '../components/ai-setup/primitives';
import { InstallStep } from '../components/install-step';
import { RecommendationsStep } from '../components/recommendations-step';
import { buildAgentApp, resolveExposureMode } from '../helpers/agent-onboarding';
import { identifyServices, type DetectedService } from '../helpers/service-detection';
import { useMarketplaceCatalogApps } from '../helpers/use-marketplace-catalog-apps';
import type { AiSetupConfig, OnboardingApp } from '../helpers/types';
import { ModelDownloadFooterSummary, ModelDownloadStatus } from '../components/model-download-status';
import { useModelPullOrchestrator } from '@/lib/hooks/use-model-pull-orchestrator';
import { prefetchOnboardingMarketplace } from '../helpers/prefetch-onboarding-marketplace';

/**
 * Long enough for a Hub that is still coming back up to start answering, short enough that the
 * Continue button — which has no in-flight guard — is not left clickable for much longer.
 */
const COMPLETE_ONBOARDING_RETRY_DELAY_MS = 500;

const AGENT_APP_ALIAS_CANONICAL: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_APP_SLUG).flatMap(([framework, slug]) => [
    [framework, slug],
    [slug, slug],
  ]),
);

function appIdentityKeys(app: OnboardingApp): string[] {
  const keys: string[] = [];
  if (app.urn) keys.push(`urn:${app.urn.toLowerCase()}`);

  const slug = app.appSlug?.trim().toLowerCase();
  if (slug) {
    keys.push(`slug:${slug}`);
    const canonical = AGENT_APP_ALIAS_CANONICAL[slug];
    if (canonical && canonical !== slug) keys.push(`slug:${canonical}`);
  }

  return keys;
}

function dedupeOnboardingApps(apps: OnboardingApp[]): OnboardingApp[] {
  const seen = new Set<string>();
  const deduped: OnboardingApp[] = [];

  for (const app of apps) {
    const keys = appIdentityKeys(app);
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    deduped.push(app);
  }

  return deduped;
}

/** Page chrome shared by every onboarding phase: brand header + centered container. */
function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center overflow-y-auto px-4 py-8" style={{ height: 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <div className="w-full max-w-[82.94rem]">
        <div className="mb-10 flex items-start gap-4">
          <img
            alt={t('APP_NAME_LOGO_ALT')}
            src={getLogo(true)}
            height={48}
            width={48}
            className="mt-0.5 flex-shrink-0"
            style={{ maxWidth: '100%', height: 'auto' }}
          />
          <div className="min-w-0 space-y-2">
            <h1 className="text-3xl font-bold tracking-tight text-foreground">{t('COMMON_SET_UP_YOUR_HUB')}</h1>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">{t('ONBOARDING_CONFIGURE_PRIVATE_COMPANION')}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

const SKIPPED_AI_CONFIG: AiSetupConfig = {
  agentFrameworks: [],
  selectedModels: [],
  backend: 'ollama',
  cloudProviders: [],
  remoteAccess: [],
  skipped: true,
  installedCatalogIds: [],
  installBlocked: false,
};

function OnboardingWizard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { user, cloudflareAvailable, tailscaleAvailable, setAppContext, refreshAppContext } = useAppContext();
  const {
    apps: storeApps,
    isLoading: isCatalogLoading,
    isError: isCatalogError,
    isFetching: isCatalogFetching,
    refetch: refetchCatalog,
  } = useMarketplaceCatalogApps();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<'form' | 'installing'>('form');
  const [selectedApps, setSelectedApps] = useState<OnboardingApp[]>([]);
  const [companionApps, setCompanionApps] = useState<OnboardingApp[]>([]);
  const [aiSetupConfig, setAiSetupConfig] = useState<AiSetupConfig | undefined>();
  const [detectedServices, setDetectedServices] = useState<DetectedService[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = (await unwrapSdkOrNull(detectServices())) as { services?: Array<{ name: string; image: string; status: string }> } | null;
        if (!data) return;
        if (!cancelled) setDetectedServices(identifyServices(data.services ?? []));
      } catch {
        // Non-fatal — recommendations fall back to popular apps.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void prefetchOnboardingMarketplace(queryClient);
  }, [queryClient]);

  useEffect(() => {
    if (isCatalogLoading || isCatalogFetching || isCatalogError || storeApps.length > 0) {
      return;
    }

    const timer = setTimeout(() => {
      void refetchCatalog();
    }, 1500);

    return () => clearTimeout(timer);
  }, [isCatalogError, isCatalogFetching, isCatalogLoading, refetchCatalog, storeApps.length]);

  const recommendationsLoading = (isCatalogLoading || isCatalogFetching) && !isCatalogError;
  const canFinish = aiSetupConfig !== undefined && !aiSetupConfig.installBlocked;
  const installExposureMode = resolveExposureMode(aiSetupConfig?.exposureMode, { cloudflareAvailable, tailscaleAvailable });
  const publicExposureMode = resolveExposureMode('cloudflare', { cloudflareAvailable, tailscaleAvailable });

  const agentSlugs = useMemo(
    () => (aiSetupConfig?.agentFrameworks ?? []).map((framework) => AGENT_APP_SLUG[framework]),
    [aiSetupConfig?.agentFrameworks],
  );

  const agentFrameworks = aiSetupConfig?.agentFrameworks ?? [];
  const agentApps = useMemo(
    () => agentFrameworks.map((framework) => ({ framework, app: buildAgentApp(framework, storeApps) })),
    [agentFrameworks, storeApps],
  );
  const includedAgentApps = useMemo(() => agentApps.filter(({ app }) => !!app.urn), [agentApps]);
  const installApps = useMemo(() => {
    return dedupeOnboardingApps([...includedAgentApps.map(({ app }) => app), ...companionApps, ...selectedApps]);
  }, [includedAgentApps, companionApps, selectedApps]);

  const modelPullEnabled = aiSetupConfig !== undefined && !aiSetupConfig.skipped;
  const modelPullState = useModelPullOrchestrator({
    selectedModelIds: aiSetupConfig?.selectedModels ?? [],
    installedCatalogIds: aiSetupConfig?.installedCatalogIds ?? [],
    enabled: modelPullEnabled,
    bestEffort: true,
  });

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
          operatorUsername={user.username}
          aiSetupConfig={aiSetupConfig}
          onComplete={async (summary) => {
            // Whether the PATCH landed decides what the rest of this handler may do: an
            // unchecked write that never landed leaves the server flag false, and the /home
            // route guard reads that back and drops the user into the wizard a second time.
            // The client rejects on both failure modes — the response interceptor in root.tsx
            // throws on any status >= 400, and a transport error rejects out of fetch — so the
            // catch is what reports failure; `ok` only distinguishes a 2xx from a resolved
            // response that carried none.
            const markComplete = async () => {
              try {
                return (await sdkResult(completeOnboarding())).ok;
              } catch {
                return false;
              }
            };
            // Retry once, after a pause. The blip worth covering is the Hub restarting, and a
            // second PATCH issued in the same tick only hits the same closed socket.
            let completed = await markComplete();
            if (!completed) {
              await new Promise((resolve) => setTimeout(resolve, COMPLETE_ONBOARDING_RETRY_DELAY_MS));
              completed = await markComplete();
            }
            // Update the shared app-context cache (correct query key) so route guards
            // on /home and /store do not send the user back to onboarding.
            setAppContext({ user: { ...user, hasCompletedOnboarding: true } });
            // Only re-read the server when the write landed. Refetching after a failed write
            // replaces the optimistic flag with the server's `false`, and the /home guard then
            // sends the user straight back into the wizard — the exact outcome that navigating
            // anyway exists to avoid.
            if (completed) {
              await refreshAppContext();
            }
            navigate('/home', {
              replace: true,
              state: summary?.continuedInBackground ? { showBackgroundInstallToast: true } : undefined,
            });
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
        <AiSetupStep
          embedded
          onConfigChange={setAiSetupConfig}
          onSkip={() => setAiSetupConfig(SKIPPED_AI_CONFIG)}
          cloudflareAvailable={cloudflareAvailable}
          tailscaleAvailable={tailscaleAvailable}
          publicExposureMode={publicExposureMode}
          onCompanionAppsChange={setCompanionApps}
        >
          <StepSection number={6} badge="optional" title={t('ONBOARDING_RECOMMENDED_APPS')} description={t('ONBOARDING_RECOMMENDED_APPS_DESC')}>
            <RecommendationsStep embedded detectedServices={detectedServices} agentSlugs={agentSlugs} onChange={setSelectedApps} />
          </StepSection>
        </AiSetupStep>

        {modelPullEnabled && (
          <ModelDownloadStatus
            selectedModelIds={aiSetupConfig.selectedModels}
            installedCatalogIds={aiSetupConfig.installedCatalogIds}
            pullState={modelPullState}
          />
        )}

        {/*
          Spacer must clear the sticky footer, otherwise the last card can never be
          scrolled out from under it. `h-2` left the System Overview rows (RAM/GPU)
          permanently covered on a 375px viewport.
        */}
        <div aria-hidden className="h-24 sm:h-20" />

        <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-lg sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-0.5 min-w-0">
            <ModelDownloadFooterSummary pullState={modelPullState} />
            <p className="text-sm text-muted-foreground">
              {recommendationsLoading
                ? t('ONBOARDING_RECOMMENDATIONS_LOADING')
                : (aiSetupConfig?.installBlockReason ?? (canFinish ? t('ONBOARDING_CHANGE_LATER_SETTINGS') : t('COMMON_DETECTING_HARDWARE')))}
            </p>
          </div>
          <div className="flex gap-2 sm:justify-end">
            <Button intent="primary" size="lg" disabled={!canFinish} onClick={() => setPhase('installing')} data-testid="finish-setup-btn">
              {t('ONBOARDING_INSTALL_AND_FINISH')}
            </Button>
          </div>
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
