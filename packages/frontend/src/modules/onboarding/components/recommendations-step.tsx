import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { portalAlternativesQueryOptions } from '@/lib/portal-alternatives';
import { useQuery } from '@tanstack/react-query';
import { LayoutGrid } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getRecommendedApps } from '../helpers/alternatives';
import type { DetectedService } from '../helpers/service-detection';
import type { OnboardingApp } from '../helpers/types';
import { useMarketplaceCatalogApps } from '../helpers/use-marketplace-catalog-apps';
import { SelectIndicator } from './ai-setup/primitives';
import { OnboardingAppIcon } from './onboarding-app-icon';
import { WizardCard, WizardHeader, WizardNav } from './wizard-ui';

interface RecommendationsStepProps {
  detectedServices: DetectedService[];
  onSelect?: (apps: OnboardingApp[]) => void;
  onSkip?: () => void;
  onBack?: () => void;
  /** Section mode for the single-page form: hides nav and emits the live selection via onChange. */
  embedded?: boolean;
  onChange?: (apps: OnboardingApp[]) => void;
  /** App slugs that are always shown at the top and pre-selected by default. */
  pinnedSlugs?: string[];
}

export const RecommendationsStep = ({
  detectedServices,
  onSelect,
  onSkip,
  onBack,
  embedded = false,
  onChange,
  pinnedSlugs = [],
}: RecommendationsStepProps) => {
  const { t } = useTranslation();
  const { apps: storeApps } = useMarketplaceCatalogApps();
  // Memoized so the `recommendations` memo below keeps a stable identity across re-renders
  // (an unstable detectedNames array would invalidate it every render and re-fire the emit effect).
  const detectedNames = useMemo(() => detectedServices.map((s) => s.friendlyName), [detectedServices]);
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

  // Pinned apps that exist in the store, shown at the top and pre-selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pinnedSlugs is stable (passed from parent constant)
  const pinnedApps = useMemo(
    () => pinnedSlugs.map((slug) => storeApps.find((a) => a.id === slug)).filter((a): a is NonNullable<typeof a> => a != null),
    [storeApps],
  );

  const [selected, setSelected] = useState<Set<string>>(() => new Set(pinnedSlugs.filter((slug) => storeApps.some((a) => a.id === slug))));

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
    // Include pinned apps that are selected
    for (const app of pinnedApps) {
      if (selected.has(app.id)) {
        apps.push({
          appSlug: app.id,
          name: app.name,
          icon: '',
          category: 'featured',
          replacesNames: [],
          urn: app.urn,
          localSubdomain: app.id,
        });
      }
    }
    // Include alt-derived apps that are selected
    for (const rec of recommendations) {
      for (const alt of rec.alternatives) {
        if (alt.appSlug && selected.has(alt.appSlug) && !pinnedSet.has(alt.appSlug)) {
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
  // Gate on a stable signature of the selected slugs so an unchanged selection reuses the previous
  // array reference instead of emitting a fresh one — otherwise onChange -> parent setState ->
  // re-render -> effect re-run would loop indefinitely.
  const lastEmittedSignature = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: buildApps is derived from selected/recommendations/storeApps
  useEffect(() => {
    if (!embedded || !onChange) return;
    const apps = buildApps();
    const signature = apps
      .map((a) => a.appSlug)
      .sort()
      .join('|');
    if (signature === lastEmittedSignature.current) return;
    lastEmittedSignature.current = signature;
    onChange(apps);
  }, [embedded, selected, recommendations, storeApps, onChange]);

  // Flatten the per-category recommendations into a single list for the grid, enriching each
  // entry with the store app's short description so the cards explain what the app is for.
  const pinnedSet = new Set(pinnedSlugs);
  const flatAppsFromAlts = recommendations.flatMap((rec) =>
    rec.alternatives
      .filter((alt) => alt.appSlug && !pinnedSet.has(alt.appSlug))
      .map((alt) => {
        const storeApp = storeApps.find((a) => a.id === alt.appSlug);
        return {
          slug: alt.appSlug as string,
          name: alt.name,
          icon: alt.icon,
          urn: storeApp?.urn,
          replaces: rec.proprietary.join(', '),
          shortDesc: storeApp?.short_desc ?? '',
        };
      }),
  );
  const flatApps = [
    ...pinnedApps.map((app) => ({
      slug: app.id,
      name: app.name,
      icon: '',
      urn: app.urn,
      replaces: '',
      shortDesc: app.short_desc ?? '',
    })),
    ...flatAppsFromAlts,
  ];

  const content = (
    <>
      {isAltsError && (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t('APP_STORE_COULD_NOT_LOAD_RECOMMENDATIONS')}
          {altsError instanceof Error ? `: ${altsError.message}` : ''}.{' '}
          <button type="button" className="font-medium underline" onClick={() => refetch()}>
            {t('COMMON_RETRY')}
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
          <p className="py-4 text-sm text-muted-foreground">{t('ONBOARDING_NO_MATCHING_STORE_APPS')}</p>
        )}
        {flatApps.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {flatApps.map((app) => {
              const isSelected = selected.has(app.slug);
              const description = app.shortDesc || (app.replaces ? t('ONBOARDING_OPEN_SOURCE_ALTERNATIVE_TO', { replaces: app.replaces }) : '');
              return (
                <button
                  type="button"
                  key={app.slug}
                  data-testid="recommended-app"
                  title={app.replaces ? t('ONBOARDING_RECOMMENDED_APP_REPLACES_TITLE', { name: app.name, replaces: app.replaces }) : app.name}
                  onClick={() => toggleApp(app.slug)}
                  className={cn(
                    'group relative flex items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                    isSelected
                      ? 'border-primary bg-primary/[0.08] ring-1 ring-primary/30'
                      : 'border-border bg-foreground/[0.015] hover:border-primary/40',
                  )}
                >
                  <OnboardingAppIcon app={{ appSlug: app.slug, name: app.name, icon: app.icon, urn: app.urn }} size={40} />
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
            {t('COMMON_BACK')}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onSkip}>
              {t('ONBOARDING_SKIP_TO_INSTALL')}
            </Button>
            <Button intent="primary" onClick={handleContinue} disabled={selected.size === 0}>
              {t('ONBOARDING_CONTINUE_WITH_APPS', { count: selected.size })}
            </Button>
          </div>
        </WizardNav>
      )}
    </>
  );

  if (embedded) return content;

  return (
    <WizardCard>
      <WizardHeader
        icon={<LayoutGrid />}
        title={t('ONBOARDING_RECOMMENDED_APPS')}
        description={
          detectedServices.length > 0
            ? t('ONBOARDING_RECOMMENDED_APPS_FOUND_SERVICES_DESC', { count: detectedServices.length })
            : t('ONBOARDING_RECOMMENDED_APPS_DESC')
        }
      />
      {content}
    </WizardCard>
  );
};
