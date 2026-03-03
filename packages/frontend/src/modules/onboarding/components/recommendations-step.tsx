import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { useAppContext } from '@/context/app-context';
import { useState } from 'react';
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
  const recommendations = getRecommendedApps(detectedNames);
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
              Continue with {selected.size} app{selected.size !== 1 ? 's' : ''}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
