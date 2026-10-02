import { findCatalogAppBySlug } from '@/lib/marketplace-app-slug';
import { Shield } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExposureMode } from '../../helpers/ai-setup-types';
import type { OnboardingApp } from '../../helpers/types';
import { useMarketplaceCatalogApps } from '../../helpers/use-marketplace-catalog-apps';
import { cn } from '@/lib/utils';
import { CompanionMemoryMark } from './companion-memory-mark';
import { SelectIndicator, StepSection } from './primitives';

/** Companion Memory is the first-party memory provider offered by the Hub. */
export const COMPANION_ONBOARDING_SLUGS = ['ci-memory'] as const;

interface CompanionAppsCardProps {
  /** Resolved public-web exposure mode (Cloudflare preferred, with fallbacks). */
  publicExposureMode: ExposureMode;
  onChange?: (apps: OnboardingApp[]) => void;
  /** Wizard step number. A weak machine skips the local-model steps, so this moves up. */
  stepNumber?: number;
}

export function CompanionAppsCard({ publicExposureMode, onChange, stepNumber = 5 }: CompanionAppsCardProps) {
  const { t } = useTranslation();
  const { apps: storeApps, isLoading: isCatalogLoading, isRetryingEmptyCatalog } = useMarketplaceCatalogApps();

  const catalogApps = useMemo(
    () =>
      COMPANION_ONBOARDING_SLUGS.map((slug) => {
        const storeApp = findCatalogAppBySlug(storeApps, slug);
        return {
          slug,
          name: t('ONBOARDING_COMPANION_MEMORY_TITLE'),
          storeName: storeApp?.name ?? t('ONBOARDING_COMPANION_MEMORY_TITLE'),
          icon: storeApp?.icon ?? '',
          // Keep the canonical Portal/CI Marketplace identity even while the local catalog is
          // still warming. The install request can then resolve the first-party app from Portal.
          urn: storeApp?.urn ?? `${slug}:ci-marketplace`,
          available: true,
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
        icon: entry.icon,
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
      .map((a) => `${a.appSlug}:${a.urn ?? ''}:${a.exposureMode}`)
      .sort()
      .join('|')}|${publicExposureMode}`;
    if (signature === lastEmittedSignature.current) return;
    lastEmittedSignature.current = signature;
    onChange(apps);
  }, [selected, catalogApps, publicExposureMode, onChange, isCatalogLoading, isRetryingEmptyCatalog]);

  const showLoadingState = isCatalogLoading || isRetryingEmptyCatalog;
  const memorySlug = COMPANION_ONBOARDING_SLUGS[0];
  const memoryApp = catalogApps[0] ?? {
    slug: memorySlug,
    name: t('ONBOARDING_COMPANION_MEMORY_TITLE'),
    storeName: t('ONBOARDING_COMPANION_MEMORY_TITLE'),
    icon: '',
    urn: `${memorySlug}:ci-marketplace`,
    available: true,
  };
  const memorySelected = selected.has(memorySlug);
  const memoryAvailable = Boolean(memoryApp?.available) && !showLoadingState;

  return (
    <StepSection number={stepNumber} title={t('ONBOARDING_COMPANION_MEMORY_TITLE')} description={t('ONBOARDING_COMPANION_MEMORY_DESC')}>
      <div data-testid="companion-apps-card">
        <div className="mb-4 flex items-start gap-2 rounded-md border border-success/30 bg-success/10 p-3" data-testid="companion-privacy-callout">
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          <p className="text-sm text-success">{t('ONBOARDING_COMPANION_PRIVACY_CALLOUT')}</p>
        </div>

        {showLoadingState ? (
          <div className="space-y-2">
            {COMPANION_ONBOARDING_SLUGS.map((slug) => (
              <div key={slug} className="h-16 animate-pulse rounded-md bg-muted/50" data-testid="companion-app-skeleton" />
            ))}
            <p className="text-xs text-muted-foreground">{t('ONBOARDING_CATALOG_LOADING')}</p>
          </div>
        ) : (
          <label
            className={cn(
              'relative flex min-h-20 cursor-pointer items-center gap-3 rounded-lg border p-4 transition-colors focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2',
              memorySelected
                ? 'border-primary/70 bg-primary/[0.08] ring-1 ring-primary/30'
                : 'border-border bg-foreground/[0.015] hover:border-primary/50 hover:bg-primary/[0.04]',
              !memoryAvailable && 'cursor-not-allowed opacity-60',
            )}
            data-testid="companion-memory-option"
            htmlFor="companion-memory-checkbox"
          >
            <span data-testid="companion-app-ci-memory" className="contents">
              <input
                id="companion-memory-checkbox"
                type="checkbox"
                checked={memorySelected}
                disabled={!memoryAvailable}
                aria-label={t('ONBOARDING_COMPANION_MEMORY_TITLE')}
                onChange={() => toggleApp(memorySlug, memoryAvailable)}
                className="sr-only"
              />
            </span>
            <CompanionMemoryMark size={120} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-foreground">{memoryApp.name}</span>
                <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                  {t('ONBOARDING_BADGE_RECOMMENDED')}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{t('ONBOARDING_COMPANION_MEMORY_SECTION_DESC')}</p>
            </div>
            <SelectIndicator selected={memorySelected} className="h-6 w-6 shrink-0 rounded-md" />
          </label>
        )}
      </div>
    </StepSection>
  );
}
