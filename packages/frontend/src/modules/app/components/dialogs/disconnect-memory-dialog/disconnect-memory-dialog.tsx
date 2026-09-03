import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import type { AppInfo } from '@/types/app.types';
import type React from 'react';
import { useTranslation } from 'react-i18next';

interface IProps {
  info: AppInfo;
  isOpen: boolean;
  onClose: () => void;
  /** Fire the disconnect: revoke the app's memory key on CI-Server, clear the
   * stored connection, and restart the app so it drops the credentials. */
  onConfirm: () => void;
  isDisconnecting?: boolean;
}

/**
 * Confirmation gate for disconnecting an app from Companion Memory. Disconnecting
 * revokes the app's memory key on CI-Server and restarts the app, so it must not
 * fire on a single click. It's reversible — the user can reconnect at any time.
 */
export const DisconnectMemoryDialog: React.FC<IProps> = ({ info, isOpen, onClose, onConfirm, isDisconnecting }) => {
  const { t } = useTranslation();

  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('MEMORY_CONNECT_DISCONNECT_TITLE', { name: info.name })}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          <span className="text-muted-foreground">{t('MEMORY_CONNECT_DISCONNECT_CONFIRM')}</span>
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('COMMON_CANCEL')}
          </Button>
          <Button onClick={handleConfirm} intent="danger" disabled={isDisconnecting}>
            {t('MEMORY_CONNECT_ACTION_DISCONNECT_MEMORY')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
