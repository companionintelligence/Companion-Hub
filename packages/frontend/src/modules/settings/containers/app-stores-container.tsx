import { getAllAppStoresOptions, pullAppStoresMutation } from '@/api-client/@tanstack/react-query.gen';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { AlertCircle, LayoutGrid, RefreshCw } from 'lucide-react';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AppStoresTable } from '../components/app-stores-table/app-stores-table';
import { Button } from '@/components/ui/Button';
import { CardContent } from '@/components/ui/Card';
import toast from 'react-hot-toast';

export const AppStoresContainer = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data } = useSuspenseQuery({
    ...getAllAppStoresOptions(),
  });

  const pullMutation = useMutation({
    ...pullAppStoresMutation(),
    onSuccess: () => {
      toast.success(t('APP_STORES_UPDATE_SUCCESS'));
      queryClient.invalidateQueries({ queryKey: getAllAppStoresOptions().queryKey });
    },
    onError: () => {
      toast.error(t('APP_STORES_UPDATE_ERROR'));
    },
  });

  return (
    <CardContent>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center">
          <LayoutGrid className="mr-2" />
          <h2 className="text-xl font-semibold">{t('SETTINGS_APPSTORES_TITLE')}</h2>
        </div>
        <Button onClick={() => pullMutation.mutate({})} loading={pullMutation.isPending} variant="outline">
          <RefreshCw className="mr-2" size={16} />
          {t('REFRESH')}
        </Button>
      </div>
      <p className="text-muted-foreground">{t('SETTINGS_APPSTORES_SUBTITLE')}</p>
      <Alert variant="warning">
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
  );
};
