import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Controller, useForm } from 'react-hook-form';
import clsx from 'clsx';
import { Link } from 'react-router';
import { Tooltip } from 'react-tooltip';
import { client } from '@/api-client/client.gen';
import { getDomainsOptions } from '@/api-client/@tanstack/react-query.gen';
import { Input } from '@/components/ui/Input/Input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { resolveExposureMode } from '@/modules/onboarding/helpers/agent-onboarding';
import { CloudflareSubdomainField } from '@/modules/app/components/install-form/cloudflare-subdomain-field';
import { domainListNoteFor } from '@/modules/app/components/install-form/domain-list-note';
import { useDnsAvailability } from '@/modules/app/components/install-form/use-dns-availability';
import { useCallback } from 'react';
import { fetchDnsAvailability } from '@/lib/cloudflare-api';
import { buildPublicWebIdentity, deriveAppSlug, RESERVED_APP_NAMES, sanitizeAppSubdomain, selectOfferedDomains } from '@ci-hub/common/types';
import type { AvailableDomain } from '@ci-hub/common/types';
import type { TranslatableError } from '@/types/error.types';

type ExposureMode = 'local' | 'cloudflare' | 'tailscale';

type FormValues = {
  name: string;
  port: string;
  exposureMode: ExposureMode;
  localSubdomain?: string;
  publicDomain?: string;
};

const EMPTY_AVAILABLE_DOMAINS: AvailableDomain[] = [];

export default function PortExposeCreatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { userSettings, cloudflareAvailable, tailscaleAvailable } = useAppContext();
  const { ciHubOrganizationSlug, ciHubDeviceSlug, domain } = userSettings;
  const orgSlug = ciHubOrganizationSlug ? ciHubOrganizationSlug.toLowerCase().replace(/\s+/g, '-') : undefined;

  const getDomains = useQuery({
    ...getDomainsOptions(),
    enabled: cloudflareAvailable,
  });
  const availableDomains = selectOfferedDomains(getDomains.data?.domains ?? EMPTY_AVAILABLE_DOMAINS, domain);

  const {
    register,
    control,
    handleSubmit,
    watch,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: {
      exposureMode: resolveExposureMode(undefined, { cloudflareAvailable, tailscaleAvailable }),
    },
  });

  const watchExposureMode = watch('exposureMode');
  const watchLocalSubdomain = watch('localSubdomain');
  const watchPublicDomain = watch('publicDomain');
  const watchName = watch('name');

  const derivedSlug = deriveAppSlug(watchName || '');
  const defaultAppSubdomain = derivedSlug || 'app';
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
      }),
    [],
  );

  const { isCheckingDns, dnsAvailabilityError, domainAvailabilityError } = useDnsAvailability<FormValues>({
    enabled: watchExposureMode === 'cloudflare' && Boolean((watchLocalSubdomain || defaultAppSubdomain).trim()),
    subdomain: watchLocalSubdomain || defaultAppSubdomain,
    selectedDomain: watchPublicDomain || domain,
    checkDnsAvailability,
    setError,
    clearErrors,
    t,
  });

  const createPortExpose = useMutation({
    mutationFn: async (body: { name: string; port: number; exposureMode: ExposureMode; localSubdomain?: string; publicDomain?: string }) => {
      const { data, error } = await client.post({
        url: '/api/custom-apps/port-expose',
        body,
        throwOnError: false,
      });
      if (error) {
        throw error;
      }
      return data as { appUrn: string; appName: string; storeId: string };
    },
    onSuccess: (data, variables) => {
      toast.success(t('PORT_EXPOSE_CREATE_SUCCESS', { name: variables.name }));
      // Navigate by the derived slug returned from the server, not the
      // free-form display name (the URL segment is the app identifier).
      navigate(`/apps/${data?.appName ?? deriveAppSlug(variables.name)}`);
    },
    onError: (error: TranslatableError) => {
      toast.error(t(error.message || 'PORT_EXPOSE_CREATE_ERROR', { ...error.intlParams }));
    },
  });

  const onSubmit = async (values: FormValues) => {
    // The display name is free-form; the URL-safe slug used as the app
    // identifier is derived from it (the same helper that drives the
    // subdomain preview). The backend re-derives and enforces the slug.
    const displayName = values.name.trim();
    const nameSchema = z.string().min(1, t('CUSTOM_APP_NAME_REQUIRED')).max(50, t('CUSTOM_APP_NAME_MAX_LENGTH'));

    const nameValidation = nameSchema.safeParse(displayName);
    if (!nameValidation.success) {
      setError('name', { message: z.prettifyError(nameValidation.error) });
      return;
    }

    const slug = deriveAppSlug(displayName);
    if (!slug) {
      setError('name', { message: t('CUSTOM_APP_NAME_NO_SLUG') });
      return;
    }
    if (RESERVED_APP_NAMES.includes(slug)) {
      setError('name', { message: t('CUSTOM_APP_NAME_RESERVED') });
      return;
    }

    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setError('port', { message: t('PORT_EXPOSE_PORT_INVALID') });
      return;
    }

    const exposureMode = resolveExposureMode(values.exposureMode, { cloudflareAvailable, tailscaleAvailable });

    if (exposureMode === 'cloudflare') {
      const subdomain = (values.localSubdomain || slug).trim();
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

    createPortExpose.mutate({
      name: displayName,
      port,
      exposureMode,
      localSubdomain: exposureMode === 'cloudflare' ? sanitizeAppSubdomain(values.localSubdomain || slug) : undefined,
      publicDomain: exposureMode === 'cloudflare' ? values.publicDomain || domain : undefined,
    });
  };

  return (
    <div className="page-scroller-edge-0 relative h-full overflow-y-auto" data-page-scroller="port-expose">
      <div className="mx-auto max-w-3xl pb-8">
        <Card>
          <CardHeader>
            <CardTitle>{t('PORT_EXPOSE_TITLE')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('PORT_EXPOSE_DESCRIPTION')}</p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <Input
                label={
                  <>
                    {t('CUSTOM_APP_NAME_LABEL')} <span className="text-destructive">*</span>
                  </>
                }
                {...register('name')}
                error={errors.name?.message}
                placeholder={t('CUSTOM_APP_NAME_PLACEHOLDER')}
                disabled={createPortExpose.isPending}
              />
              <p className="text-xs text-muted-foreground -mt-2">
                {t('CUSTOM_APP_NAME_HELP')}
                {watchName && derivedSlug ? ` ${t('CUSTOM_APP_NAME_DERIVED', { slug: derivedSlug })}` : ''}
              </p>

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
                disabled={createPortExpose.isPending}
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
                        const isDisabled = createPortExpose.isPending || !option.available;
                        return (
                          <div key={option.key} className="relative">
                            <button
                              type="button"
                              disabled={isDisabled}
                              data-tooltip-id={`port-expose-exposure-${option.key}`}
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
                            {!option.available && <Tooltip id={`port-expose-exposure-${option.key}`} className="tooltip" />}
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
                  loading={createPortExpose.isPending}
                  localSubdomainError={errors.localSubdomain?.message || dnsAvailabilityError || undefined}
                  publicDomainError={errors.publicDomain?.message || domainAvailabilityError || undefined}
                  placeholder={defaultAppSubdomain}
                  isCheckingDns={isCheckingDns}
                  domainListNote={domainListNoteFor(getDomains)}
                  onRetryDomainList={() => void getDomains.refetch()}
                  t={t}
                />
              ) : null}

              <div className="flex flex-wrap gap-2 pt-2">
                <Button type="submit" loading={createPortExpose.isPending}>
                  {t('PORT_EXPOSE_SUBMIT')}
                </Button>
                <Button type="button" variant="outline" onClick={() => navigate('/store')} disabled={createPortExpose.isPending}>
                  {t('COMMON_CANCEL')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
