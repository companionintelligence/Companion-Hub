import { useCallback } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Link } from 'react-router';
import { Tooltip } from 'react-tooltip';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { client } from '@/api-client/client.gen';
import { getAppQueryKey, getDomainsOptions } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input/Input';
import { useAppContext } from '@/context/app-context';
import { fetchDnsAvailability } from '@/lib/cloudflare-api';
import { CloudflareSubdomainField } from '@/modules/app/components/install-form/cloudflare-subdomain-field';
import { domainListNoteFor } from '@/modules/app/components/install-form/domain-list-note';
import { useDnsAvailability } from '@/modules/app/components/install-form/use-dns-availability';
import { resolveExposureMode } from '@/modules/onboarding/helpers/agent-onboarding';
import { buildPublicWebIdentity, sanitizeAppSubdomain, selectOfferedDomains } from '@ci-hub/common/types';
import type { AvailableDomain } from '@ci-hub/common/types';
import type { AppDetails, AppInfo } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';

type ExposureMode = 'local' | 'cloudflare' | 'tailscale';

type FormValues = {
  port: string;
  exposureMode: ExposureMode;
  localSubdomain?: string;
  publicDomain?: string;
};

const EMPTY_AVAILABLE_DOMAINS: AvailableDomain[] = [];

interface Props {
  app: AppDetails;
  info: AppInfo;
  isOpen: boolean;
  onClose: () => void;
}

export const PortExposeSettingsDialog = ({ app, info, isOpen, onClose }: Props) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { userSettings, cloudflareAvailable, tailscaleAvailable } = useAppContext();
  const { ciHubOrganizationSlug, ciHubDeviceSlug, domain } = userSettings;
  const orgSlug = ciHubOrganizationSlug ? ciHubOrganizationSlug.toLowerCase().replace(/\s+/g, '-') : undefined;

  const getDomains = useQuery({
    ...getDomainsOptions(),
    enabled: cloudflareAvailable && isOpen,
  });
  const availableDomains = selectOfferedDomains(getDomains.data?.domains ?? EMPTY_AVAILABLE_DOMAINS, app.publicDomain || domain);

  const {
    register,
    control,
    handleSubmit,
    watch,
    setError,
    clearErrors,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    values: {
      port: String(app.port ?? info.port ?? ''),
      exposureMode: resolveExposureMode((app.exposureMode as ExposureMode | undefined) ?? 'local', {
        cloudflareAvailable,
        tailscaleAvailable,
      }),
      localSubdomain: app.localSubdomain ?? info.id,
      publicDomain: app.publicDomain ?? domain,
    },
  });

  const watchExposureMode = watch('exposureMode');
  const watchLocalSubdomain = watch('localSubdomain');
  const watchPublicDomain = watch('publicDomain');

  const defaultAppSubdomain = sanitizeAppSubdomain(app.localSubdomain || info.id);
  const publicWebPreview =
    watchExposureMode === 'cloudflare' && orgSlug
      ? buildPublicWebIdentity({
          appSubdomain: sanitizeAppSubdomain(watchLocalSubdomain || defaultAppSubdomain),
          hubSubdomain: ciHubDeviceSlug ? `hub-${ciHubDeviceSlug}-${orgSlug}` : undefined,
          orgSlug,
          publicDomainRoot: watchPublicDomain || domain,
        })
      : null;

  const cloudflareSuffix = publicWebPreview
    ? publicWebPreview.hostname
        .slice(0, publicWebPreview.hostname.indexOf('.'))
        .slice(sanitizeAppSubdomain(watchLocalSubdomain || defaultAppSubdomain).length + 1)
    : (orgSlug ?? domain);

  const checkDnsAvailability = useCallback(
    async (subdomain: string, selectedDomain?: string) =>
      fetchDnsAvailability(subdomain, {
        domain: selectedDomain,
        appUrn: info.urn,
      }),
    [info.urn],
  );

  const { isCheckingDns, dnsAvailabilityError, domainAvailabilityError } = useDnsAvailability<FormValues>({
    // Not while the domain list is loading — see the install form.
    enabled: isOpen && watchExposureMode === 'cloudflare' && !getDomains.isLoading && Boolean((watchLocalSubdomain || defaultAppSubdomain).trim()),
    subdomain: watchLocalSubdomain || defaultAppSubdomain,
    selectedDomain: watchPublicDomain || domain,
    checkDnsAvailability,
    setError,
    clearErrors,
    t,
  });

  const updatePortExpose = useMutation({
    mutationFn: async (body: { port: number; exposureMode: ExposureMode; localSubdomain?: string; publicDomain?: string }) => {
      const { error } = await client.patch({
        url: `/api/custom-apps/port-expose/${info.urn}`,
        body,
        throwOnError: false,
      });
      if (error) {
        throw error;
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getAppQueryKey({ path: { urn: info.urn } }) });
      toast.success(t('PORT_EXPOSE_SETTINGS_SUCCESS'));
      onClose();
    },
    onError: (error: TranslatableError) => {
      toast.error(t(error.message || 'PORT_EXPOSE_UPDATE_ERROR', { ...error.intlParams }));
    },
  });

  const onSubmit = async (values: FormValues) => {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setError('port', { message: t('PORT_EXPOSE_PORT_INVALID') });
      return;
    }

    const exposureMode = resolveExposureMode(values.exposureMode, { cloudflareAvailable, tailscaleAvailable });

    if (exposureMode === 'cloudflare') {
      const subdomain = (values.localSubdomain || defaultAppSubdomain).trim();
      if (!subdomain) {
        setError('localSubdomain', { message: t('PORT_EXPOSE_SUBDOMAIN_REQUIRED') });
        return;
      }

      if (domainAvailabilityError) {
        setError('publicDomain', { message: domainAvailabilityError });
        toast.error(domainAvailabilityError);
        return;
      }

      if (dnsAvailabilityError) {
        setError('localSubdomain', { message: dnsAvailabilityError });
        toast.error(dnsAvailabilityError);
        return;
      }

      const subdomainChanged = sanitizeAppSubdomain(subdomain) !== sanitizeAppSubdomain(app.localSubdomain || defaultAppSubdomain);
      const domainChanged = (values.publicDomain || domain) !== (app.publicDomain || domain);

      if (subdomainChanged || domainChanged) {
        try {
          const response = await checkDnsAvailability(subdomain, values.publicDomain || domain);
          if (response.ok) {
            const data = await response.json();
            if (!data.available) {
              if (data.reason === 'zone_unreachable') {
                const message = typeof data.message === 'string' && data.message ? data.message : t('APP_INSTALL_FORM_ERROR_DOMAIN_UNAVAILABLE');
                setError('publicDomain', { message });
                toast.error(message);
                return;
              }

              const message =
                typeof data.message === 'string' && data.message ? data.message : t('APP_INSTALL_FORM_ERROR_DNS_NOT_AVAILABLE', { name: subdomain });
              setError('localSubdomain', { message });
              toast.error(message);
              return;
            }
          }
        } catch {
          // Allow submission if DNS check is unreachable.
        }
      }
    }

    updatePortExpose.mutate({
      port,
      exposureMode,
      localSubdomain: exposureMode === 'cloudflare' ? sanitizeAppSubdomain(values.localSubdomain || defaultAppSubdomain) : undefined,
      publicDomain: exposureMode === 'cloudflare' ? values.publicDomain || domain : undefined,
    });
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('PORT_EXPOSE_SETTINGS_TITLE')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto pr-1">
            <Input
              label={
                <>
                  {t('COMMON_PORT')} <span className="text-destructive">*</span>
                </>
              }
              type="number"
              min={1024}
              max={65535}
              {...register('port')}
              error={errors.port?.message}
              placeholder={t('PORT_EXPOSE_PORT_PLACEHOLDER')}
              disabled={updatePortExpose.isPending}
            />
            <p className="text-xs text-muted-foreground -mt-2">{t('PORT_EXPOSE_PORT_HELP')}</p>

            <div>
              <span className="block text-sm font-medium mb-1">{t('APP_INSTALL_FORM_EXPOSURE_MODE')}</span>
              <Controller
                control={control}
                name="exposureMode"
                render={({ field: { onChange, value } }) => (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {(
                      [
                        { key: 'local', label: t('APP_INSTALL_FORM_EXPOSURE_LOCAL'), available: true, tooltip: '' },
                        {
                          key: 'tailscale',
                          label: t('COMMON_PRIVATE_VPN'),
                          available: tailscaleAvailable,
                          tooltip: t('APP_INSTALL_FORM_EXPOSURE_TAILSCALE_UNAVAILABLE'),
                        },
                        {
                          key: 'cloudflare',
                          label: t('APP_INSTALL_FORM_EXPOSURE_CLOUDFLARE'),
                          available: cloudflareAvailable,
                          tooltip: t('APP_INSTALL_FORM_EXPOSURE_CLOUDFLARE_UNAVAILABLE'),
                        },
                      ] as const
                    ).map((option) => {
                      const isDisabled = updatePortExpose.isPending || !option.available;
                      return (
                        <div key={option.key} className="relative">
                          <button
                            type="button"
                            disabled={isDisabled}
                            data-tooltip-id={`port-expose-settings-exposure-${option.key}`}
                            data-tooltip-content={option.available ? undefined : option.tooltip}
                            onClick={() => option.available && onChange(option.key)}
                            className={clsx(
                              'w-full rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                              value === option.key
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700',
                              isDisabled && 'opacity-50 cursor-not-allowed hover:bg-white dark:hover:bg-gray-800',
                            )}
                          >
                            {option.label}
                          </button>
                          {!option.available && <Tooltip id={`port-expose-settings-exposure-${option.key}`} className="tooltip" />}
                        </div>
                      );
                    })}
                  </div>
                )}
              />
              {!tailscaleAvailable && (
                <p className="mt-2 text-xs text-muted-foreground">
                  <Link to="/settings?tab=network" className="text-primary underline-offset-2 hover:underline">
                    {t('APP_INSTALL_FORM_EXPOSURE_TAILSCALE_SETUP_LINK')}
                  </Link>
                </p>
              )}
            </div>

            {watchExposureMode === 'cloudflare' ? (
              <CloudflareSubdomainField
                control={control}
                availableDomains={availableDomains}
                watchPublicDomain={watchPublicDomain}
                domain={domain}
                cloudflareSuffix={cloudflareSuffix}
                register={register}
                loading={updatePortExpose.isPending}
                localSubdomainError={errors.localSubdomain?.message || dnsAvailabilityError || undefined}
                publicDomainError={errors.publicDomain?.message || domainAvailabilityError || undefined}
                placeholder={defaultAppSubdomain}
                isCheckingDns={isCheckingDns}
                domainListNote={domainListNoteFor(getDomains)}
                onRetryDomainList={() => void getDomains.refetch()}
                t={t}
              />
            ) : null}
          </div>

          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={handleClose} disabled={updatePortExpose.isPending}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button type="submit" loading={updatePortExpose.isPending}>
              {t('COMMON_SAVE')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
