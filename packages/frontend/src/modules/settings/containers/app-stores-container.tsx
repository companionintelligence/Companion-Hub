import { getAllAppStoresOptions, pullAppStoresMutation } from '@/api-client/@tanstack/react-query.gen';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { IconAlertCircle, IconBrandAppstore, IconRefresh } from '@tabler/icons-react';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AppStoresTable } from '../components/app-stores-table/app-stores-table';
import { Button } from '@/components/ui/Button';
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
    <div className="card-body">
      <div className="d-flex align-items-center justify-content-between mb-2">
        <div className="d-flex align-items-center">
          <IconBrandAppstore className="me-2" />
          <h2 className="mb-0">{t('SETTINGS_APPSTORES_TITLE')}</h2>
        </div>
        <Button onClick={() => pullMutation.mutate({})} loading={pullMutation.isPending} variant="outline">
          <IconRefresh className="me-2" size={16} />
          {t('REFRESH')}
        </Button>
      </div>
      <p className="text-muted">{t('SETTINGS_APPSTORES_SUBTITLE')}</p>
      <Alert variant="warning">
        <AlertIcon>
          <IconAlertCircle stroke={2} />
        </AlertIcon>
        <div>
          <AlertHeading>{t('COMMON_WARNING')}</AlertHeading>
          <AlertDescription>{t('SETTINGS_APPSTORES_WARNING')}</AlertDescription>
        </div>
      </Alert>
      <AppStoresTable appStores={data.appStores} />
    </div>
  );
};
