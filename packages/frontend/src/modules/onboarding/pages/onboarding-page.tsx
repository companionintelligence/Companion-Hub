import { Button } from '@/components/ui/Button';
import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { apiFetch } from '@/lib/api-fetch';
import { getLogo } from '@/lib/theme/theme';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router';
import { AiSetupStep } from '../components/ai-setup-step';
import { CompleteStep } from '../components/complete-step';
import { InstallStep } from '../components/install-step';
import { RecommendationsStep } from '../components/recommendations-step';
import { TailscaleSetupStep } from '../components/tailscale-setup-step';
import { identifyServices, type DetectedService } from '../helpers/service-detection';
import type { AiSetupConfig, InstallSummary, OnboardingApp } from '../helpers/types';

const SECTIONS = [
  { id: 'ai-setup', title: 'AI Setup' },
  { id: 'local-apps', title: 'Local Apps' },
  { id: 'vpn', title: 'Private VPN' },
] as const;

/** Page chrome shared by every onboarding phase: brand header + centered container. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center px-4 py-8" style={{ minHeight: 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <div className="w-full max-w-5xl">
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
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

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

  // Highlight the section currently in view in the sticky rail.
  useEffect(() => {
    if (phase !== 'form' || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      { rootMargin: '-35% 0px -55% 0px', threshold: [0, 0.25, 0.5, 1] },
    );
    for (const s of SECTIONS) {
      const el = sectionRefs.current[s.id];
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [phase]);

  const contextExposureMode = cloudflareAvailable ? 'cloudflare' : tailscaleAvailable ? 'tailscale' : 'local';
  const installExposureMode = aiSetupConfig?.exposureMode ?? contextExposureMode;
  const canFinish = aiSetupConfig !== undefined;
  const activeIndex = SECTIONS.findIndex((s) => s.id === activeSection);

  const scrollToSection = (id: string) => sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (user.hasCompletedOnboarding) {
    return <Navigate to="/dashboard" replace />;
  }

  if (phase === 'installing') {
    return (
      <Shell>
        <div className="mx-auto max-w-2xl">
          <InstallStep
            apps={selectedApps}
            defaultExposureMode={installExposureMode}
            aiSetupConfig={aiSetupConfig}
            onComplete={(summary) => {
              setInstallSummary(summary);
              setPhase('done');
            }}
          />
        </div>
      </Shell>
    );
  }

  if (phase === 'done') {
    return (
      <Shell>
        <div className="mx-auto max-w-2xl">
          <CompleteStep installSummary={installSummary} aiSetupConfig={aiSetupConfig} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* Progress rail — sticky column on desktop, scrollable chips on mobile. */}
        <nav aria-label="Setup progress" className="lg:sticky lg:top-8 lg:w-48 lg:flex-shrink-0">
          <ol className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0">
            {SECTIONS.map((s, i) => {
              const isActive = activeSection === s.id;
              const isDone = activeIndex > i;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => scrollToSection(s.id)}
                    aria-current={isActive ? 'step' : undefined}
                    data-testid={`rail-${s.id}`}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                      isActive ? 'bg-primary/10 font-semibold text-primary' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                        isActive
                          ? 'border-primary bg-primary text-primary-foreground'
                          : isDone
                            ? 'border-primary/50 text-primary'
                            : 'border-muted-foreground/40 text-muted-foreground',
                      )}
                    >
                      {isDone ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
                    </span>
                    <span className="whitespace-nowrap">{s.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Sections */}
        <div className="min-w-0 flex-1 space-y-6">
          <section
            id="ai-setup"
            ref={(el) => {
              sectionRefs.current['ai-setup'] = el;
            }}
            className="scroll-mt-8"
          >
            <AiSetupStep
              embedded
              onConfigChange={setAiSetupConfig}
              cloudflareAvailable={cloudflareAvailable}
              tailscaleAvailable={tailscaleAvailable}
            />
          </section>

          <section
            id="local-apps"
            ref={(el) => {
              sectionRefs.current['local-apps'] = el;
            }}
            className="scroll-mt-8"
          >
            <RecommendationsStep embedded detectedServices={detectedServices} onChange={setSelectedApps} />
          </section>

          <section
            id="vpn"
            ref={(el) => {
              sectionRefs.current['vpn'] = el;
            }}
            className="scroll-mt-8"
          >
            <TailscaleSetupStep embedded />
          </section>

          <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-2xl border border-border bg-card/90 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {canFinish
                ? `${selectedApps.length} app${selectedApps.length === 1 ? '' : 's'} selected. You can change everything later in Settings.`
                : 'Detecting your hardware…'}
            </p>
            <Button
              intent="primary"
              size="lg"
              disabled={!canFinish}
              onClick={() => setPhase('installing')}
              data-testid="finish-setup-btn"
              className="sm:w-auto"
            >
              Finish setup
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
