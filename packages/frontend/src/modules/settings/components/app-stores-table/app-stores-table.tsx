import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import type { AppStore } from '@/types/app.types';
import { AddAppStoreDialog } from '../add-app-store-dialog/add-app-store-dialog';
import { DeleteAppStoreDialog } from '../delete-app-store-dialog/delete-app-store-dialog';
import { EditAppStoreDialog } from '../edit-app-store-dialog/edit-app-store-dialog';

type Props = {
  appStores: AppStore[];
};

const EnabledBadge = ({ enabled }: { enabled: boolean }) => (
  <div className="flex items-center">
    <span className={`inline-block size-2 rounded-full mr-2 ${enabled ? 'bg-green-500' : 'bg-red-500'}`} />
    <span>{enabled ? 'Enabled' : 'Disabled'}</span>
  </div>
);

export const AppStoresTable = ({ appStores }: Props) => {
  return (
    <div className="flex flex-col">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>URL</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {appStores.map((appStore) => (
            <TableRow key={appStore.slug}>
              <TableCell>{appStore.name}</TableCell>
              <TableCell>
                <EnabledBadge enabled={appStore.enabled} />
              </TableCell>
              <TableCell>
                <a href={appStore.url} target="_blank" rel="noreferrer noopener nofollow">
                  {appStore.url}
                </a>
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
