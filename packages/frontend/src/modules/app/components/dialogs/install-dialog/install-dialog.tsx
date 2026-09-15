import { installAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { invalidateAppQueries } from '@/modules/app/helpers/app-sse-cache';
import { addOptimisticInstalledApp, removeOptimisticInstalledApp } from '@/modules/app/helpers/optimistic-installed-apps';
import { useAppStatus } from '@/modules/app/helpers/use-app-status';
import type { AppInfo } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { AlertCircle } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { useCallback, useId, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Trans, useTranslation } from 'react-i18next';
import { InstallFormButtons } from '../../install-form-buttons/install-form-buttons';
import { type FormValues, InstallForm } from '../../install-form/install-form';
import { McpSetupPanel } from '../../mcp-setup-panel/mcp-setup-panel';

interface IProps {
  info: AppInfo;
  isOpen: boolean;
  onClose: () => void;
  /**
   * The custom hostname this app is currently served on, for a REINSTALL of an
   * app that already holds one — `app.custom_domain`, not the intent.
   *
   * Carried so that picking "use the platform address" here releases the domain
   * the operator was shown rather than whatever the row holds when the save
   * lands (R2-HUBDOMAINS-3). A fresh install has none, and the Hub only consults
   * it when there is a binding to release.
   */
  boundCustomDomain?: string | null;
}

export const InstallDialog: React.FC<IProps> = ({ info, isOpen, onClose, boundCustomDomain }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { setOptimisticStatus } = useAppStatus();
  const formId = useId();
  const [isFormValid, setIsFormValid] = useState(false);
  const [appSlug] = info.urn.split(':');

  const installMutation = useMutation({
    ...installAppMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
      // The install never happened, so retract the row we invented. Left behind it would sit on the
      // dashboard as a permanent "installing" spinner, and the store page would keep counting the
      // app as installed.
      removeOptimisticInstalledApp(queryClient, info.urn);
      invalidateAppQueries(queryClient, info.urn);
    },
    onMutate: () => {
      setOptimisticStatus('installing', info.urn);
      if (appSlug) {
        addOptimisticInstalledApp(queryClient, {
          urn: info.urn,
          name: info.name,
          slug: appSlug,
        });
      }
      onClose();
    },
  });

  /*
   * Memoized because `InstallForm` re-seeds whenever this object's identity
   * changes; a fresh object every render would re-assert the value while the
   * operator types.
   */
  const initialValues = useMemo(() => ({ customDomainExpected: boundCustomDomain ?? '' }), [boundCustomDomain]);

  const normalizeFormValues = (values: FormValues) => {
    return {
      ...values,
      port: values.port ? Number(values.port) : undefined,
      localSubdomain: values.localSubdomain || undefined,
      maxBackups: values.maxBackups !== undefined && Number.isNaN(values.maxBackups) ? undefined : values.maxBackups,
    };
  };

  const handleValidityChange = useCallback((valid: boolean) => {
    setIsFormValid(valid);
  }, []);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('APP_INSTALL_FORM_TITLE', { name: info.name })}</DialogTitle>
        </DialogHeader>
        {info.force_pull && (
          <Alert variant="warning">
            <AlertIcon>
              <AlertCircle strokeWidth={2} />
            </AlertIcon>
            <div>
              <AlertHeading>{t('COMMON_WARNING')}</AlertHeading>
              <AlertDescription>
                <Trans i18nKey={'APP_INSTALL_FORM_FORCE_PULL_WARNING'} values={{ tag: info.version }} components={{ code: <code /> }} />
              </AlertDescription>
            </div>
          </Alert>
        )}
        {info.mcp ? <McpSetupPanel info={info} /> : null}
        <InstallForm
          onSubmit={(data) => installMutation.mutate({ path: { urn: info.urn }, body: normalizeFormValues(data) })}
          formFields={info.form_fields}
          info={info}
          initialValues={initialValues}
          formId={formId}
          editingAppUrn={info.urn}
          onValidityChange={handleValidityChange}
        />
        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col">
          {!isFormValid && (
            <p className="text-sm text-muted-foreground text-left">
              {t('APP_INSTALL_FORM_COMPLETE_REQUIRED', {
                defaultValue: 'Fill every required field before installing. Fields with defaults can stay as-is.',
              })}
            </p>
          )}
          <InstallFormButtons loading={installMutation.isPending} formId={formId} disabled={!isFormValid} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
