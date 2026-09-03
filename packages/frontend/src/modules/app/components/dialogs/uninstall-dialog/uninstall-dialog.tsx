import { uninstallAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Switch } from '@/components/ui/Switch';
import { invalidateAppQueries } from '@/modules/app/helpers/app-sse-cache';
import { useAppStatus } from '@/modules/app/helpers/use-app-status';
import { useMemoryProviderForceGate } from '@/modules/app/helpers/use-memory-connection';
import { MemoryProviderForceWarning } from '../memory-provider-force-warning';
import type { AppInfo } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { AlertTriangle } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
  const { requiresForce, consumers, unableToVerify, forceConfirmed, setForceConfirmed, submitDisabled } = useMemoryProviderForceGate(
    info.urn,
    isOpen,
  );

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
            <MemoryProviderForceWarning
              consumers={consumers}
              unableToVerify={unableToVerify}
              forceConfirmed={forceConfirmed}
              onForceConfirmedChange={setForceConfirmed}
              switchName="uninstall-force-confirm"
            />
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
