import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { getMarketplaceAppImageUrl } from '@/lib/marketplace-image-url';
import { storeBrowseQueryString } from '@/lib/store-browse-params';
import { useAppStoreState } from '@/stores/app-store';
import type { AppInfoSimple } from '@/types/app.types';
import { Check, Download } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

type AppCardApp = Pick<AppInfoSimple, 'urn' | 'name' | 'short_desc'> & { icon?: string | null };

interface AppCardProps {
  app: AppCardApp;
  isLoading?: boolean;
  isInstalled?: boolean;
  imageUrlOverride?: string | null;
}

function resolveAppCardImageUrl(app: AppCardApp, imageUrlOverride?: string | null): string {
  return imageUrlOverride ?? app.icon ?? getMarketplaceAppImageUrl(app.urn);
}

export const AppCard: React.FC<AppCardProps> = ({ app, isLoading, isInstalled, imageUrlOverride }) => {
  const { t } = useTranslation();
  const { search, category, storeId: browseStoreId } = useAppStoreState();
  const [appId, storeId] = app.urn.split(':');
  const browseQuery = storeBrowseQueryString({
    q: search.trim() ? search : undefined,
    category,
    store: browseStoreId ?? storeId,
  });
  const detailPath = browseQuery ? `/store/${storeId}/${appId}?${browseQuery}` : `/store/${storeId}/${appId}`;
  const logoUrl = resolveAppCardImageUrl(app, imageUrlOverride);
  const [imgSrc, setImgSrc] = useState(logoUrl);
  const [showAvatarFallback, setShowAvatarFallback] = useState(false);

  useEffect(() => {
    setImgSrc(imageUrlOverride ?? app.icon ?? getMarketplaceAppImageUrl(app.urn));
    setShowAvatarFallback(false);
  }, [app.urn, app.icon, imageUrlOverride]);

  const handleImageError = () => {
    if (imgSrc !== '/app-not-found.jpg') {
      setImgSrc('/app-not-found.jpg');
      return;
    }

    setShowAvatarFallback(true);
  };

  if (isLoading) {
    return (
      <div className="flex h-full min-h-[220px] flex-col rounded-lg border border-border bg-card p-4 shadow-sm">
        <div className="flex items-start justify-between mb-4">
          <Skeleton className="w-16 h-16 rounded-md" />
          <Skeleton className="w-12 h-6 rounded-full" />
        </div>
        <Skeleton className="h-6 w-3/4 mb-2" />
        <Skeleton className="h-4 w-full mb-1" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  return (
    <Link to={detailPath} className="block h-full group">
      <div className="flex h-full min-h-[180px] flex-col rounded-lg border border-border bg-card p-4 shadow-sm transition-colors hover:border-foreground/20 sm:min-h-[220px]">
        <div className="flex items-start justify-between mb-3 sm:mb-4">
          {showAvatarFallback ? (
            <div className="flex h-12 w-12 items-center justify-center rounded-md border border-border bg-muted text-xl font-medium text-foreground sm:h-16 sm:w-16 sm:text-2xl">
              {app.name.charAt(0)}
            </div>
          ) : (
            <img
              src={imgSrc}
              alt=""
              className="h-12 w-12 rounded-md border border-border object-cover sm:h-16 sm:w-16"
              width={64}
              height={64}
              loading="lazy"
              decoding="async"
              onError={handleImageError}
            />
          )}

          <span className="text-xs font-medium text-success">{t('APP_PRICE_FREE')}</span>
        </div>

        {/*
          `truncate` clipped real first-party names to "Companion Me…" / "Companion Plan…"
          in the four-up store grid. Clamp to two lines instead, matching the description.
        */}
        <h3
          title={app.name}
          className="mb-1 line-clamp-2 text-base font-medium text-foreground transition-colors group-hover:text-primary sm:text-lg"
        >
          {app.name}
        </h3>
        {/*
          Clamp the description itself. A nested span from a character cutoff
          skips the ellipsis, and flex-grow then slices the next line in half.
        */}
        <p title={app.short_desc} className="mb-4 line-clamp-2 min-w-0 text-sm leading-5 text-muted-foreground">
          {app.short_desc}
        </p>

        <div className="flex items-center justify-end mt-auto">
          {isInstalled ? (
            <span className="flex h-8 w-8 items-center justify-center" title={t('APP_CARD_INSTALLED')}>
              <Check className="h-4 w-4 text-success" aria-hidden />
              <span className="sr-only">{t('APP_CARD_INSTALLED')}</span>
            </span>
          ) : (
            <span className="flex h-8 w-8 items-center justify-center text-muted-foreground" aria-hidden>
              <Download className="h-4 w-4" />
            </span>
          )}
        </div>
      </div>
    </Link>
  );
};
