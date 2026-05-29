import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { useAppContext } from '@/context/app-context';
import { portalAlternativesQueryOptions } from '@/lib/portal-alternatives';
import { useQuery } from '@tanstack/react-query';
import { LayoutGrid } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getRecommendedApps } from '../helpers/alternatives';
import type { DetectedService } from '../helpers/service-detection';
import type { OnboardingApp } from '../helpers/types';
import { SelectIndicator } from './ai-setup/primitives';
import { WizardCard, WizardHeader, WizardNav } from './wizard-ui';

interface RecommendationsStepProps {
  detectedServices: DetectedService[];
  onSelect?: (apps: OnboardingApp[]) => void;
  onSkip?: () => void;
  onBack?: () => void;
  /** Section mode for the single-page form: hides nav and emits the live selection via onChange. */
  embedded?: boolean;
  onChange?: (apps: OnboardingApp[]) => void;
}

export const RecommendationsStep = ({ detectedServices, onSelect, onSkip, onBack, embedded = false, onChange }: RecommendationsStepProps) => {
  const { apps: storeApps } = useAppContext();
  const detectedNames = detectedServices.map((s) => s.friendlyName);
  const {
    data: altsData,
    isLoading: isAltsLoading,
    isError: isAltsError,
    error: altsError,
    refetch,
  } = useQuery({
    ...portalAlternativesQueryOptions(),
  });
  // Filter recommendations to only include alternatives available in the app store
  const recommendations = useMemo(() => {
    if (!altsData) return [];
    const storeSlugs = new Set(storeApps.map((a) => a.id));
    return getRecommendedApps(detectedNames, altsData)
      .map((rec) => ({
        ...rec,
        alternatives: rec.alternatives.filter((alt) => alt.appSlug && storeSlugs.has(alt.appSlug)),
      }))
      .filter((rec) => rec.alternatives.length > 0);
  }, [altsData, detectedNames, storeApps]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Pre-select popular/recommended ones
  const toggleApp = (slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  };

  const buildApps = (): OnboardingApp[] => {
    const apps: OnboardingApp[] = [];
    for (const rec of recommendations) {
      for (const alt of rec.alternatives) {
        if (alt.appSlug && selected.has(alt.appSlug)) {
          // Try to find the URN from the store
          const storeApp = storeApps.find((a) => a.id === alt.appSlug);
          apps.push({
            appSlug: alt.appSlug,
            name: alt.name,
            icon: alt.icon,
            category: rec.category,
            replacesNames: rec.proprietary,
            urn: storeApp?.urn,
            localSubdomain: alt.appSlug,
          });
        }
      }
    }
    return apps;
  };

  const handleContinue = () => {
    onSelect?.(buildApps());
  };

  // In embedded (single-form) mode, surface the live selection to the parent as the user toggles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: emit when the selection changes
  useEffect(() => {
    if (embedded && onChange) onChange(buildApps());
  }, [embedded, selected, recommendations, onChange]);

  const categoryLabels: Record<string, string> = {
    utilities: '🔧 Utilities',
    social: '💬 Social & Communication',
    development: '💻 Development',
    data: '📊 Data & Storage',
    media: '🎬 Media & Design',
    automation: '🤖 Automation',
    security: '🔒 Security',
    photography: '📷 Photography',
    finance: '💰 Finance',
    ai: '🧠 AI',
  };

  // Group by category
  const byCategory = new Map<string, typeof recommendations>();
  for (const rec of recommendations) {
    const existing = byCategory.get(rec.category) || [];
    existing.push(rec);
    byCategory.set(rec.category, existing);
  }

  return (
    <WizardCard>
      <WizardHeader
        icon={<LayoutGrid />}
        title="Recommended Apps"
        description={
          detectedServices.length > 0
            ? `We found ${detectedServices.length} Docker service${detectedServices.length > 1 ? 's' : ''} on this device. Here are some open-source alternatives you might like.`
            : 'Here are some popular open-source apps you can self-host.'
        }
      />

      {isAltsError && (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load app recommendations
          {altsError instanceof Error ? `: ${altsError.message}` : ''}.{' '}
          <button type="button" className="font-medium underline" onClick={() => refetch()}>
            Retry
          </button>
        </div>
      )}

      {detectedServices.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {detectedServices.map((s) => (
            <span key={s.friendlyName} className="rounded-full border border-border bg-foreground/[0.03] px-2 py-1 text-xs text-muted-foreground">
              {s.friendlyName}
            </span>
          ))}
        </div>
      )}

      <div className="max-h-[400px] space-y-6 overflow-y-auto pr-2">
        {isAltsLoading && (
          <div className="space-y-3 py-4">
            <div className="h-4 w-[75%] max-w-md animate-pulse rounded bg-muted" />
            <div className="h-4 w-1/2 max-w-sm animate-pulse rounded bg-muted" />
            <div className="h-24 animate-pulse rounded-lg bg-muted/50" />
          </div>
        )}
        {!isAltsLoading && !isAltsError && recommendations.length === 0 && altsData && Object.keys(altsData).length > 0 && (
          <p className="py-4 text-sm text-muted-foreground">
            No matching apps are available in your store yet. You can skip this step or sync the app store.
          </p>
        )}
        {Array.from(byCategory.entries()).map(([category, recs]) => (
          <div key={category}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{categoryLabels[category] || category}</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {recs.flatMap((rec) =>
                rec.alternatives
                  .filter((alt) => alt.appSlug)
                  .map((alt) => {
                    const slug = alt.appSlug as string;
                    const isSelected = selected.has(slug);
                    return (
                      <button
                        type="button"
                        key={slug}
                        onClick={() => toggleApp(slug)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors',
                          isSelected
                            ? 'border-primary bg-primary/[0.06] ring-1 ring-primary/30'
                            : 'border-border bg-foreground/[0.015] hover:border-primary/40',
                        )}
                      >
                        <img
                          src={alt.icon}
                          alt=""
                          className="h-7 w-7 rounded"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{alt.name}</div>
                          <div className="truncate text-xs text-muted-foreground">Replaces {rec.proprietary.join(', ')}</div>
                        </div>
                        <SelectIndicator selected={isSelected} />
                      </button>
                    );
                  }),
              )}
            </div>
          </div>
        ))}
      </div>

      {!embedded && (
        <WizardNav>
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onSkip}>
              Skip to Install
            </Button>
            <Button intent="primary" onClick={handleContinue} disabled={selected.size === 0}>
              Continue with {selected.size} app{selected.size === 1 ? '' : 's'}
            </Button>
          </div>
        </WizardNav>
      )}
    </WizardCard>
  );
};
