import type { GetAppDto } from '@/api-client';
import { getAppQueryKey, installAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { invalidateAppQueries } from '@/modules/app/helpers/app-sse-cache';
import { installRequestKey, withInstallRequest } from '@/modules/app/helpers/install-request';
import { addOptimisticInstalledApp, removeOptimisticInstalledApp } from '@/modules/app/helpers/optimistic-installed-apps';
import { useAppStatus } from '@/modules/app/helpers/use-app-status';
import type { AppInfo } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { AlertCircle } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { useCallback, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [appSlug] = info.urn.split(':');
  const appQueryKey = getAppQueryKey({ path: { urn: info.urn } });
  // Also when the app has not been read yet, or the cancel below took back a read that had no data
  // before it: `setOptimisticStatus` leaves an empty cache alone.
  const markInstalling = () => queryClient.setQueryData(appQueryKey, (current: GetAppDto | undefined) => withInstallRequest(current, info.urn, true));

  const installMutation = useMutation({
    ...installAppMutation(),
    mutationKey: installRequestKey(info.urn),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
      if (e.message === 'APP_ERROR_INSTALL_IN_PROGRESS') {
        // Refused because an install of this app is already under way. The read below shows it.
        markInstalling();
      } else {
        // The install never happened, so retract the row we invented. Left behind it would sit on the
        // dashboard as a permanent "installing" spinner, and the store page would keep counting the
        // app as installed.
        removeOptimisticInstalledApp(queryClient, info.urn);
      }
      invalidateAppQueries(queryClient, info.urn);
    },
    onMutate: async () => {
      onClose();
      // A read of the app still on its way would land after the write below and put the page back
      // on Install. Cancelled first, as its revert would otherwise land on top of the write.
      await queryClient.cancelQueries({ queryKey: appQueryKey });
      setOptimisticStatus('installing', info.urn);
      markInstalling();
      if (appSlug) {
        addOptimisticInstalledApp(queryClient, {
          urn: info.urn,
          name: info.name,
          slug: appSlug,
        });
      }
    },
    onSuccess: () => {
      // The Hub answers once it has written the app's row. A read in the seconds before that found
      // no row; keep showing the install until the reads below bring the row.
      markInstalling();
      invalidateAppQueries(queryClient, info.urn);
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
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t('APP_INSTALL_FORM_TITLE', { name: info.name })}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
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
            onSubmittingChange={setIsSubmitting}
          />
        </div>
        <DialogFooter className="shrink-0 flex-col items-stretch gap-2 sm:flex-col">
          {!isFormValid && <p className="text-sm text-muted-foreground text-left">{t('APP_INSTALL_FORM_COMPLETE_REQUIRED')}</p>}
          {/* From the click: on Public Web the form runs a last DNS check before the request goes out. */}
          <InstallFormButtons loading={isSubmitting || installMutation.isPending} formId={formId} disabled={!isFormValid} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
