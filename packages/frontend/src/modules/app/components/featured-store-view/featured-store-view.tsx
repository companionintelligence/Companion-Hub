import { AppCard } from '@/modules/app/components/app-card/app-card';
import type { HubStoreApp } from '@/lib/portal-store';
import { getFeaturedStoreSectionOptions, type FeaturedStoreSectionId } from '@/lib/featured-store-bundle-query';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

const PREVIEW_COUNT = 4;
/** How many more cards "View all" reveals at a time. The rest stay unmounted. */
const WINDOW_COUNT = 12;

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
  const [visibleCount, setVisibleCount] = useState(PREVIEW_COUNT);
  const total = apps?.length ?? 0;
  const shown = Math.min(visibleCount, total);
  const visible = apps?.slice(0, shown);
  const hasMore = total > shown;
  const isExpanded = shown > PREVIEW_COUNT;
  const revealMore = () => setVisibleCount((count) => count + WINDOW_COUNT);

  return (
    <section className="w-full space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
          <p className="text-muted-foreground">{subtitle}</p>
        </div>
        {(hasMore || isExpanded) && !isLoading && !isError && (
          <div className="flex shrink-0 items-center gap-3">
            {hasMore && (
              <button
                type="button"
                onClick={revealMore}
                aria-expanded={isExpanded}
                aria-controls={gridId}
                className="flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                {shown === PREVIEW_COUNT ? (
                  <>
                    {t('APP_STORE_FEATURED_VIEW_ALL', { count: total })} <ChevronDown className="h-3.5 w-3.5" />
                  </>
                ) : (
                  <>
                    {t('APP_STORE_FEATURED_SHOW_MORE')} <ChevronDown className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            )}
            {isExpanded && (
              <button
                type="button"
                onClick={() => setVisibleCount(PREVIEW_COUNT)}
                className="flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                {t('APP_STORE_FEATURED_SHOW_LESS')} <ChevronUp className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
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

function FeaturedStoreSection({
  sectionId,
  storeId,
  title,
  subtitle,
  installedAppUrns,
}: {
  sectionId: FeaturedStoreSectionId;
  storeId: string;
  title: string;
  subtitle: string;
  installedAppUrns: Set<string>;
}) {
  const { data, isLoading, isError, refetch } = useQuery({
    ...getFeaturedStoreSectionOptions(sectionId, storeId),
  });

  return (
    <AppSection
      title={title}
      subtitle={subtitle}
      apps={data}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => {
        void refetch();
      }}
      installedAppUrns={installedAppUrns}
    />
  );
}

export function FeaturedStoreView({ storeId, installedAppUrns }: { storeId: string; installedAppUrns: Set<string> }) {
  const { t } = useTranslation();

  return (
    <div className="w-full space-y-10 pb-10">
      <FeaturedStoreSection
        sectionId="firstParty"
        storeId={storeId}
        title={t('APP_STORE_FIRST_PARTY_SECTION_TITLE')}
        subtitle={t('APP_STORE_FIRST_PARTY_SECTION_SUBTITLE')}
        installedAppUrns={installedAppUrns}
      />
      <FeaturedStoreSection
        sectionId="featured"
        storeId={storeId}
        title={t('APP_STORE_FEATURED_SECTION_TITLE')}
        subtitle={t('APP_STORE_FEATURED_SECTION_SUBTITLE')}
        installedAppUrns={installedAppUrns}
      />
      <FeaturedStoreSection
        sectionId="trending"
        storeId={storeId}
        title={t('APP_STORE_TRENDING_SECTION_TITLE')}
        subtitle={t('APP_STORE_TRENDING_SECTION_SUBTITLE')}
        installedAppUrns={installedAppUrns}
      />
      <FeaturedStoreSection
        sectionId="newest"
        storeId={storeId}
        title={t('APP_STORE_RECENT_SECTION_TITLE')}
        subtitle={t('APP_STORE_RECENT_SECTION_SUBTITLE')}
        installedAppUrns={installedAppUrns}
      />
    </div>
  );
}
