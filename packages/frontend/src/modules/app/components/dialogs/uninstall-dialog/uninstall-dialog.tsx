import { uninstallAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Switch } from '@/components/ui/Switch';
import { invalidateAppQueries } from '@/modules/app/helpers/app-sse-cache';
import { isMemoryProviderUrn } from '@/modules/app/helpers/memory-provider';
import { useAppStatus } from '@/modules/app/helpers/use-app-status';
import { useMemoryConsumers } from '@/modules/app/helpers/use-memory-connection';
import type { AppInfo } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { AlertTriangle } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

interface IProps {
  info: AppInfo;
  isOpen: boolean;
  onClose: () => void;
}

export const UninstallDialog = ({ info, isOpen, onClose }: IProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { setOptimisticStatus } = useAppStatus();

  const [shouldDeleteAllData, setShouldDeleteAllData] = useState(true);
  const [forceConfirmed, setForceConfirmed] = useState(false);

  const isProvider = isMemoryProviderUrn(info.urn);
  const consumersQuery = useMemoryConsumers(isOpen && isProvider);
  const consumers = consumersQuery.data ?? [];
  const requiresForce = isProvider && consumers.length > 0;

  // Reset the force acknowledgement whenever the dialog (re)opens.
  useEffect(() => {
    if (isOpen) {
      setForceConfirmed(false);
    }
  }, [isOpen]);

  const uninstallMutation = useMutation({
    ...uninstallAppMutation(),
    onError: (error: TranslatableError) => {
      toast.error(t(error.message, error.intlParams));
      // A pre-flight rejection (e.g. the memory-provider guard's 409) fails
      // synchronously and emits no lifecycle SSE event, and nothing polls the app
      // detail — so without this the optimistic 'uninstalling' status would spin
      // forever. Re-sync from the server to clear it.
      invalidateAppQueries(queryClient, info.urn);
    },
    onMutate: () => {
      setOptimisticStatus('uninstalling', info.urn);
      onClose();
    },
  });

  const submitDisabled = (isProvider && consumersQuery.isLoading) || (requiresForce && !forceConfirmed);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent type="danger" size="sm">
        <DialogHeader>
          <DialogTitle>{t('APP_UNINSTALL_FORM_TITLE', { name: info.name })}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-center py-4">
          <AlertTriangle className="mb-2 text-destructive size-12 mx-auto" />
          <h3>{t('COMMON_ACTION_CANNOT_BE_UNDONE')}</h3>
          <span className="text-muted-foreground">{t('COMMON_ALL_DATA_LOST')}</span>
          {requiresForce && (
            <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-start">
              <p className="font-medium text-destructive">{t('APP_UNINSTALL_MEMORY_PROVIDER_WARNING', { count: consumers.length })}</p>
              <ul className="mt-1 list-disc ps-5 text-muted-foreground">
                {consumers.map((c) => (
                  <li key={c.appUrn}>{c.name}</li>
                ))}
              </ul>
              <p className="mt-2 text-muted-foreground">{t('APP_UNINSTALL_MEMORY_PROVIDER_CONSEQUENCE')}</p>
              <div className="mt-3">
                <Switch
                  name="uninstall-force-confirm"
                  checked={forceConfirmed}
                  onCheckedChange={setForceConfirmed}
                  label={t('APP_UNINSTALL_MEMORY_PROVIDER_FORCE_LABEL')}
                />
              </div>
            </div>
          )}
          <div className="flex justify-center pt-3">
            <Switch
              name="uninstall-delete-all-data"
              className="text-start"
              checked={shouldDeleteAllData}
              onCheckedChange={setShouldDeleteAllData}
              label={t('APP_UNINSTALL_FORM_DELETE_ALL_DATA')}
            />
          </div>
        </DialogDescription>
        <DialogFooter>
          <Button
            onClick={() =>
              uninstallMutation.mutate({
                path: { urn: info.urn },
                body: { deleteAllData: shouldDeleteAllData, force: requiresForce && forceConfirmed },
              })
            }
            disabled={submitDisabled}
            intent="danger"
          >
            {t('APP_UNINSTALL_FORM_SUBMIT')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
