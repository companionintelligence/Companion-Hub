import { Button } from '@/components/ui/Button';
import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { apiFetch } from '@/lib/api-fetch';
import { getLogo } from '@/lib/theme/theme';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AGENT_APP_SLUG } from '../helpers/ai-setup-types';
import { AiSetupStep } from '../components/ai-setup-step';
import { StepSection } from '../components/ai-setup/primitives';
import { InstallStep } from '../components/install-step';
import { RecommendationsStep } from '../components/recommendations-step';
import { buildAgentApp, resolveExposureMode } from '../helpers/agent-onboarding';
import { identifyServices, type DetectedService } from '../helpers/service-detection';
import { useMarketplaceCatalogApps } from '../helpers/use-marketplace-catalog-apps';
import type { AiSetupConfig, OnboardingApp } from '../helpers/types';
import { CompanionAppsCard } from '../components/ai-setup/companion-apps-card';

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
        <div className="mb-6 flex items-center gap-3">
          <img
            alt={t('APP_NAME_LOGO_ALT')}
            src={getLogo(true)}
            height={48}
            width={48}
            className="flex-shrink-0"
            style={{ maxWidth: '100%', height: 'auto' }}
          />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{t('COMMON_SET_UP_YOUR_HUB')}</h1>
            <p className="text-sm text-muted-foreground">{t('ONBOARDING_CONFIGURE_PRIVATE_COMPANION')}</p>
            <p className="text-xs text-muted-foreground/80">{t('ONBOARDING_CONFIGURE_PRIVATE_COMPANION_HINT')}</p>
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
  const { user, cloudflareAvailable, tailscaleAvailable, setAppContext, refreshAppContext } = useAppContext();
  const { apps: storeApps, isLoading: isCatalogLoading, isError: isCatalogError, refetch: refetchCatalog } = useMarketplaceCatalogApps();
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
        const res = await apiFetch('/api/system/detect-services');
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

  const catalogReady = !isCatalogLoading && !isCatalogError;
  const canFinish = aiSetupConfig !== undefined && !aiSetupConfig.installBlocked && catalogReady;
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
            try {
              await apiFetch('/api/complete-onboarding', { method: 'PATCH' });
            } catch {
              // Non-fatal — navigate anyway.
            }
            // Update the shared app-context cache (correct query key) so route guards
            // on /home and /store do not send the user back to onboarding.
            setAppContext({ user: { ...user, hasCompletedOnboarding: true } });
            await refreshAppContext();
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
          afterHarness={<CompanionAppsCard publicExposureMode={publicExposureMode} onChange={setCompanionApps} />}
        >
          <StepSection number={4} title={t('ONBOARDING_RECOMMENDED_APPS')} description={t('ONBOARDING_RECOMMENDED_APPS_DESC')}>
            <RecommendationsStep embedded detectedServices={detectedServices} agentSlugs={agentSlugs} onChange={setSelectedApps} />
          </StepSection>
        </AiSetupStep>

        <div aria-hidden className="h-2" />

        <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-2xl border border-border bg-card/90 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {isCatalogLoading
              ? t('COMMON_LOADING')
              : isCatalogError
                ? t('APP_STORE_COULD_NOT_LOAD_FEATURED')
                : (aiSetupConfig?.installBlockReason ?? (canFinish ? t('ONBOARDING_CHANGE_LATER_SETTINGS') : t('COMMON_DETECTING_HARDWARE')))}
          </p>
          <div className="flex gap-2 sm:justify-end">
            {isCatalogError && (
              <Button variant="outline" size="lg" onClick={() => void refetchCatalog()}>
                {t('COMMON_RETRY')}
              </Button>
            )}
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
