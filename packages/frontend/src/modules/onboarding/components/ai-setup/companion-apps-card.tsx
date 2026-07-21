import { findCatalogAppBySlug } from '@/lib/marketplace-app-slug';
import { cn } from '@/lib/utils';
import { Shield } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExposureMode } from '../../helpers/ai-setup-types';
import type { OnboardingApp } from '../../helpers/types';
import { useMarketplaceCatalogApps } from '../../helpers/use-marketplace-catalog-apps';
import { OnboardingAppIcon } from '../onboarding-app-icon';
import { SelectIndicator, StepSection } from './primitives';

/** First-party CI apps pre-selected during onboarding. */
export const COMPANION_ONBOARDING_SLUGS = ['ci-memory', 'ci-import-tools'] as const;

const COMPANION_DESCRIPTION_KEYS: Record<(typeof COMPANION_ONBOARDING_SLUGS)[number], string> = {
  'ci-memory': 'ONBOARDING_COMPANION_MEMORY_DESC',
  'ci-import-tools': 'ONBOARDING_COMPANION_IMPORT_TOOLS_DESC',
};

const COMPANION_NAME_KEYS: Partial<Record<(typeof COMPANION_ONBOARDING_SLUGS)[number], string>> = {
  'ci-memory': 'ONBOARDING_COMPANION_MEMORY_TITLE',
  'ci-import-tools': 'ONBOARDING_COMPANION_IMPORT_TOOLS_NAME',
};

interface CompanionAppsCardProps {
  /** Resolved public-web exposure mode (Cloudflare preferred, with fallbacks). */
  publicExposureMode: ExposureMode;
  onChange?: (apps: OnboardingApp[]) => void;
}

export function CompanionAppsCard({ publicExposureMode, onChange }: CompanionAppsCardProps) {
  const { t } = useTranslation();
  const { apps: storeApps, isLoading: isCatalogLoading, isCatalogSettled, isRetryingEmptyCatalog } = useMarketplaceCatalogApps();

  const catalogApps = useMemo(
    () =>
      COMPANION_ONBOARDING_SLUGS.map((slug) => {
        const storeApp = findCatalogAppBySlug(storeApps, slug);
        return {
          slug,
          name: COMPANION_NAME_KEYS[slug] ? t(COMPANION_NAME_KEYS[slug]) : (storeApp?.name ?? slug),
          storeName: storeApp?.name ?? slug,
          urn: storeApp?.urn,
          icon: storeApp?.icon ?? undefined,
          shortDesc: storeApp?.short_desc ?? '',
          available: Boolean(storeApp?.urn),
        };
      }),
    [storeApps, t],
  );

  const availableSlugs = useMemo(() => catalogApps.filter((a) => a.available).map((a) => a.slug), [catalogApps]);

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const userModifiedSelection = useRef(false);
  const lastPreselectedSlugs = useRef<string>('');

  useEffect(() => {
    if (isCatalogLoading || isRetryingEmptyCatalog) return;

    const slugKey = availableSlugs.slice().sort().join('|');
    if (slugKey === lastPreselectedSlugs.current) return;

    if (userModifiedSelection.current) {
      lastPreselectedSlugs.current = slugKey;
      return;
    }

    lastPreselectedSlugs.current = slugKey;
    if (availableSlugs.length > 0) {
      setSelected(new Set(availableSlugs));
    }
  }, [availableSlugs, isCatalogLoading, isRetryingEmptyCatalog]);

  const toggleApp = (slug: string, available: boolean) => {
    if (!available) return;
    userModifiedSelection.current = true;
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
    for (const entry of catalogApps) {
      if (!entry.available || !selected.has(entry.slug)) continue;
      apps.push({
        appSlug: entry.slug,
        name: entry.name,
        storeName: entry.storeName,
        icon: '',
        category: 'companion-intelligence',
        replacesNames: [],
        urn: entry.urn,
        localSubdomain: entry.slug,
        exposureMode: publicExposureMode,
      });
    }
    return apps;
  };

  const lastEmittedSignature = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: buildApps is derived from selected/catalogApps/publicExposureMode
  useEffect(() => {
    if (!onChange || isCatalogLoading || isRetryingEmptyCatalog) return;
    const apps = buildApps();
    const signature = `${apps
      .map((a) => `${a.appSlug}:${a.exposureMode}`)
      .sort()
      .join('|')}|${publicExposureMode}`;
    if (signature === lastEmittedSignature.current) return;
    lastEmittedSignature.current = signature;
    onChange(apps);
  }, [selected, catalogApps, publicExposureMode, onChange, isCatalogLoading, isRetryingEmptyCatalog]);

  const showLoadingState = isCatalogLoading || isRetryingEmptyCatalog;
  const showUnavailableCopy = isCatalogSettled && !isRetryingEmptyCatalog;

  return (
    <StepSection
      number={5}
      badge="recommended"
      title={t('ONBOARDING_COMPANION_MEMORY_TITLE')}
      description={t('ONBOARDING_COMPANION_MEMORY_SECTION_DESC')}
    >
      <div data-testid="companion-apps-card">
        <div
          className="mb-4 flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3"
          data-testid="companion-privacy-callout"
        >
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          <p className="text-sm text-emerald-900 dark:text-emerald-100">{t('ONBOARDING_COMPANION_PRIVACY_CALLOUT')}</p>
        </div>

        {showLoadingState ? (
          <div className="space-y-2">
            {COMPANION_ONBOARDING_SLUGS.map((slug) => (
              <div key={slug} className="h-16 animate-pulse rounded-md bg-muted/50" data-testid="companion-app-skeleton" />
            ))}
            <p className="text-xs text-muted-foreground">{t('ONBOARDING_CATALOG_LOADING')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {catalogApps.map((app) => {
              const isSelected = selected.has(app.slug);
              const descriptionKey = COMPANION_DESCRIPTION_KEYS[app.slug];
              const description = t(descriptionKey);
              return (
                <button
                  type="button"
                  key={app.slug}
                  data-testid={`companion-app-${app.slug}`}
                  disabled={!app.available}
                  onClick={() => toggleApp(app.slug, app.available)}
                  className={cn(
                    'group relative flex items-start gap-3 rounded-md border p-3 text-left transition-colors',
                    !app.available && 'cursor-not-allowed opacity-60',
                    app.available && isSelected
                      ? 'border-primary bg-primary/[0.08] ring-1 ring-primary/30'
                      : 'border-border bg-card/40 hover:border-primary/40',
                  )}
                >
                  <OnboardingAppIcon app={{ appSlug: app.slug, name: app.name, icon: app.icon ?? '', urn: app.urn }} size={40} />
                  <span className="min-w-0 flex-1 pr-5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="block truncate text-base font-medium">{app.name}</span>
                      <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                        {t('ONBOARDING_BUILT_BY_COMPANION')}
                      </span>
                    </span>
                    {description && <span className="mt-0.5 block text-sm leading-snug text-muted-foreground line-clamp-2">{description}</span>}
                    {!app.available && showUnavailableCopy && (
                      <span className="mt-1 block text-sm text-muted-foreground">{t('ONBOARDING_COMPANION_APP_UNAVAILABLE')}</span>
                    )}
                  </span>
                  {app.available && (
                    <span className="absolute right-1.5 top-1.5">
                      <SelectIndicator selected={isSelected} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </StepSection>
  );
}
