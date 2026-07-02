import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { GlassContainer } from '@/components/ui/glass-container';
import { limitText } from '@/lib/helpers/text-helpers';
import { getMarketplaceAppImageUrl } from '@/lib/marketplace-image-url';
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
  const [appId, storeId] = app.urn.split(':');
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
      <GlassContainer className="h-full p-4 flex flex-col min-h-[220px]" intensity="low">
        <div className="flex items-start justify-between mb-4">
          <Skeleton className="w-16 h-16 rounded-md" />
          <Skeleton className="w-12 h-6 rounded-full" />
        </div>
        <Skeleton className="h-6 w-3/4 mb-2" />
        <Skeleton className="h-4 w-full mb-1" />
        <Skeleton className="h-4 w-2/3" />
      </GlassContainer>
    );
  }

  return (
    <Link to={`/store/${storeId}/${appId}`} className="block h-full group">
      <GlassContainer
        className="h-full min-h-[180px] flex flex-col p-4 shadow-sm shadow-slate-300/70 transition-all active:scale-[0.98] hover:bg-white/10 hover:shadow-xl hover:shadow-slate-300/80 sm:min-h-[220px] dark:shadow-none dark:hover:shadow-lg dark:hover:shadow-black/20"
        intensity="low"
      >
        <div className="flex items-start justify-between mb-3 sm:mb-4">
          {showAvatarFallback ? (
            <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-md bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-white text-xl sm:text-2xl font-bold shadow-lg">
              {app.name.charAt(0)}
            </div>
          ) : (
            <img
              src={imgSrc}
              alt={app.name}
              className="w-12 h-12 sm:w-16 sm:h-16 rounded-md shadow-lg object-cover"
              width={64}
              height={64}
              loading="lazy"
              onError={handleImageError}
            />
          )}

          <span className="px-2 py-1 rounded-full bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 text-xs font-semibold">
            {t('APP_PRICE_FREE')}
          </span>
        </div>

        <h3 className="font-bold text-base sm:text-lg mb-1 truncate text-foreground group-hover:text-primary transition-colors">{app.name}</h3>
        <p className="text-sm text-muted-foreground line-clamp-2 mb-4 flex-grow">{limitText(app.short_desc, 80)}</p>

        <div className="flex items-center justify-end mt-auto">
          {isInstalled ? (
            <div className="h-8 w-8 rounded-full flex items-center justify-center bg-emerald-500/20">
              <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-500" />
            </div>
          ) : (
            <Button variant="ghost" size="sm" className="h-8 w-8 rounded-full p-0">
              <Download className="w-4 h-4" />
            </Button>
          )}
        </div>
      </GlassContainer>
    </Link>
  );
};
