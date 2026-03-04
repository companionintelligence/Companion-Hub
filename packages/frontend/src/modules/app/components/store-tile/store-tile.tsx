import { limitText } from '@/lib/helpers/text-helpers';
import type React from 'react';
import './store-tile.css';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import type { AppInfoSimple } from '@/types/app.types';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { colorSchemeForCategory } from '../../helpers/table-helpers';

export const StoreTile: React.FC<{ app: AppInfoSimple; isLoading: boolean }> = ({ app, isLoading }) => {
  const { t } = useTranslation();

  const isNew = (app.created_at ?? 0) + 14 * 24 * 60 * 60 * 1000 > Date.now();

  const [appId, storeId] = app.urn.split(':');

  return (
    <Link aria-label={app.name} className="app-tile" to={`/app-store/${storeId}/${appId}`} data-testid={`app-card-${appId}`}>
      <Card key={app.id} className="flex overflow-hidden items-center py-2 pl-2 transition-all hover:shadow-md hover:scale-[1.02] active:scale-[0.98]">
        <Skeleton loading={isLoading}>
          <AppLogo className="logo" urn={app.urn} placeholder={isLoading} />
        </Skeleton>
        <CardContent className="p-2">
          <div className="flex items-center" style={{ columnGap: '0.75rem' }}>
            <h3 className="text-bold h-3 mb-2">
              <Skeleton loading={isLoading}>{limitText(app.name, 20)}</Skeleton>
            </h3>
            {isNew ? <div className="text-white badge me-1 bg-green">{t('APP_NEW')}</div> : null}
          </div>
          <p className="text-muted-foreground mb-2 store-tile-description">
            <Skeleton loading={isLoading}>{app.short_desc}</Skeleton>
          </p>
          {app.categories?.map((category) => (
            <Skeleton loading={isLoading} key={`${app.id}-${category}`}>
              <div className={`text-white badge me-1 bg-${colorSchemeForCategory[category]}`}>
                {t(`APP_CATEGORY_${category.toUpperCase() as Uppercase<typeof category>}`)}
              </div>
            </Skeleton>
          ))}
        </CardContent>
      </Card>
    </Link>
  );
};
