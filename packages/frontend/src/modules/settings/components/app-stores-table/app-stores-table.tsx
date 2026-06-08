import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import type { AppStore } from '@/types/app.types';
import { AddAppStoreDialog } from '../add-app-store-dialog/add-app-store-dialog';
import { DeleteAppStoreDialog } from '../delete-app-store-dialog/delete-app-store-dialog';
import { EditAppStoreDialog } from '../edit-app-store-dialog/edit-app-store-dialog';
import { useTranslation } from 'react-i18next';

type Props = {
  appStores: AppStore[];
};

const EnabledBadge = ({ enabled }: { enabled: boolean }) => {
  const { t } = useTranslation();

  return (
    <div className="flex items-center">
      <span className={`inline-block size-2 rounded-full mr-2 ${enabled ? 'bg-green-500' : 'bg-red-500'}`} />
      <span>{enabled ? t('SETTINGS_NETWORK_ACTIVE') : t('SETTINGS_NETWORK_INACTIVE')}</span>
    </div>
  );
};

export const AppStoresTable = ({ appStores }: Props) => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('APP_STORE_TABLE_NAME')}</TableHead>
            <TableHead>{t('APP_STORE_TABLE_STATUS')}</TableHead>
            <TableHead>{t('APP_STORE_TABLE_URL')}</TableHead>
            <TableHead>{t('APP_STORE_TABLE_ACTIONS')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {appStores.map((appStore) => (
            <TableRow key={appStore.slug}>
              <TableCell>
                {appStore.name === 'CI Marketplace' ? (
                  <a
                    href={appStore.url.replace(/\/api\/?$/, '')}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-primary underline hover:no-underline"
                  >
                    CI Portal
                  </a>
                ) : (
                  appStore.name
                )}
              </TableCell>
              <TableCell>
                <EnabledBadge enabled={appStore.enabled} />
              </TableCell>
              <TableCell>
                <span className="block max-w-[28rem] truncate" title={appStore.url}>
                  {appStore.url}
                </span>
              </TableCell>
              <TableCell>
                <div className="flex flex-row">
                  <EditAppStoreDialog appStore={appStore} />
                  <DeleteAppStoreDialog appStore={appStore} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <AddAppStoreDialog />
    </div>
  );
};
