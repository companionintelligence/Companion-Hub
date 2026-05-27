import { backupAppMutation, updateAppConfigMutation } from '@/api-client/@tanstack/react-query.gen';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Switch } from '@/components/ui/Switch';
import type { AppInfo, AppStatus } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import type React from 'react';
import { useId, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { InstallFormButtons } from '../../install-form-buttons/install-form-buttons';
import { type FormValues, InstallForm } from '../../install-form/install-form';

interface IProps {
  info: AppInfo;
  config: Record<string, unknown>;
  isOpen: boolean;
  onClose: () => void;
  status?: AppStatus;
}

const RUNNING_STATUSES: AppStatus[] = ['running', 'starting', 'restarting'];

export const UpdateSettingsDialog: React.FC<IProps> = ({ info, config, isOpen, onClose, status }) => {
  const { t } = useTranslation();
  const formId = useId();
  const [backupBeforeRestart, setBackupBeforeRestart] = useState(true);

  const isRunning = status != null && RUNNING_STATUSES.includes(status);

  const updateConfig = useMutation({
    ...updateAppConfigMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onMutate: () => {
      onClose();
    },
    onSuccess: () => {
      toast.success(isRunning ? t('APP_UPDATE_CONFIG_SUCCESS') : t('APP_UPDATE_CONFIG_SUCCESS_STOPPED'));
    },
  });

  const backup = useMutation({
    ...backupAppMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
  });

  const normalizeFormValues = (values: FormValues) => {
    return {
      ...values,
      port: values.port ? Number(values.port) : undefined,
      localSubdomain: values.localSubdomain || undefined,
      maxBackups: values.maxBackups !== undefined && Number.isNaN(values.maxBackups) ? undefined : values.maxBackups,
    };
  };

  const handleSubmit = async (values: FormValues) => {
    if (isRunning && backupBeforeRestart) {
      await backup.mutateAsync({ path: { urn: info.urn } });
    }
    updateConfig.mutate({ path: { urn: info.urn }, body: normalizeFormValues(values) });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('APP_UPDATE_SETTINGS_FORM_TITLE', { name: info.id })}</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            {isRunning ? t('APP_UPDATE_SETTINGS_RESTART_HINT') : t('APP_UPDATE_SETTINGS_STOPPED_HINT')}
          </p>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto">
          <InstallForm
            onSubmit={handleSubmit}
            formFields={info.form_fields}
            info={info}
            initialValues={{ ...config }}
            formId={formId}
            appStatus={status}
            scrollable
          />
        </div>
        {isRunning && (
          <div className="px-1 pb-2">
            <Switch
              checked={backupBeforeRestart}
              onCheckedChange={setBackupBeforeRestart}
              label={t('APP_UPDATE_SETTINGS_BACKUP_BEFORE_RESTART')}
            />
          </div>
        )}
        <DialogFooter>
          <InstallFormButtons loading={updateConfig.isPending || backup.isPending} isEdit formId={formId} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
