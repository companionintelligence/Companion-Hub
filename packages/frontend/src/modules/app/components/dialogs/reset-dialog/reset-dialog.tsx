import { resetAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { invalidateAppQueries } from '@/modules/app/helpers/app-sse-cache';
import { useAppStatus } from '@/modules/app/helpers/use-app-status';
import { useMemoryProviderForceGate } from '@/modules/app/helpers/use-memory-connection';
import { MemoryProviderForceWarning } from '../memory-provider-force-warning';
import type { AppInfo } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { AlertTriangle } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

interface IProps {
  info: AppInfo;
  isOpen: boolean;
  onClose: () => void;
}
export const ResetDialog: React.FC<IProps> = ({ info, isOpen, onClose }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { setOptimisticStatus } = useAppStatus();

  const { requiresForce, consumers, unableToVerify, forceConfirmed, setForceConfirmed, submitDisabled } = useMemoryProviderForceGate(
    info.urn,
    isOpen,
  );

  const resetMutation = useMutation({
    ...resetAppMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
      // A pre-flight rejection (e.g. the memory-provider guard's 409) fails
      // synchronously and emits no lifecycle SSE event, so clear the optimistic
      // 'resetting' status by re-syncing from the server.
      invalidateAppQueries(queryClient, info.urn);
    },
    onMutate: () => {
      setOptimisticStatus('resetting', info.urn);
      onClose();
    },
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent type="danger" size="sm">
        <DialogHeader>
          <DialogTitle>{t('APP_RESET_FORM_TITLE', { name: info.name })}</DialogTitle>
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
              switchName="reset-force-confirm"
            />
          )}
        </DialogDescription>
        <DialogFooter>
          <Button
            loading={resetMutation.isPending}
            disabled={submitDisabled}
            onClick={() => resetMutation.mutate({ path: { urn: info.urn }, body: { force: requiresForce && forceConfirmed } })}
            intent="danger"
          >
            {t('APP_RESET_FORM_SUBMIT')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
