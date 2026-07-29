import { AppCard } from '@/modules/app/components/app-card/app-card';
import type { HubStoreApp } from '@/lib/portal-store';
import { portalStoreListingsQueryOptions } from '@/lib/portal-store';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

const PREVIEW_COUNT = 4;

const LOADING_APP = { urn: 'loading:loading', name: '', short_desc: '' } as const;

function AppSection({
  title,
  subtitle,
  apps,
  isLoading,
  isError,
  onRetry,
  installedAppUrns,
}: {
  title: string;
  subtitle: string;
  apps: HubStoreApp[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  installedAppUrns: Set<string>;
}) {
  const { t } = useTranslation();
  const gridId = useId();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? apps : apps?.slice(0, PREVIEW_COUNT);
  const hasMore = (apps?.length ?? 0) > PREVIEW_COUNT;

  return (
    <section className="w-full space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
          <p className="text-muted-foreground">{subtitle}</p>
        </div>
        {hasMore && !isLoading && !isError && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={gridId}
            className="flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            {expanded ? (
              <>
                {t('APP_STORE_FEATURED_SHOW_LESS')} <ChevronUp className="h-3.5 w-3.5" />
              </>
            ) : (
              <>
                {t('APP_STORE_FEATURED_VIEW_ALL', { count: apps?.length ?? 0 })} <ChevronDown className="h-3.5 w-3.5" />
              </>
            )}
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: PREVIEW_COUNT }).map((_, i) => (
            <AppCard
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
              key={i}
              app={LOADING_APP}
              isLoading
            />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t('APP_STORE_COULD_NOT_LOAD_FEATURED')}{' '}
          <button type="button" className="font-medium underline" onClick={onRetry}>
            {t('COMMON_RETRY')}
          </button>
        </div>
      ) : apps?.length ? (
        <div id={gridId} className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {visible?.map((app) => (
            <AppCard key={app.urn} app={app} isLoading={false} isInstalled={installedAppUrns.has(app.urn)} imageUrlOverride={app.iconUrl} />
          ))}
        </div>
      ) : (
        <p className="py-4 text-sm text-muted-foreground">{t('APP_STORE_NO_RESULTS')}</p>
      )}
    </section>
  );
}

export function FeaturedStoreView({ storeId, installedAppUrns }: { storeId: string; installedAppUrns: Set<string> }) {
  const { t } = useTranslation();

  const {
    data: firstParty,
    isLoading: loadingFirstParty,
    isError: firstPartyError,
    refetch: refetchFirstParty,
  } = useQuery({
    ...portalStoreListingsQueryOptions({ tags: 'companion-intelligence' }, storeId),
  });
  const {
    data: featured,
    isLoading: loadingFeatured,
    isError: featuredError,
    refetch: refetchFeatured,
  } = useQuery({
    ...portalStoreListingsQueryOptions({ tags: 'featured' }, storeId),
  });
  const {
    data: trending,
    isLoading: loadingTrending,
    isError: trendingError,
    refetch: refetchTrending,
  } = useQuery({
    ...portalStoreListingsQueryOptions({ sort: 'trending' }, storeId),
  });
  const {
    data: newest,
    isLoading: loadingNewest,
    isError: newestError,
    refetch: refetchNewest,
  } = useQuery({
    ...portalStoreListingsQueryOptions({ sort: 'newest' }, storeId),
  });

  return (
    <div className="w-full space-y-10 pb-10">
      <AppSection
        title={t('APP_STORE_FIRST_PARTY_SECTION_TITLE')}
        subtitle={t('APP_STORE_FIRST_PARTY_SECTION_SUBTITLE')}
        apps={firstParty}
        isLoading={loadingFirstParty}
        isError={firstPartyError}
        onRetry={() => void refetchFirstParty()}
        installedAppUrns={installedAppUrns}
      />
      <AppSection
        title={t('APP_STORE_FEATURED_SECTION_TITLE')}
        subtitle={t('APP_STORE_FEATURED_SECTION_SUBTITLE')}
        apps={featured}
        isLoading={loadingFeatured}
        isError={featuredError}
        onRetry={() => void refetchFeatured()}
        installedAppUrns={installedAppUrns}
      />
      <AppSection
        title={t('APP_STORE_TRENDING_SECTION_TITLE')}
        subtitle={t('APP_STORE_TRENDING_SECTION_SUBTITLE')}
        apps={trending}
        isLoading={loadingTrending}
        isError={trendingError}
        onRetry={() => void refetchTrending()}
        installedAppUrns={installedAppUrns}
      />
      <AppSection
        title={t('APP_STORE_RECENT_SECTION_TITLE')}
        subtitle={t('APP_STORE_RECENT_SECTION_SUBTITLE')}
        apps={newest}
        isLoading={loadingNewest}
        isError={newestError}
        onRetry={() => void refetchNewest()}
        installedAppUrns={installedAppUrns}
      />
    </div>
  );
}
