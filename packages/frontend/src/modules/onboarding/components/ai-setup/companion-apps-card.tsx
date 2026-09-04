import { findCatalogAppBySlug } from '@/lib/marketplace-app-slug';
import { Shield } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExposureMode } from '../../helpers/ai-setup-types';
import type { OnboardingApp } from '../../helpers/types';
import { useMarketplaceCatalogApps } from '../../helpers/use-marketplace-catalog-apps';
import { SelectIndicator, StepSection } from './primitives';

/** Companion Memory is pre-selected during onboarding when its catalog entry is available. */
export const COMPANION_ONBOARDING_SLUGS = ['ci-memory'] as const;

interface CompanionAppsCardProps {
  /** Resolved public-web exposure mode (Cloudflare preferred, with fallbacks). */
  publicExposureMode: ExposureMode;
  onChange?: (apps: OnboardingApp[]) => void;
}

export function CompanionAppsCard({ publicExposureMode, onChange }: CompanionAppsCardProps) {
  const { t } = useTranslation();
  const { apps: storeApps, isLoading: isCatalogLoading, isRetryingEmptyCatalog } = useMarketplaceCatalogApps();

  const catalogApps = useMemo(
    () =>
      COMPANION_ONBOARDING_SLUGS.map((slug) => {
        const storeApp = findCatalogAppBySlug(storeApps, slug);
        return {
          slug,
          name: t('ONBOARDING_COMPANION_MEMORY_TITLE'),
          storeName: storeApp?.name ?? slug,
          urn: storeApp?.urn,
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
  const memorySlug = COMPANION_ONBOARDING_SLUGS[0];
  const memoryApp = catalogApps[0];
  const memorySelected = selected.has(memorySlug);
  const memoryAvailable = Boolean(memoryApp?.available);

  return (
    <StepSection
      number={5}
      badge="recommended"
      title={t('ONBOARDING_COMPANION_MEMORY_TITLE')}
      description={t('ONBOARDING_COMPANION_MEMORY_DESC')}
      selected={memorySelected}
      onSelect={() => toggleApp(memorySlug, memoryAvailable)}
      selectionDisabled={showLoadingState || !memoryAvailable}
      selectionTestId="companion-app-ci-memory"
      action={<SelectIndicator selected={memorySelected} />}
    >
      <div data-testid="companion-apps-card">
        <div
          className="mb-4 flex items-start gap-2 rounded-md border border-ci-success-border bg-ci-success-bg p-3"
          data-testid="companion-privacy-callout"
        >
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-ci-success" aria-hidden="true" />
          <p className="text-sm text-ci-success">{t('ONBOARDING_COMPANION_PRIVACY_CALLOUT')}</p>
        </div>

        {showLoadingState ? (
          <div className="space-y-2">
            {COMPANION_ONBOARDING_SLUGS.map((slug) => (
              <div key={slug} className="h-16 animate-pulse rounded-md bg-muted/50" data-testid="companion-app-skeleton" />
            ))}
            <p className="text-xs text-muted-foreground">{t('ONBOARDING_CATALOG_LOADING')}</p>
          </div>
        ) : null}
      </div>
    </StepSection>
  );
}
