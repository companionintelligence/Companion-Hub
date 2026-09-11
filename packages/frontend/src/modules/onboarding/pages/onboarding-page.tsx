import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { completeOnboarding, detectServices } from '@/api-client/sdk.gen';
import { sdkResult, unwrapSdkOrNull } from '@/lib/sdk-unwrap';
import { TranslatableError } from '@/types/error.types';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import toast from 'react-hot-toast';
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

/** Long enough for a Hub that is still coming back up to start answering. */
const COMPLETE_ONBOARDING_RETRY_DELAY_MS = 500;

/** Fixed id so repeat failures replace the notice instead of stacking, and success can clear it. */
const COMPLETE_ONBOARDING_TOAST_ID = 'onboarding-complete-failed';

const CI_SERVER_E_BRAIN_LOGO = '/brands/ci-server-e-brain.png';

/**
 * Only transient failures are worth a second identical PATCH. A 4xx will not become a 2xx —
 * a 401 in particular means the session lapsed, which retrying cannot fix and whose remedy is
 * not the "check that the Hub is running" the failure notice offers. `status` is 0 when the
 * request never produced a response at all, which is the Hub-restart case the retry is for.
 */
function isRetryableCompletionFailure(status: number): boolean {
  return status === 0 || status >= 500;
}

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
        <div className="mb-8 mt-[10vh] flex flex-col items-center text-center sm:mb-10">
          <div
            className="mb-3 flex h-14 w-14 items-center justify-center overflow-hidden rounded-[30%] border border-primary/30 bg-primary/10 p-2 shadow-sm"
            data-testid="onboarding-brand-mark"
          >
            <img
              alt={t('ONBOARDING_CI_SERVER_E_BRAIN_LOGO_ALT')}
              src={CI_SERVER_E_BRAIN_LOGO}
              height={40}
              width={40}
              className="h-10 w-10 object-contain"
            />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{t('ONBOARDING_SET_UP_COMPANION_HUB')}</h1>
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
  const { user, cloudflareAvailable, tailscaleAvailable, setAppContext, refreshAppContext, isLoading: isAppLoading } = useAppContext();
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
  const [completionFailed, setCompletionFailed] = useState(false);
  /** Latches the completion handler, which stays alive across the retry pause. */
  const completingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    // Set on mount rather than at declaration: StrictMode's dev double-invoke runs the cleanup
    // once before the real mount, which would otherwise latch this false for good.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
    // Readiness has to be gated on the backend the operator actually chose. Left unset, this
    // defaulted to Ollama — harmless while vLLM was the only alternative (the Hub cannot pull vLLM
    // models anyway), but mlx-dspark IS Hub-loadable, so an operator with mlx-dspark up and Ollama
    // down would have had their model silently never load.
    inferenceBackend: aiSetupConfig?.backend,
    backendUrl:
      aiSetupConfig?.backend === 'dspark'
        ? aiSetupConfig?.dsparkUrl
        : aiSetupConfig?.backend === 'mtplx'
          ? aiSetupConfig?.mtplxUrl
          : aiSetupConfig?.backend === 'vllm'
            ? aiSetupConfig?.vllmUrl
            : undefined,
    // Only the rows the Hub can install — `selectedModels` also carries vLLM rows the operator
    // fetched themselves.
    pullableModelIds: aiSetupConfig?.ollamaSelectedModelIds,
  });

  if (user.hasCompletedOnboarding) {
    return <Navigate to="/home" replace />;
  }

  // The default payload says "not onboarded"; do not paint step one on it.
  if (isAppLoading) {
    return (
      <div className="flex items-center justify-center bg-background" style={{ minHeight: 'calc(100vh - var(--titlebar-height, 0px))' }}>
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (phase === 'installing') {
    return (
      <Shell>
        {completionFailed && (
          <Alert variant="danger" className="mb-4" data-testid="onboarding-complete-failed">
            <AlertDescription>{t('ONBOARDING_FINISH_SAVE_FAILED')}</AlertDescription>
          </Alert>
        )}
        <InstallStep
          apps={installApps}
          start={true}
          defaultExposureMode={installExposureMode}
          operatorUsername={user.username}
          aiSetupConfig={aiSetupConfig}
          onComplete={async (summary) => {
            // InstallStep's Continue button is never disabled and drops the promise it gets back,
            // and this handler now stays alive across the retry pause — so without a latch a
            // second click starts a parallel completion chain, and the loser of the two reports
            // failure over the winner's navigation.
            if (completingRef.current) {
              return;
            }
            completingRef.current = true;

            try {
              // Whether the PATCH landed decides what the rest of this handler may do: an
              // unchecked write that never landed leaves the server flag false, and the /home
              // route guard reads that back and drops the user into the wizard a second time.
              // The client rejects on both failure modes — the response interceptor in root.tsx
              // throws on any status >= 400, and a transport error rejects out of fetch — so the
              // catch is what reports failure; `ok` only distinguishes a 2xx from a resolved
              // response that carried none.
              const markComplete = async () => {
                try {
                  const { ok, status } = await sdkResult(completeOnboarding());
                  return { ok, retryable: isRetryableCompletionFailure(status) };
                } catch (error) {
                  // The interceptor rejects on any status >= 400 and carries it on `http.status`.
                  // A transport error has no status at all — that is the Hub-restart case, and
                  // falling back to 0 is what marks it retryable.
                  const status = error instanceof TranslatableError ? (error.http?.status ?? 0) : 0;
                  return { ok: false, retryable: isRetryableCompletionFailure(status) };
                }
              };
              // Retry once, after a pause. The blip worth covering is the Hub restarting, and a
              // second PATCH issued in the same tick only hits the same closed socket.
              let result = await markComplete();
              if (!result.ok && result.retryable) {
                await new Promise((resolve) => setTimeout(resolve, COMPLETE_ONBOARDING_RETRY_DELAY_MS));
                result = await markComplete();
              }

              if (!mountedRef.current) {
                // The wizard is gone — a 401 hard-navigates to /login. The toast below outlives
                // this component, so it would land on a page with no Continue button to retry on.
                return;
              }

              if (!result.ok) {
                // Navigating anyway would land on /home only until the next app-context read —
                // which reports the flag the server actually holds — bounced the user back here
                // with no explanation and their install summary gone. Staying put says so, and
                // leaves Continue as the retry. No optimistic write either: it would trip the
                // `hasCompletedOnboarding` guard above and navigate for us.
                setCompletionFailed(true);
                toast.error(t('ONBOARDING_FINISH_SAVE_FAILED'), { id: COMPLETE_ONBOARDING_TOAST_ID });
                return;
              }

              setCompletionFailed(false);
              // The Toaster is mounted above the router, so a failed attempt's toast would ride
              // along to /home still claiming the setup could not be saved.
              toast.dismiss(COMPLETE_ONBOARDING_TOAST_ID);
              // Update the shared app-context cache (correct query key) so route guards
              // on /home and /store do not send the user back to onboarding.
              setAppContext({ user: { ...user, hasCompletedOnboarding: true } });
              await refreshAppContext();
              navigate('/home', {
                replace: true,
                state: summary?.continuedInBackground ? { showBackgroundInstallToast: true } : undefined,
              });
            } finally {
              // Released even on the failure path: the notice tells the user to press Continue
              // again, so the latch must not be what stops them.
              completingRef.current = false;
            }
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
          <StepSection number={6} badge="optional" title={t('ONBOARDING_RECOMMENDED_APPS')}>
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
