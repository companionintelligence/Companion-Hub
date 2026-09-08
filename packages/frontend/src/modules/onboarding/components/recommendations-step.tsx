import { Button } from '@/components/ui/Button';
import { catalogAppSlug, findCatalogAppBySlug } from '@/lib/marketplace-app-slug';
import { cn } from '@/lib/utils';
import { portalAlternativesQueryOptions } from '@/lib/portal-alternatives';
import { getCategoryLabel } from '@/modules/app/helpers/category-label';
import { iconForCategory } from '@/modules/app/helpers/table-helpers';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, LayoutGrid } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { getAllAlternatives } from '../helpers/alternatives';
import { ONBOARDING_TOP_ALTERNATIVES } from '../helpers/onboarding-curated-picks';
import type { DetectedService } from '../helpers/service-detection';
import type { OnboardingApp } from '../helpers/types';
import { useMarketplaceCatalogApps } from '../helpers/use-marketplace-catalog-apps';
import { SelectIndicator } from './ai-setup/primitives';
import { OnboardingAppIcon } from './onboarding-app-icon';
import { WizardCard, WizardHeader, WizardNav } from './wizard-ui';

type RecommendationRow = {
  category: string;
  icon: string;
  name: string;
  replaces: Array<{ name: string; icon: string }>;
  slug: string;
  storeName: string;
  urn: string;
};

const RECOMMENDATIONS_COUNT = ONBOARDING_TOP_ALTERNATIVES.length;

const CATEGORY_ACCENTS: Record<string, { icon: string; header: string; pill: string }> = {
  ai: { icon: 'text-cyan-700 dark:text-cyan-300', header: 'bg-cyan-400/15 dark:bg-cyan-400/10', pill: 'bg-cyan-400/15 text-cyan-800 dark:bg-cyan-400/10 dark:text-cyan-100' },
  automation: { icon: 'text-indigo-700 dark:text-indigo-300', header: 'bg-indigo-400/15 dark:bg-indigo-400/10', pill: 'bg-indigo-400/15 text-indigo-800 dark:bg-indigo-400/10 dark:text-indigo-100' },
  data: { icon: 'text-emerald-700 dark:text-emerald-300', header: 'bg-emerald-400/15 dark:bg-emerald-400/10', pill: 'bg-emerald-400/15 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-100' },
  development: { icon: 'text-rose-700 dark:text-rose-300', header: 'bg-rose-400/15 dark:bg-rose-400/10', pill: 'bg-rose-400/15 text-rose-800 dark:bg-rose-400/10 dark:text-rose-100' },
  finance: { icon: 'text-amber-800 dark:text-amber-300', header: 'bg-amber-400/15 dark:bg-amber-400/10', pill: 'bg-amber-400/15 text-amber-900 dark:bg-amber-400/10 dark:text-amber-100' },
  media: { icon: 'text-violet-700 dark:text-violet-300', header: 'bg-violet-400/15 dark:bg-violet-400/10', pill: 'bg-violet-400/15 text-violet-800 dark:bg-violet-400/10 dark:text-violet-100' },
  photography: { icon: 'text-fuchsia-700 dark:text-fuchsia-300', header: 'bg-fuchsia-400/15 dark:bg-fuchsia-400/10', pill: 'bg-fuchsia-400/15 text-fuchsia-800 dark:bg-fuchsia-400/10 dark:text-fuchsia-100' },
  security: { icon: 'text-amber-800 dark:text-amber-300', header: 'bg-amber-400/15 dark:bg-amber-400/10', pill: 'bg-amber-400/15 text-amber-900 dark:bg-amber-400/10 dark:text-amber-100' },
  social: { icon: 'text-sky-700 dark:text-sky-300', header: 'bg-sky-400/15 dark:bg-sky-400/10', pill: 'bg-sky-400/15 text-sky-800 dark:bg-sky-400/10 dark:text-sky-100' },
  utilities: { icon: 'text-slate-700 dark:text-slate-300', header: 'bg-slate-400/15 dark:bg-slate-400/10', pill: 'bg-slate-400/15 text-slate-800 dark:bg-slate-400/10 dark:text-slate-100' },
};

const DEFAULT_CATEGORY_ACCENT = { icon: 'text-primary', header: 'bg-primary/10', pill: 'bg-primary/10 text-primary' };

/**
 * The Portal normally supplies these icons. Keep a small name-to-domain fallback so the chart
 * still has recognizable private-app marks while a local Hub is using a partial/mock catalog.
 */
const PRIVATE_APP_FAVICON_URLS: Record<string, string> = {
  'adobe acrobat': 'https://www.adobe.com/acrobat',
  adguard: 'https://adguard.com',
  airdrop: 'https://support.apple.com/en-us/HT204144',
  'amazon alexa': 'https://alexa.amazon.com',
  'apple homekit': 'https://www.apple.com/home-app',
  asana: 'https://asana.com',
  airtable: 'https://airtable.com',
  chatgpt: 'https://chatgpt.com',
  claude: 'https://claude.ai',
  cursor: 'https://cursor.sh',
  discord: 'https://discord.com',
  dropbox: 'https://www.dropbox.com',
  evernote: 'https://evernote.com',
  figma: 'https://www.figma.com',
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
  'google drive': 'https://drive.google.com',
  'google home': 'https://home.google.com',
  'google photos': 'https://photos.google.com',
  'google workspace': 'https://workspace.google.com',
  'icloud photos': 'https://www.icloud.com/photos',
  jira: 'https://www.atlassian.com/software/jira',
  lastpass: 'https://www.lastpass.com',
  make: 'https://www.make.com',
  'microsoft office': 'https://www.microsoft.com/microsoft-365',
  'microsoft teams': 'https://www.microsoft.com/teams',
  miro: 'https://miro.com',
  mural: 'https://www.mural.co',
  nextdns: 'https://nextdns.io',
  notion: 'https://www.notion.so',
  'rocket money': 'https://www.rocketmoney.com',
  sketch: 'https://www.sketch.com',
  slack: 'https://slack.com',
  smallpdf: 'https://smallpdf.com',
  trello: 'https://trello.com',
  'vs code': 'https://code.visualstudio.com',
  ynab: 'https://www.ynab.com',
  zapier: 'https://zapier.com',
  zoom: 'https://zoom.us',
  '1password': 'https://1password.com',
};

function normalizedAppName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function faviconForUrl(url: string): string {
  return `https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(url)}`;
}

function privateAppIcon(name: string, metadata: Map<string, { icon: string; url: string | null }>): string {
  const key = normalizedAppName(name);
  const portal = metadata.get(key);
  if (portal?.icon) return portal.icon;
  if (portal?.url) return faviconForUrl(portal.url);
  const fallbackUrl = PRIVATE_APP_FAVICON_URLS[key];
  return fallbackUrl ? faviconForUrl(fallbackUrl) : '';
}

function privateAppTestId(name: string): string {
  return normalizedAppName(name).replace(/[^a-z0-9]+/g, '-');
}

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
  /** Agent app slugs selected in the harness — kept in sync with this step's selection. */
  agentSlugs?: string[];
}

export const RecommendationsStep = ({
  detectedServices,
  onSelect,
  onSkip,
  onBack,
  embedded = false,
  onChange,
  pinnedSlugs = [],
  agentSlugs = [],
}: RecommendationsStepProps) => {
  const { t } = useTranslation();
  const {
    apps: storeApps,
    isLoading: isCatalogLoading,
    isError: isCatalogError,
    refetch: refetchCatalog,
    isRetryingEmptyCatalog,
  } = useMarketplaceCatalogApps();
  // Memoized so the chart and embedded selection effect keep stable inputs across re-renders.
  const detectedNames = useMemo(() => detectedServices.map((s) => s.friendlyName), [detectedServices]);
  const {
    data: altsData,
    isLoading: isAltsLoading,
    isError: isAltsError,
    refetch,
  } = useQuery({
    ...portalAlternativesQueryOptions(),
  });

  const recommendationsLoading = isCatalogLoading || isRetryingEmptyCatalog || isAltsLoading;

  // The chart is a stable, intentionally curated shortlist. Portal metadata enriches it when it is
  // available, while the static name/icon fallback keeps the FTUE useful when a Hub has not synced
  // the full alternatives dataset yet.
  const alternativeMetadata = useMemo(() => {
    const metadata = new Map<string, { icon: string; name: string }>();
    for (const entry of getAllAlternatives(altsData ?? {})) {
      for (const alternative of entry.alternatives) {
        if (alternative.appSlug && !metadata.has(alternative.appSlug)) {
          metadata.set(alternative.appSlug, { icon: alternative.icon, name: alternative.name });
        }
      }
    }
    return metadata;
  }, [altsData]);

  const proprietaryMetadata = useMemo(() => {
    const metadata = new Map<string, { icon: string; url: string | null }>();
    for (const entry of getAllAlternatives(altsData ?? {})) {
      for (const proprietary of entry.proprietary) {
        const key = normalizedAppName(proprietary.name);
        const current = metadata.get(key);
        if (!current || (!current.icon && proprietary.icon)) {
          metadata.set(key, { icon: proprietary.icon, url: proprietary.url });
        }
      }
    }
    return metadata;
  }, [altsData]);

  // Pinned apps that exist in the store, shown at the top and pre-selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pinnedSlugs is stable (passed from parent constant)
  const pinnedApps = useMemo(
    () => pinnedSlugs.map((slug) => findCatalogAppBySlug(storeApps, slug)).filter((a): a is NonNullable<typeof a> => a != null),
    [storeApps],
  );
  const pinnedSet = useMemo(() => new Set(pinnedSlugs), [pinnedSlugs]);

  const topAlternativeApps = useMemo(() => {
    const detected = new Set(detectedNames.map((name) => name.trim().toLowerCase()));

    return ONBOARDING_TOP_ALTERNATIVES.flatMap((pick): RecommendationRow[] => {
      const storeApp = findCatalogAppBySlug(storeApps, pick.slug);
      const portalAlternative = alternativeMetadata.get(pick.slug);
      const name = portalAlternative?.name ?? storeApp?.name ?? pick.name;

      // Keep the same truthfulness rule as the Store chart: don't recommend a service that is
      // already running on this host. The rest of the shortlist remains visible, even when it is
      // not yet synced into this Hub's local marketplace catalog.
      if (detected.has(pick.slug) || detected.has(name.trim().toLowerCase())) return [];

      return [
        {
          category: pick.category,
          // Keep a checked-in local fallback for Vaultwarden while Marketplace image delivery
          // catches up with the catalog asset. Marketplace remains the first source when available.
          icon: pick.icon || storeApp?.icon || portalAlternative?.icon || '',
          name,
          replaces: pick.proprietary.map((proprietaryName) => ({
            name: proprietaryName,
            icon: privateAppIcon(proprietaryName, proprietaryMetadata),
          })),
          slug: pick.slug,
          storeName: storeApp?.name ?? portalAlternative?.name ?? pick.name,
          // The curated shortlist is installable through the CI Marketplace even when this Hub's
          // local catalog has not finished syncing. Preserve the real catalog URN when available.
          urn: storeApp?.urn ?? `${pick.slug}:ci-marketplace`,
        },
      ];
    });
  }, [alternativeMetadata, detectedNames, proprietaryMetadata, storeApps]);

  const [selected, setSelected] = useState<Set<string>>(() => new Set(pinnedSlugs.filter((slug) => findCatalogAppBySlug(storeApps, slug) != null)));

  const prevAgentSlugs = useRef<string[]>([]);
  // Keep recommended-apps selection aligned with the agent harness toggles.
  useEffect(() => {
    const prev = new Set(prevAgentSlugs.current);
    const next = new Set(agentSlugs);
    if (prev.size === next.size && agentSlugs.every((slug) => prev.has(slug))) return;

    setSelected((current) => {
      const updated = new Set(current);
      for (const slug of prev) {
        if (!next.has(slug)) updated.delete(slug);
      }
      for (const slug of agentSlugs) {
        const app = findCatalogAppBySlug(storeApps, slug);
        if (app?.urn) updated.add(slug);
      }
      return updated;
    });
    prevAgentSlugs.current = agentSlugs;
  }, [agentSlugs, storeApps]);

  // Catalog results can arrive after the first render. Keep pinned apps visible and selected once
  // their URNs become available instead of silently dropping them from the FTUE selection.
  useEffect(() => {
    if (pinnedApps.length === 0) return;
    setSelected((current) => {
      const updated = new Set(current);
      let changed = false;
      for (const app of pinnedApps) {
        const slug = catalogAppSlug(app);
        if (slug && app.urn && !updated.has(slug)) {
          updated.add(slug);
          changed = true;
        }
      }
      return changed ? updated : current;
    });
  }, [pinnedApps]);

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
    const agentSlugSet = new Set(agentSlugs);
    // Include harness-selected agent apps first.
    for (const slug of agentSlugs) {
      if (!selected.has(slug)) continue;
      const app = findCatalogAppBySlug(storeApps, slug);
      if (!app?.urn) continue;
      apps.push({
        appSlug: slug,
        name: app.name,
        icon: '',
        category: 'ai',
        replacesNames: [],
        urn: app.urn,
        localSubdomain: slug,
      });
    }
    // Include pinned apps that are selected
    for (const app of pinnedApps) {
      const slug = catalogAppSlug(app);
      if (!slug || !selected.has(slug)) continue;
      apps.push({
        appSlug: slug,
        name: app.name,
        icon: '',
        category: 'featured',
        replacesNames: [],
        urn: app.urn,
        localSubdomain: slug,
      });
    }
    // Include every selected alternative. Curated entries use their canonical CI Marketplace URN
    // when the local catalog has not synced a richer app record yet.
    for (const app of topAlternativeApps) {
      if (!selected.has(app.slug) || pinnedSet.has(app.slug) || agentSlugSet.has(app.slug)) continue;
      apps.push({
        appSlug: app.slug,
        name: app.name,
        storeName: app.storeName,
        icon: app.icon,
        category: app.category,
        replacesNames: app.replaces.map(({ name }) => name),
        urn: app.urn,
        localSubdomain: app.slug,
      });
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: buildApps is derived from selected/topAlternativeApps/storeApps
  useEffect(() => {
    if (!embedded || !onChange) return;
    const apps = buildApps();
    const signature = apps
      .map((a) => `${a.appSlug}:${a.urn ?? ''}`)
      .sort()
      .join('|');
    if (signature === lastEmittedSignature.current) return;
    lastEmittedSignature.current = signature;
    onChange(apps);
  }, [embedded, selected, topAlternativeApps, storeApps, onChange]);

  const alternativeGroups = useMemo(() => {
    const groups = new Map<string, RecommendationRow[]>();
    for (const app of topAlternativeApps) {
      const existing = groups.get(app.category);
      if (existing) existing.push(app);
      else groups.set(app.category, [app]);
    }
    return Array.from(groups, ([category, apps]) => ({ category, apps }));
  }, [topAlternativeApps]);
  const showCatalogLoading = recommendationsLoading;

  const content = (
    <>
      {isCatalogError && (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t('ONBOARDING_RECOMMENDATIONS_UNAVAILABLE')}{' '}
          <button type="button" className="font-medium underline" onClick={() => void refetchCatalog()}>
            {t('COMMON_RETRY')}
          </button>
        </div>
      )}

      {isAltsError && (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t('APP_STORE_COULD_NOT_LOAD_RECOMMENDATIONS')}{' '}
          <button type="button" className="font-medium underline" onClick={() => refetch()}>
            {t('COMMON_RETRY')}
          </button>
        </div>
      )}

      {detectedServices.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {detectedServices.map((s) => (
            <span key={s.friendlyName} className="rounded-full border border-border bg-foreground/[0.03] px-2.5 py-1 text-sm text-muted-foreground">
              {s.friendlyName}
            </span>
          ))}
        </div>
      )}

      <div className="space-y-4" data-testid="recommendations-content">
        {showCatalogLoading && (
          <div className="grid grid-cols-1 gap-3 py-1 sm:grid-cols-2">
            {Array.from({ length: Math.min(RECOMMENDATIONS_COUNT, 6) }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
              <div key={i} className="h-20 animate-pulse rounded-md bg-muted/50" />
            ))}
          </div>
        )}
        {showCatalogLoading && <p className="py-2 text-sm text-muted-foreground">{t('ONBOARDING_RECOMMENDATIONS_LOADING')}</p>}
        {!showCatalogLoading && alternativeGroups.length === 0 && !isCatalogError && !isAltsError && (
          <p className="py-4 text-base text-muted-foreground">{t('ONBOARDING_NO_MATCHING_STORE_APPS')}</p>
        )}
        {!showCatalogLoading && alternativeGroups.length > 0 && (
          <div className="space-y-4" data-testid="recommended-alternatives-chart">
            {alternativeGroups.map(({ category, apps }) => {
              const categoryInfo = iconForCategory.find((entry) => entry.id === category);
              const Icon = categoryInfo?.icon ?? LayoutGrid;
              const accent = CATEGORY_ACCENTS[category] ?? DEFAULT_CATEGORY_ACCENT;

              return (
                <section key={category} className="overflow-hidden rounded-xl border border-border/80 bg-card/20">
                  <div className={cn('flex items-center gap-2 border-b border-border/70 px-3 py-2 sm:px-4', accent.header)}>
                    <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-background/30', accent.icon)}>
                      <Icon className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-foreground">{getCategoryLabel(t, category)}</h3>
                    </div>
                  </div>
                  <div className="divide-y divide-border/60">
                    {apps.map((app) => {
                      const isSelected = selected.has(app.slug);
                      const replaces = app.replaces.map(({ name }) => name).join(', ');

                      return (
                        <div
                          key={app.slug}
                          className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-center sm:grid-cols-2"
                          data-testid={`recommended-app-row-${app.slug}`}
                        >
                          <div className="min-w-0 px-2 py-1 sm:px-4">
                            <div className="flex flex-wrap gap-1">
                              {app.replaces.map(({ name, icon }) => (
                                <span
                                  key={name}
                                  className={cn(
                                    'inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4',
                                    accent.pill,
                                  )}
                                  title={name}
                                  data-testid={`recommended-private-icon-${privateAppTestId(name)}`}
                                >
                                  <OnboardingAppIcon
                                    app={{ appSlug: `private-${privateAppTestId(name)}`, name, icon, urn: undefined }}
                                    size={14}
                                    className="rounded-[3px]"
                                    fallback={<span className="text-[8px] font-bold leading-none">{name.charAt(0).toUpperCase()}</span>}
                                  />
                                  <span className="truncate">{name}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                          <div className="min-w-0 px-2 py-1 sm:px-3 sm:pl-2">
                            <label
                              data-testid="recommended-app"
                              data-app-slug={app.slug}
                              title={t('ONBOARDING_RECOMMENDED_APP_REPLACES_TITLE', { name: app.name, replaces })}
                              className={cn(
                                'relative flex min-h-8 w-full cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-1 text-left text-xs font-medium transition-colors',
                                isSelected
                                  ? 'border-primary/70 bg-primary/15 text-foreground ring-1 ring-primary/30'
                                  : 'border-border/70 bg-background/20 text-foreground hover:border-primary/50 hover:bg-primary/[0.06]',
                              )}
                            >
                              <input
                                type="checkbox"
                                className="absolute inset-0 z-10 h-full w-full cursor-pointer rounded-lg opacity-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                                checked={isSelected}
                                aria-label={app.name}
                                data-testid={`recommended-app-checkbox-${app.slug}`}
                                onChange={() => toggleApp(app.slug)}
                              />
                              <OnboardingAppIcon
                                app={{ appSlug: app.slug, name: app.name, icon: app.icon, urn: app.urn }}
                                size={24}
                                fallback={<Icon className={cn('h-4 w-4', accent.icon)} aria-hidden="true" />}
                              />
                              <span className="min-w-0 flex-1 truncate">{app.name}</span>
                              <SelectIndicator selected={isSelected} className="h-4 w-4 shrink-0 rounded" />
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {!showCatalogLoading && alternativeGroups.length > 0 && (
          <div className="mt-3 flex justify-end">
            <Link to="/store?category=alternatives" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
              {t('ONBOARDING_BROWSE_ALL_ALTERNATIVES')}
              <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
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
