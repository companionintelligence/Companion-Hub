import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { useAppContext } from '@/context/app-context';
import { portalAlternativesQueryOptions } from '@/lib/portal-alternatives';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { getRecommendedApps } from '../helpers/alternatives';
import type { DetectedService } from '../helpers/service-detection';
import type { OnboardingApp } from '../helpers/types';

interface RecommendationsStepProps {
  detectedServices: DetectedService[];
  onSelect: (apps: OnboardingApp[]) => void;
  onSkip: () => void;
  onBack: () => void;
}

export const RecommendationsStep = ({ detectedServices, onSelect, onSkip, onBack }: RecommendationsStepProps) => {
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

  const handleContinue = () => {
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
    onSelect(apps);
  };

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
    <Card>
      <CardContent className="p-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold mb-1">Recommended Apps</h2>
          {isAltsError && (
            <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Could not load alternatives from the portal
              {altsError instanceof Error ? `: ${altsError.message}` : ''}.{' '}
              <button type="button" className="underline font-medium" onClick={() => refetch()}>
                Retry
              </button>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {detectedServices.length > 0
              ? `We detected ${detectedServices.length} service${detectedServices.length > 1 ? 's' : ''} running. Here are some open-source alternatives you might like.`
              : 'Here are some popular open-source apps you can self-host.'}
          </p>
          {detectedServices.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {detectedServices.map((s) => (
                <span key={s.friendlyName} className="text-xs bg-muted px-2 py-1 rounded-full">
                  {s.friendlyName}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="max-h-[400px] overflow-y-auto space-y-6 pr-2">
          {isAltsLoading && (
            <div className="space-y-3 py-4">
              <div className="h-4 max-w-md w-[75%] animate-pulse rounded bg-muted" />
              <div className="h-4 max-w-sm w-1/2 animate-pulse rounded bg-muted" />
              <div className="h-24 animate-pulse rounded-lg bg-muted/50" />
            </div>
          )}
          {!isAltsLoading && !isAltsError && recommendations.length === 0 && altsData && Object.keys(altsData).length > 0 && (
            <p className="text-sm text-muted-foreground py-4">
              No matching apps are available in your store yet. You can skip this step or sync the app store.
            </p>
          )}
          {Array.from(byCategory.entries()).map(([category, recs]) => (
            <div key={category}>
              <h3 className="text-sm font-medium text-muted-foreground mb-2">{categoryLabels[category] || category}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {recs.flatMap((rec) =>
                  rec.alternatives
                    .filter((alt) => alt.appSlug)
                    .map((alt) => {
                      const slug = alt.appSlug as string;
                      return (
                        <button
                          type="button"
                          key={slug}
                          className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors text-left w-full"
                          onClick={() => toggleApp(slug)}
                        >
                          <Checkbox checked={selected.has(slug)} onCheckedChange={() => toggleApp(slug)} />
                          <img
                            src={alt.icon}
                            alt=""
                            className="w-6 h-6 rounded"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">{alt.name}</div>
                            <div className="text-xs text-muted-foreground truncate">Replaces {rec.proprietary.join(', ')}</div>
                          </div>
                        </button>
                      );
                    }),
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-between mt-6">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onSkip}>
              Skip
            </Button>
            <Button intent="primary" onClick={handleContinue} disabled={selected.size === 0}>
              Continue with {selected.size} app{selected.size === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
