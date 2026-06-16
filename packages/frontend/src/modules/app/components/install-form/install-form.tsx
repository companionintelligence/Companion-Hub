import { apiFetch } from '@/lib/api-fetch';
import type { GetRandomPortResponse } from '@/api-client';
import { getRandomPortMutation } from '@/api-client/@tanstack/react-query.gen';
import { getAvailableDomainsQueryOptions } from '@/api-client/domains-query';
import { Input } from '@/components/ui/Input';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { Switch } from '@/components/ui/Switch';
import { useAppContext } from '@/context/app-context';
import type { AppInfo, AppStatus, FormField } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Tooltip } from 'react-tooltip';
import type { AvailableDomain } from '@ci-hub/common/types';
import { buildPublicWebIdentity, sanitizeAppSubdomain } from '@ci-hub/common/types';
import { resolveExposureMode } from '@/modules/onboarding/helpers/agent-onboarding';
import { hiddenTypes, validateAppConfig } from './form-validators';
import { CloudflareSubdomainField } from './cloudflare-subdomain-field';
import { HostnamePreviewCard } from './hostname-preview-card';
import { InstallFormField } from './install-form-field';
import { useDnsAvailability } from './use-dns-availability';

interface IProps {
  formFields?: FormField[];
  onSubmit: (values: FormValues) => void;
  initialValues?: { [key: string]: unknown };
  info: AppInfo;
  loading?: boolean;
  formId: string;
  appStatus?: AppStatus;
  onValidityChange?: (isValid: boolean) => void;
  scrollable?: boolean;
  editingAppUrn?: string;
}

export type FormValues = {
  port?: string;
  exposed: boolean;
  exposedLocal: boolean;
  exposureMode: 'local' | 'cloudflare' | 'tailscale';
  openPort: boolean;
  domain?: string;
  localSubdomain?: string;
  publicDomain?: string;
  isVisibleOnGuestDashboard?: boolean;
  enableAuth: boolean;
  maxBackups?: number;
  cpuLimit?: string;
  [key: string]: unknown;
};

const typeFilter = (field: FormField) => !hiddenTypes.includes(field.type);
const EMPTY_AVAILABLE_DOMAINS: AvailableDomain[] = [];

function buildTailscalePortHost(nodeFqdn?: string | null, port?: number | null): string | null {
  const cleanNodeFqdn = nodeFqdn?.trim();
  if (!cleanNodeFqdn || !port) {
    return null;
  }

  return `${cleanNodeFqdn}:${port}`;
}

const ConfigSection: React.FC<{ scrollable?: boolean; children: React.ReactNode }> = ({ scrollable, children }) => {
  if (scrollable) {
    return (
      <ScrollArea maxheight={350}>
        <div className="pr-4">{children}</div>
      </ScrollArea>
    );
  }
  return <div>{children}</div>;
};

export const InstallForm: React.FC<IProps> = ({
  formFields = [],
  info,
  onSubmit,
  initialValues,
  loading,
  formId,
  appStatus,
  onValidityChange,
  scrollable,
  editingAppUrn,
}) => {
  const { t } = useTranslation();
  const { userSettings, isProduction, user, cloudflareAvailable, tailscaleAvailable, tailscaleNodeFqdn } = useAppContext();
  const { guestDashboard, localDomain, maxBackups: globalMaxBackups, ciHubOrganizationSlug, ciHubDeviceSlug, domain } = userSettings;
  const globalCpuLimit = userSettings.defaultAppCpuLimit ?? '';
  const isAdvancedMode = user.advancedMode;

  const orgSlug = ciHubOrganizationSlug ? ciHubOrganizationSlug.toLowerCase().replace(/\s+/g, '-') : undefined;
  const defaultAppSubdomain = info.urn.split(':')[0] ?? info.urn;

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty, dirtyFields },
    setValue,
    watch,
    getValues,
    setError,
    clearErrors,
    control,
  } = useForm<FormValues>({});
  const _watchExposed = watch('exposed', false);
  const _watchOpenPort = watch('openPort', !info.force_expose);
  const _watchExposedLocal = watch('exposedLocal', false);
  const watchLocalSubdomain = watch('localSubdomain', '');
  const watchExposureMode = watch('exposureMode');
  const watchPort = watch('port', info.port ? info.port.toString() : '');
  const watchPublicDomainRaw = watch('publicDomain');
  const watchPublicDomain = watchPublicDomainRaw || domain;

  const publicWebPreview = useMemo(() => {
    if (watchExposureMode !== 'cloudflare' || !orgSlug) return null;
    const hubSubdomain = ciHubDeviceSlug ? `hub-${ciHubDeviceSlug}-${orgSlug}` : undefined;
    return buildPublicWebIdentity({
      appSubdomain: watchLocalSubdomain || defaultAppSubdomain,
      hubSubdomain,
      orgSlug,
      publicDomainRoot: watchPublicDomain || domain || 'example.com',
    });
  }, [watchExposureMode, orgSlug, watchLocalSubdomain, defaultAppSubdomain, ciHubDeviceSlug, watchPublicDomain, domain]);

  const tailscalePreviewHost = useMemo(() => {
    if (watchExposureMode !== 'tailscale') return '';
    const requestedPort = Number.parseInt(watchPort || '', 10);
    return buildTailscalePortHost(tailscaleNodeFqdn, Number.isNaN(requestedPort) ? (info.port ?? null) : requestedPort) || '';
  }, [watchExposureMode, watchPort, tailscaleNodeFqdn, info.port]);

  const localPreviewHost = useMemo(() => {
    if (watchExposureMode !== 'local') return '';
    const requestedPort = Number.parseInt(watchPort || '', 10);
    const resolvedPort = Number.isNaN(requestedPort) ? info.port : requestedPort;
    return resolvedPort ? `localhost:${resolvedPort}` : 'localhost';
  }, [watchExposureMode, watchPort, info.port]);

  const previewHostname =
    watchExposureMode === 'cloudflare'
      ? publicWebPreview?.hostname || ''
      : watchExposureMode === 'tailscale'
        ? tailscalePreviewHost || `${tailscaleNodeFqdn || 'tailnet'}${watchPort ? `:${watchPort}` : ''}`
        : localPreviewHost;

  const { data: availableDomainsData } = useQuery(getAvailableDomainsQueryOptions());
  const availableDomains = useMemo(() => availableDomainsData?.domains ?? EMPTY_AVAILABLE_DOMAINS, [availableDomainsData?.domains]);

  const requiredFieldNames = formFields.filter((f) => f.required && !hiddenTypes.includes(f.type)).map((f) => f.env_variable);
  const watchedRequiredValues = watch(requiredFieldNames);

  // Track the previously-rendered app URN so the init effect can detect when
  // the form is reused for a different app and force-reset stale field values.
  const prevUrnRef = useRef<string | undefined>(undefined);
  const [publicWebExpectedUrl, setPublicWebExpectedUrl] = useState<string | null>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

  const checkDnsAvailability = async (subdomain: string, selectedDomain?: string) => {
    const query = new URLSearchParams({ subdomain });
    if (selectedDomain) {
      query.set('domain', selectedDomain);
    }
    if (editingAppUrn) {
      query.set('appUrn', editingAppUrn);
    }

    return apiFetch(`/api/cloudflare/check-dns-availability?${query.toString()}`, {
      credentials: 'include',
    });
  };

  const copyToClipboard = async (text: string) => {
    const value = text.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('SETTINGS_NETWORK_COPIED'));
    } catch {
      toast.error(t('SETTINGS_GENERAL_COPY_FAILED'));
    }
  };

  // Track form validity for parent components
  useEffect(() => {
    if (!onValidityChange) return;

    // For exposable apps, require an exposure mode to be selected
    if (info.exposable && info.dynamic_config && !watchExposureMode) {
      onValidityChange(false);
      return;
    }

    // Check required form fields have values
    const requiredFields = formFields.filter((f) => f.required && !hiddenTypes.includes(f.type));
    const allRequiredFilled = requiredFields.every((f, i) => {
      const val = watchedRequiredValues[i];
      // Fields with defaults count as filled
      if (f.default !== undefined && f.default !== '') return true;
      return val !== undefined && val !== '' && val !== null;
    });

    onValidityChange(allRequiredFilled);
  }, [onValidityChange, info.exposable, info.dynamic_config, watchExposureMode, formFields, watchedRequiredValues]);

  useEffect(() => {
    // Detect when the form is reused for a different app so we can force-reset
    // stale values (e.g. publicDomain left over from the previous app).
    const appChanged = prevUrnRef.current !== undefined && prevUrnRef.current !== info.urn;
    prevUrnRef.current = info.urn;

    if (initialValues && !isDirty) {
      for (const [key, value] of Object.entries(initialValues)) {
        setValue(key, value as string);
      }
    }
    if (info.force_expose) {
      setValue('exposed', true);
      setValue('openPort', false);
    }
    // Set default exposure mode and port for exposable apps
    if (info.exposable && info.dynamic_config) {
      // Auto-select first available mode: cloudflare > tailscale > local
      const defaultMode = resolveExposureMode(initialValues?.exposureMode as FormValues['exposureMode'] | undefined, {
        cloudflareAvailable,
        tailscaleAvailable,
      });
      setValue('exposureMode', defaultMode);
      setValue('exposedLocal', true); // backward compat
      setValue('openPort', defaultMode === 'local');
      setValue('enableAuth', true); // Enable authentication by default
      if (info.port) {
        setValue('port', info.port.toString());
      }
      // Reset publicDomain when switching apps (appChanged) so stale values
      // from a previous app don't carry over; otherwise only write the default
      // when the field hasn't been customised yet.
      const currentPD = getValues('publicDomain');
      if (!initialValues?.publicDomain && domain && (appChanged || !currentPD || currentPD === domain)) {
        setValue('publicDomain', domain);
      }
    }
  }, [
    initialValues,
    isDirty,
    getValues,
    setValue,
    info.urn,
    info.force_expose,
    info.exposable,
    info.dynamic_config,
    info.port,
    initialValues?.publicDomain,
    cloudflareAvailable,
    domain,
    tailscaleAvailable,
  ]);

  // Separate effect: only responsible for setting the default localSubdomain.
  // Isolated from the initialisation effect above so that typing in the
  // subdomain field does not re-run that effect and clobber user choices such
  // as exposureMode, openPort, or enableAuth.
  useEffect(() => {
    if (watchExposureMode === 'cloudflare' && info.exposable && info.dynamic_config && !watchLocalSubdomain) {
      const defaultSubdomain = info.urn.split(':')[0];
      setValue('localSubdomain', defaultSubdomain);
    }
  }, [watchExposureMode, info.exposable, info.dynamic_config, info.urn, watchLocalSubdomain, setValue]);

  useEffect(() => {
    if (watchExposureMode !== 'cloudflare' || availableDomains.length === 0) {
      return;
    }

    const currentPublicDomain = getValues('publicDomain');
    const defaultDomain = availableDomains.find((entry) => entry.isDefault)?.domain;
    const fallbackDomain = defaultDomain || availableDomains[0]?.domain;
    if (!fallbackDomain) {
      return;
    }

    if (dirtyFields.publicDomain) {
      return;
    }

    // Preserve explicit user/form values; only replace the implicit device-domain fallback.
    if (currentPublicDomain && currentPublicDomain !== domain) {
      return;
    }

    setValue('publicDomain', fallbackDomain);
  }, [availableDomains, dirtyFields.publicDomain, domain, getValues, setValue, watchExposureMode]);

  useEffect(() => {
    if (appStatus !== 'running' || watchExposureMode !== 'cloudflare') {
      setPublicWebExpectedUrl(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch('/api/public-web/diagnostics');
        if (!response.ok) return;
        const data = (await response.json()) as {
          apps: { appUrn: string; envMismatch: boolean; computedPublicUrl: string }[];
        };
        const entry = data.apps.find((app) => app.appUrn === info.urn);
        if (!cancelled && entry?.envMismatch) {
          setPublicWebExpectedUrl(entry.computedPublicUrl);
        } else if (!cancelled) {
          setPublicWebExpectedUrl(null);
        }
      } catch {
        if (!cancelled) setPublicWebExpectedUrl(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [appStatus, watchExposureMode, info.urn]);

  const _randomPortMutation = useMutation({
    ...getRandomPortMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: (data: GetRandomPortResponse) => {
      setValue('port', data.port.toString(), { shouldDirty: true });
    },
  });

  const { isCheckingDns, dnsAvailabilityError } = useDnsAvailability({
    enabled: info.exposable && isProduction && watchExposureMode === 'cloudflare',
    subdomain: watchLocalSubdomain || defaultAppSubdomain,
    selectedDomain: watchPublicDomain || domain,
    checkDnsAvailability,
    setError,
    clearErrors,
    t,
  });

  const renderField = (field: FormField) => {
    return (
      <InstallFormField
        loading={loading}
        initialValue={(initialValues ? initialValues[field.env_variable] : field.default) as string}
        register={register}
        field={field}
        control={control}
        key={field.env_variable}
        error={errors[field.env_variable]?.message}
      />
    );
  };

  const renderExposeForm = () => {
    // Hide "expose to internet" option - all apps are published via Traefik + Cloudflare Tunnel
    return null;
  };

  const renderExposureModeSelector = () => {
    const transitionalStatuses = ['installing', 'starting', 'stopping', 'updating', 'restarting', 'backing_up'];
    const isTransitional = appStatus ? transitionalStatuses.includes(appStatus) : false;

    if (!info.exposable) return null;

    return (
      <div className="mb-3">
        <span className="block text-sm font-medium mb-1">{t('APP_INSTALL_FORM_EXPOSURE_MODE')}</span>
        <Controller
          control={control}
          name="exposureMode"
          defaultValue="cloudflare"
          render={({ field: { onChange, value } }) => (
            <div className="grid grid-cols-3 gap-2">
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
                const isDisabled = loading || !option.available || isTransitional;
                return (
                  <div key={option.key} className="relative">
                    <button
                      type="button"
                      disabled={isDisabled}
                      data-tooltip-id={`exposure-tooltip-${option.key}`}
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
                    {!option.available && <Tooltip id={`exposure-tooltip-${option.key}`} className="tooltip" />}
                  </div>
                );
              })}
            </div>
          )}
        />
        {!tailscaleAvailable && info.exposable && info.dynamic_config && (
          <p className="mt-2 text-xs text-muted-foreground">
            <Link to="/settings?tab=network" className="text-primary underline-offset-2 hover:underline">
              {t('APP_INSTALL_FORM_EXPOSURE_TAILSCALE_SETUP_LINK')}
            </Link>
          </p>
        )}
      </div>
    );
  };

  const renderHostnameSettings = () => {
    if (!info.exposable) return null;

    const cloudflareSuffix = publicWebPreview
      ? publicWebPreview.hostname
          .slice(0, publicWebPreview.hostname.indexOf('.'))
          .slice(sanitizeAppSubdomain(watchLocalSubdomain || defaultAppSubdomain).length + 1)
      : localDomain;

    return (
      <>
        {publicWebExpectedUrl && (
          <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
            Public Web routing is out of sync. Expected URL: {publicWebExpectedUrl}. Save settings or run repair to update routing.
          </p>
        )}
        {watchExposureMode === 'cloudflare' ? (
          <CloudflareSubdomainField
            control={control}
            availableDomains={availableDomains}
            watchPublicDomain={watchPublicDomain}
            domain={domain}
            cloudflareSuffix={cloudflareSuffix}
            register={register}
            loading={loading}
            localSubdomainError={errors.localSubdomain?.message || dnsAvailabilityError || undefined}
            placeholder={defaultAppSubdomain}
            isCheckingDns={isCheckingDns}
            t={t}
          />
        ) : null}
        <HostnamePreviewCard hostname={previewHostname} onCopy={copyToClipboard} title={t('COMMON_HOSTNAME')} />
      </>
    );
  };

  const renderAdvancedExposureOptions = () => {
    if (!info.exposable || (!isAdvancedMode && !showAdvancedSettings)) return null;

    return (
      <Controller
        control={control}
        name="enableAuth"
        defaultValue={true}
        render={({ field: { onChange, value, ref, ...props } }) => (
          <Switch
            {...props}
            className="mb-3"
            ref={ref}
            checked={value ?? true}
            onCheckedChange={onChange}
            label={
              <>
                {t('APP_INSTALL_FORM_ENABLE_AUTH')}
                <Tooltip className="tooltip" anchorSelect=".enable-auth-hint">
                  {t('APP_INSTALL_FORM_ENABLE_AUTH_HINT')}
                </Tooltip>
                <span className={clsx('ms-1 form-help enable-auth-hint')}>?</span>
              </>
            }
          />
        )}
      />
    );
  };

  const validate = async (values: FormValues) => {
    const exposureMode = resolveExposureMode(values.exposureMode, { cloudflareAvailable, tailscaleAvailable });
    const formValues = {
      ...values,
      exposureMode,
      exposedLocal: exposureMode === 'cloudflare', // backward compat
      enableAuth: values.enableAuth ?? true,
      port: values.port || (info.port ? info.port.toString() : undefined),
    };

    // Set default subdomain if not provided and app is exposable
    if (info.exposable && formValues.exposureMode === 'cloudflare' && !formValues.localSubdomain) {
      formValues.localSubdomain = info.urn.split(':')[0];
    }

    const validationErrors = validateAppConfig(formValues, formFields);

    // In production, require port when publishing to internet
    if (isProduction && formValues.exposedLocal && info.dynamic_config && !formValues.port) {
      validationErrors.port = { messageKey: 'APP_INSTALL_FORM_ERROR_REQUIRED', params: { label: t('COMMON_PORT') } };
    }

    // Check DNS availability synchronously if in production and exposable
    if (isProduction && info.exposable && formValues.exposureMode === 'cloudflare' && formValues.exposedLocal && formValues.localSubdomain) {
      if (isCheckingDns) {
        // Wait a bit for DNS check to complete
        await new Promise((resolve) => setTimeout(resolve, 600));
      }

      // If DNS check found an error, prevent submission
      if (dnsAvailabilityError) {
        setError('localSubdomain', { message: dnsAvailabilityError });
        toast.error(dnsAvailabilityError);
        return;
      }
      // Perform a final DNS check before submission
      try {
        const selectedDomain = formValues.exposureMode === 'cloudflare' ? formValues.publicDomain || domain : undefined;
        const response = await checkDnsAvailability(formValues.localSubdomain, selectedDomain);

        if (response.ok) {
          const data = await response.json();
          if (!data.available) {
            if (typeof data.message === 'string' && data.message) {
              setError('localSubdomain', { message: data.message });
              toast.error(data.message);
              return;
            }

            validationErrors.localSubdomain = {
              messageKey: 'APP_INSTALL_FORM_ERROR_DNS_NOT_AVAILABLE',
              params: { name: formValues.localSubdomain },
            };
          }
        }
      } catch (error) {
        // If DNS check fails, allow submission (graceful degradation)
        console.warn('DNS check failed during validation, allowing submission:', error);
      }
    }

    for (const [key, value] of Object.entries(validationErrors)) {
      if (value) {
        setError(key, { message: t(value.messageKey, value.params) });
      }
    }

    if (Object.keys(validationErrors).length === 0) {
      onSubmit(formValues);
    } else {
      toast.error(t('APP_INSTALL_FORM_ERROR_INVALID'));
    }
  };

  const onInvalid = () => {
    toast.error(t('APP_INSTALL_FORM_ERROR_INVALID'));
  };

  const hasOptionalFields = formFields.some((field) => !field.required && typeFilter(field));
  const hasAdvancedSimpleModeOptions = hasOptionalFields || (info.exposable && info.dynamic_config);
  const shouldShowAdvancedSettingsToggle = !isAdvancedMode && hasAdvancedSimpleModeOptions;
  const visibleFields =
    isAdvancedMode || showAdvancedSettings ? formFields.filter(typeFilter) : formFields.filter((field) => field.required && typeFilter(field));
  const hasConfigSection = visibleFields.length > 0 || shouldShowAdvancedSettingsToggle || (guestDashboard && isAdvancedMode) || isAdvancedMode;

  return (
    <form className="flex flex-col" onSubmit={handleSubmit(validate, onInvalid)} id={formId}>
      {/* Exposure mode selector — always shown when applicable, even in simple mode */}
      {info.exposable && info.dynamic_config && renderExposureModeSelector()}
      {renderHostnameSettings()}

      {/* Configuration section — scrollable when in a dialog */}
      {hasConfigSection && (
        <ConfigSection scrollable={scrollable}>
          {visibleFields.length > 0 && <h3 className="text-base font-bold tracking-wide text-foreground mb-3">{t('COMMON_SETTINGS')}</h3>}
          {shouldShowAdvancedSettingsToggle && (
            <Switch
              className="mb-3"
              checked={showAdvancedSettings}
              onCheckedChange={setShowAdvancedSettings}
              label={t('APP_INSTALL_FORM_SHOW_ADVANCED_SETTINGS')}
            />
          )}
          {visibleFields.map(renderField)}
          {guestDashboard && isAdvancedMode && (
            <Controller
              control={control}
              name="isVisibleOnGuestDashboard"
              defaultValue={false}
              render={({ field: { onChange, value, ref, ...props } }) => (
                <Switch
                  className="mb-3"
                  ref={ref}
                  checked={value}
                  onCheckedChange={onChange}
                  {...props}
                  label={t('APP_INSTALL_FORM_DISPLAY_ON_GUEST_DASHBOARD')}
                />
              )}
            />
          )}
          {info.exposable && info.dynamic_config && renderAdvancedExposureOptions()}
          {renderExposeForm()}
          {isAdvancedMode && (
            <div className="mb-3">
              <Input
                type="number"
                min={0}
                max={100}
                {...register('maxBackups', {
                  valueAsNumber: true,
                  setValueAs: (value) => (value === '' || value === null ? undefined : Number(value)),
                  min: { value: 0, message: t('APP_INSTALL_FORM_MAX_BACKUPS_ERROR_MIN') },
                  max: { value: 100, message: t('APP_INSTALL_FORM_MAX_BACKUPS_ERROR_MAX') },
                })}
                label={t('APP_INSTALL_FORM_MAX_BACKUPS')}
                error={errors.maxBackups?.message}
                placeholder={globalMaxBackups === 0 ? undefined : globalMaxBackups.toString()}
              />
              <span className="text-sm text-muted-foreground">{t('APP_INSTALL_FORM_MAX_BACKUPS_HINT', { value: globalMaxBackups })}</span>
            </div>
          )}
          {isAdvancedMode && (
            <div className="mb-3">
              <Input
                type="number"
                step="0.1"
                min="0.1"
                {...register('cpuLimit', {
                  setValueAs: (value) => (value === '' || value === null ? undefined : String(value)),
                })}
                label={t('APP_INSTALL_FORM_CPU_LIMIT')}
                error={errors.cpuLimit?.message}
                placeholder={globalCpuLimit || '1.0'}
              />
              <span className="text-sm text-muted-foreground">{t('APP_INSTALL_FORM_CPU_LIMIT_HINT')}</span>
            </div>
          )}
        </ConfigSection>
      )}
    </form>
  );
};
