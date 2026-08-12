import { getAllAppStoresOptions, pullAppStoresMutation } from '@/api-client/@tanstack/react-query.gen';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { AlertCircle, LayoutGrid, RefreshCw } from 'lucide-react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AppStoresTable } from '../components/app-stores-table/app-stores-table';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import toast from 'react-hot-toast';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { invalidateStoreCatalogQueries } from '@/lib/invalidate-store-catalog-queries';

export const AppStoresContainer = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    ...getAllAppStoresOptions(),
    staleTime: 30_000,
  });

  const pullMutation = useMutation({
    ...pullAppStoresMutation(),
    onSuccess: () => {
      toast.success(t('APP_STORES_UPDATE_SUCCESS'));
      invalidateStoreCatalogQueries(queryClient);
    },
    onError: () => {
      toast.error(t('APP_STORES_UPDATE_ERROR'));
    },
  });

  if (isLoading || !data) {
    return <LoadingSpinner />;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <LayoutGrid className="h-5 w-5 shrink-0 text-muted-foreground" />
              <CardTitle className="text-xl">{t('COMMON_APP_STORES')}</CardTitle>
            </div>
            <Button onClick={() => pullMutation.mutate({})} loading={pullMutation.isPending} variant="outline" size="sm">
              <RefreshCw className="mr-2" size={16} />
              {t('COMMON_REFRESH')}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{t('SETTINGS_APPSTORES_SUBTITLE')}</p>
        </CardHeader>
        <CardContent>
          <Alert variant="warning" className="mb-4">
            <AlertIcon>
              <AlertCircle strokeWidth={2} />
            </AlertIcon>
            <div>
              <AlertHeading>{t('COMMON_WARNING')}</AlertHeading>
              <AlertDescription>{t('SETTINGS_APPSTORES_WARNING')}</AlertDescription>
            </div>
          </Alert>
          <AppStoresTable appStores={data.appStores} />
        </CardContent>
      </Card>
    </div>
  );
};
