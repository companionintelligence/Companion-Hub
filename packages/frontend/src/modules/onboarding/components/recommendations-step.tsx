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

  // Flatten the per-category recommendations into a single list for the grid, enriching each
  // entry with the store app's short description so the cards explain what the app is for.
  const flatApps = recommendations.flatMap((rec) =>
    rec.alternatives
      .filter((alt) => alt.appSlug)
      .map((alt) => {
        const storeApp = storeApps.find((a) => a.id === alt.appSlug);
        return {
          slug: alt.appSlug as string,
          name: alt.name,
          icon: alt.icon,
          replaces: rec.proprietary.join(', '),
          shortDesc: storeApp?.short_desc ?? '',
        };
      }),
  );

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

      <div className="max-h-[420px] overflow-y-auto pr-1">
        {isAltsLoading && (
          <div className="grid grid-cols-1 gap-3 py-1 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
              <div key={i} className="h-16 animate-pulse rounded-xl bg-muted/50" />
            ))}
          </div>
        )}
        {!isAltsLoading && !isAltsError && flatApps.length === 0 && altsData && Object.keys(altsData).length > 0 && (
          <p className="py-4 text-sm text-muted-foreground">
            No matching apps are available in your store yet. You can skip this step or sync the app store.
          </p>
        )}
        {flatApps.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {flatApps.map((app) => {
              const isSelected = selected.has(app.slug);
              const description = app.shortDesc || (app.replaces ? `Open-source alternative to ${app.replaces}.` : '');
              return (
                <button
                  type="button"
                  key={app.slug}
                  data-testid="recommended-app"
                  title={app.replaces ? `${app.name} — replaces ${app.replaces}` : app.name}
                  onClick={() => toggleApp(app.slug)}
                  className={cn(
                    'group relative flex items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                    isSelected
                      ? 'border-primary bg-primary/[0.08] ring-1 ring-primary/30'
                      : 'border-border bg-foreground/[0.015] hover:border-primary/40',
                  )}
                >
                  <span className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-foreground/10 text-base font-semibold text-muted-foreground">
                    {app.name.charAt(0)}
                    <img
                      src={app.icon}
                      alt=""
                      className="absolute inset-0 h-full w-full object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  </span>
                  <span className="min-w-0 flex-1 pr-5">
                    <span className="block truncate text-sm font-medium">{app.name}</span>
                    {description && <span className="mt-0.5 block text-xs leading-snug text-muted-foreground line-clamp-2">{description}</span>}
                  </span>
                  <span className="absolute right-1.5 top-1.5">
                    <SelectIndicator selected={isSelected} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
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
