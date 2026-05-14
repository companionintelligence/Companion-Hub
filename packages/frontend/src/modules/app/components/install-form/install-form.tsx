import { apiFetch } from '@/lib/api-fetch';
import type { GetRandomPortResponse } from '@/api-client';
import { getRandomPortMutation } from '@/api-client/@tanstack/react-query.gen';
import { getAvailableDomainsQueryOptions } from '@/api-client/domains-query';
import { Input, InputGroup } from '@/components/ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { Switch } from '@/components/ui/Switch';
import { useAppContext } from '@/context/app-context';
import type { AppInfo, AppStatus, FormField } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Tooltip } from 'react-tooltip';
import { hiddenTypes, validateAppConfig } from './form-validators';
import { InstallFormField } from './install-form-field';

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
  [key: string]: unknown;
};

const typeFilter = (field: FormField) => !hiddenTypes.includes(field.type);

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
}) => {
  const { t } = useTranslation();
  const { userSettings, isProduction, user, cloudflareAvailable, tailscaleAvailable } = useAppContext();
  const { guestDashboard, localDomain, maxBackups: globalMaxBackups, ciHubOrganizationSlug, ciHubDeviceSlug, domain } = userSettings;
  const isAdvancedMode = user.advancedMode;

  const orgSlug = ciHubOrganizationSlug ? ciHubOrganizationSlug.toLowerCase().replace(/\s+/g, '-') : undefined;

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
    setValue,
    watch,
    setError,
    clearErrors,
    control,
  } = useForm<FormValues>({});
  const _watchExposed = watch('exposed', false);
  const _watchOpenPort = watch('openPort', !info.force_expose);
  const _watchExposedLocal = watch('exposedLocal', false);
  const watchLocalSubdomain = watch('localSubdomain', '');
  const watchExposureMode = watch('exposureMode');
  const watchPublicDomain = watch('publicDomain', domain);

  const { data: availableDomainsData } = useQuery(getAvailableDomainsQueryOptions());
  const availableDomains = availableDomainsData?.domains ?? [];

  const requiredFieldNames = formFields.filter((f) => f.required && !hiddenTypes.includes(f.type)).map((f) => f.env_variable);
  const watchedRequiredValues = watch(requiredFieldNames);

  const dnsCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isCheckingDns, setIsCheckingDns] = useState(false);
  const [dnsAvailabilityError, setDnsAvailabilityError] = useState<string | null>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

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
      const defaultMode = cloudflareAvailable ? 'cloudflare' : tailscaleAvailable ? 'tailscale' : 'local';
      setValue('exposureMode', (initialValues?.exposureMode as FormValues['exposureMode']) || defaultMode);
      setValue('exposedLocal', true); // backward compat
      setValue('openPort', false); // Always false - apps route through Traefik
      setValue('enableAuth', true); // Enable authentication by default
      if (info.port) {
        setValue('port', info.port.toString());
      }
      // Set default subdomain if not provided
      const defaultSubdomain = info.urn.split(':')[0]; // Use app name as default subdomain
      if (!watchLocalSubdomain) {
        setValue('localSubdomain', defaultSubdomain);
      }
      if (!initialValues?.publicDomain && domain) {
        setValue('publicDomain', domain);
      }
    }
  }, [
    initialValues,
    isDirty,
    setValue,
    info.force_expose,
    info.exposable,
    info.dynamic_config,
    info.port,
    watchLocalSubdomain,
    // include the urn string itself (not the split function) so the effect
    // re-runs when the app urn changes
    info.urn,
    initialValues?.publicDomain,
    cloudflareAvailable,
    domain,
    tailscaleAvailable,
  ]);

  useEffect(() => {
    if (watchExposureMode !== 'cloudflare' || availableDomains.length === 0 || watchPublicDomain) {
      return;
    }

    const defaultDomain = availableDomains.find((entry) => entry.isDefault)?.domain;
    setValue('publicDomain', defaultDomain || domain || availableDomains[0]?.domain);
  }, [availableDomains, domain, setValue, watchExposureMode, watchPublicDomain]);

  const _randomPortMutation = useMutation({
    ...getRandomPortMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: (data: GetRandomPortResponse) => {
      setValue('port', data.port.toString(), { shouldDirty: true });
    },
  });

  // Check DNS availability when localSubdomain changes
  useEffect(() => {
    // Clear any existing timeout
    if (dnsCheckTimeoutRef.current) {
      clearTimeout(dnsCheckTimeoutRef.current);
    }

    // Only check if the app is exposable and we're in production
    if (!info.exposable || !isProduction) {
      setDnsAvailabilityError(null);
      setIsCheckingDns(false);
      return;
    }

    // Determine which subdomain to check
    // If localSubdomain is empty, use the default (appName-appStoreId format)
    const subdomainToCheck = watchLocalSubdomain || info.urn.split(':')[0];
    const selectedDomain = watchExposureMode === 'cloudflare' ? watchPublicDomain || domain : undefined;

    if (!subdomainToCheck) {
      setDnsAvailabilityError(null);
      setIsCheckingDns(false);
      return;
    }

    setIsCheckingDns(true);
    setDnsAvailabilityError(null);

    // Debounce the DNS check
    dnsCheckTimeoutRef.current = setTimeout(async () => {
      try {
        const query = new URLSearchParams({ subdomain: subdomainToCheck });
        if (selectedDomain) {
          query.set('domain', selectedDomain);
        }

        const response = await apiFetch(`/api/cloudflare/check-dns-availability?${query.toString()}`, {
          credentials: 'include',
        });

        if (response.ok) {
          const data = await response.json();
          if (data.available) {
            // Clear error if DNS is available
            setDnsAvailabilityError(null);
            clearErrors('localSubdomain');
          } else {
            const errorMessage = t('APP_INSTALL_FORM_ERROR_DNS_NOT_AVAILABLE', { name: subdomainToCheck });
            setDnsAvailabilityError(errorMessage);
            setError('localSubdomain', {
              type: 'manual',
              message: errorMessage,
            });
          }
        } else {
          // If API call fails, don't block - just log
          console.warn('DNS availability check failed:', response.status);
        }
      } catch (error) {
        // Silently fail - don't block form submission if DNS check fails
        console.error('Failed to check DNS availability:', error);
      } finally {
        setIsCheckingDns(false);
      }
    }, 500); // 500ms debounce

    return () => {
      if (dnsCheckTimeoutRef.current) {
        clearTimeout(dnsCheckTimeoutRef.current);
      }
    };
  }, [watchExposureMode, watchPublicDomain, domain, watchLocalSubdomain, info.exposable, info.urn, isProduction, setError, clearErrors, t]);

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
                  {
                    key: 'cloudflare',
                    label: t('APP_INSTALL_FORM_EXPOSURE_CLOUDFLARE'),
                    available: cloudflareAvailable,
                    tooltip: t('APP_INSTALL_FORM_EXPOSURE_CLOUDFLARE_UNAVAILABLE'),
                  },
                  {
                    key: 'tailscale',
                    label: t('APP_INSTALL_FORM_EXPOSURE_TAILSCALE'),
                    available: tailscaleAvailable,
                    tooltip: t('APP_INSTALL_FORM_EXPOSURE_TAILSCALE_UNAVAILABLE'),
                  },
                  { key: 'local', label: t('APP_INSTALL_FORM_EXPOSURE_LOCAL'), available: true, tooltip: '' },
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

  const renderAdvancedExposureOptions = () => {
    if (!info.exposable || (!isAdvancedMode && !showAdvancedSettings)) return null;

    return (
      <>
        {/* Subdomain input — shown for cloudflare and tailscale modes */}
        {watchExposureMode !== 'local' && (
          <div className="mb-3">
            {watchExposureMode === 'cloudflare' && availableDomains.length > 0 && (
              <Controller
                control={control}
                name="publicDomain"
                defaultValue={watchPublicDomain || domain}
                render={({ field: { onChange, value } }) => (
                  <Select value={value || ''} onValueChange={onChange}>
                    <SelectTrigger className="mb-3" label={t('APP_INSTALL_FORM_PUBLIC_DOMAIN')}>
                      <SelectValue placeholder={t('APP_INSTALL_FORM_PUBLIC_DOMAIN')} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableDomains.map((entry) => (
                        <SelectItem key={entry.id} value={entry.domain}>
                          {entry.domain}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}

            <InputGroup
              groupPrefix="https://"
              groupSuffix={
                watchExposureMode === 'tailscale'
                  ? `.${localDomain || 'tailnet'}`
                  : orgSlug
                    ? `-${ciHubDeviceSlug ? `${ciHubDeviceSlug}-` : ''}${orgSlug}.${watchPublicDomain || domain}`
                    : `-${localDomain}`
              }
              {...register('localSubdomain')}
              label={t('APP_INSTALL_FORM_LOCAL_SUBDOMAIN')}
              error={errors.localSubdomain?.message || dnsAvailabilityError || undefined}
              disabled={loading}
              placeholder={info.urn.split(':')[0]}
            />
            {isCheckingDns && <p className="mt-1.5 text-sm text-muted-foreground">{t('APP_INSTALL_FORM_CHECKING_DNS')}</p>}
          </div>
        )}

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
      </>
    );
  };

  const validate = async (values: FormValues) => {
    const exposureMode = values.exposureMode || 'cloudflare';
    const formValues = {
      ...values,
      exposureMode,
      exposedLocal: exposureMode === 'cloudflare', // backward compat
      enableAuth: values.enableAuth ?? true,
      port: values.port || (info.port ? info.port.toString() : undefined),
    };

    // Set default subdomain if not provided and app is exposable
    if (info.exposable && !formValues.localSubdomain) {
      formValues.localSubdomain = info.urn.split(':')[0];
    }

    const validationErrors = validateAppConfig(formValues, formFields);

    // In production, require port when publishing to internet
    if (isProduction && formValues.exposedLocal && info.dynamic_config && !formValues.port) {
      validationErrors.port = { messageKey: 'APP_INSTALL_FORM_ERROR_REQUIRED', params: { label: t('APP_INSTALL_FORM_PORT') } };
    }

    // Check DNS availability synchronously if in production and exposable
    if (isProduction && info.exposable && formValues.exposedLocal && formValues.localSubdomain) {
      if (isCheckingDns) {
        // Wait a bit for DNS check to complete
        await new Promise((resolve) => setTimeout(resolve, 600));
      }

      // If DNS check found an error, prevent submission
      if (dnsAvailabilityError) {
        validationErrors.localSubdomain = {
          messageKey: 'APP_INSTALL_FORM_ERROR_DNS_NOT_AVAILABLE',
          params: { name: formValues.localSubdomain },
        };
      } else if (isProduction) {
        // Perform a final DNS check before submission
        try {
          const query = new URLSearchParams({ subdomain: formValues.localSubdomain });
          const selectedDomain = formValues.exposureMode === 'cloudflare' ? formValues.publicDomain || domain : undefined;
          if (selectedDomain) {
            query.set('domain', selectedDomain);
          }

          const response = await apiFetch(`/api/cloudflare/check-dns-availability?${query.toString()}`, {
            credentials: 'include',
          });

          if (response.ok) {
            const data = await response.json();
            if (!data.available) {
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
    }

    for (const [key, value] of Object.entries(validationErrors)) {
      if (value) {
        setError(key, { message: t(value.messageKey, value.params) });
      }
    }

    if (Object.keys(validationErrors).length === 0) {
      onSubmit(formValues);
    }
  };

  const hasOptionalFields = formFields.some((field) => !field.required && typeFilter(field));
  const hasAdvancedSimpleModeOptions = hasOptionalFields || (info.exposable && info.dynamic_config);
  const shouldShowAdvancedSettingsToggle = !isAdvancedMode && hasAdvancedSimpleModeOptions;
  const visibleFields =
    isAdvancedMode || showAdvancedSettings ? formFields.filter(typeFilter) : formFields.filter((field) => field.required && typeFilter(field));
  const hasConfigSection = visibleFields.length > 0 || shouldShowAdvancedSettingsToggle || (guestDashboard && isAdvancedMode) || isAdvancedMode;

  return (
    <form className="flex flex-col" onSubmit={handleSubmit(validate)} id={formId}>
      {/* Exposure mode selector — always shown when applicable, even in simple mode */}
      {info.exposable && info.dynamic_config && renderExposureModeSelector()}

      {/* Configuration section — scrollable when in a dialog */}
      {hasConfigSection && (
        <ConfigSection scrollable={scrollable}>
          {visibleFields.length > 0 && <h3 className="text-base font-bold tracking-wide text-foreground mb-3">{t('APP_INSTALL_FORM_GENERAL')}</h3>}
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
        </ConfigSection>
      )}
    </form>
  );
};
