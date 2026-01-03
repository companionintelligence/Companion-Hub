import type { GetRandomPortResponse } from '@/api-client';
import { getRandomPortMutation } from '@/api-client/@tanstack/react-query.gen';
import { Input, InputGroup } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useAppContext } from '@/context/app-context';
import type { AppInfo, FormField } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
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
}

export type FormValues = {
  port?: string;
  exposed: boolean;
  exposedLocal: boolean;
  openPort: boolean;
  domain?: string;
  localSubdomain?: string;
  isVisibleOnGuestDashboard?: boolean;
  enableAuth: boolean;
  maxBackups?: number;
  [key: string]: unknown;
};

const typeFilter = (field: FormField) => !hiddenTypes.includes(field.type);

export const InstallForm: React.FC<IProps> = ({ formFields = [], info, onSubmit, initialValues, loading, formId }) => {
  const { t } = useTranslation();
  const { userSettings, isProduction } = useAppContext();
  const { guestDashboard, localDomain, maxBackups: globalMaxBackups } = userSettings;

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
    setValue,
    watch,
    setError,
    control,
  } = useForm<FormValues>({});
  const _watchExposed = watch('exposed', false);
  const _watchOpenPort = watch('openPort', !info.force_expose);
  const _watchExposedLocal = watch('exposedLocal', false);
  const watchLocalSubdomain = watch('localSubdomain', '');

  const dnsCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isCheckingDns, setIsCheckingDns] = useState(false);
  const [dnsAvailabilityError, setDnsAvailabilityError] = useState<string | null>(null);

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
    // Always set exposedLocal to true and use recommended port
    // openPort is always false since we route through Traefik
    if (info.exposable && info.dynamic_config) {
      setValue('exposedLocal', true);
      setValue('openPort', false); // Always false - apps route through Traefik
      setValue('enableAuth', true); // Enable authentication by default
      if (info.port) {
        setValue('port', info.port.toString());
      }
      // Set default subdomain if not provided
      const defaultSubdomain = info.urn.split(':').join('-');
      if (!watchLocalSubdomain) {
        setValue('localSubdomain', defaultSubdomain);
      }
    }
  }, [initialValues, isDirty, setValue, info.force_expose, info.exposable, info.dynamic_config, info.port, watchLocalSubdomain, info.urn.split]);

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
    const subdomainToCheck = watchLocalSubdomain || info.urn.split(':').join('-');

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
        const response = await fetch(`/api/cloudflare/check-dns-availability?subdomain=${encodeURIComponent(subdomainToCheck)}`, {
          credentials: 'include',
        });

        if (response.ok) {
          const data = await response.json();
          if (data.available) {
            // Clear error if DNS is available
            setDnsAvailabilityError(null);
            setError('localSubdomain', {});
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
  }, [watchLocalSubdomain, info.exposable, info.urn, isProduction, setError, t]);

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

  const renderDynamicConfigProxyForm = () => {
    return (
      <>
        {info.exposable && (
          <>
            {/* Hide "Publish to internet" switch - always set to true */}
            {/* Always set exposedLocal to true and use recommended port */}
            {/* Hide port input - always use recommended port (info.port) */}
            {/* Always show subdomain input as if "Publish to internet" is enabled */}
            <div className="mb-3">
              <InputGroup
                groupPrefix="https://"
                groupSuffix={`.${localDomain}${isCheckingDns ? ' (checking...)' : ''}`}
                {...register('localSubdomain')}
                label={t('APP_INSTALL_FORM_LOCAL_SUBDOMAIN')}
                error={errors.localSubdomain?.message || dnsAvailabilityError || undefined}
                disabled={loading || isCheckingDns}
                placeholder={info.urn.split(':').join('-')}
              />
            </div>
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
        )}
      </>
    );
  };

  const validate = async (values: FormValues) => {
    // Always set exposedLocal to true and use recommended port
    // Enable authentication by default
    const formValues = {
      ...values,
      exposedLocal: true,
      enableAuth: values.enableAuth ?? true,
      port: values.port || (info.port ? info.port.toString() : undefined),
    };

    // Set default subdomain if not provided and app is exposable
    if (info.exposable && !formValues.localSubdomain) {
      formValues.localSubdomain = info.urn.split(':').join('-');
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
          const response = await fetch(`/api/cloudflare/check-dns-availability?subdomain=${encodeURIComponent(formValues.localSubdomain)}`, {
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

  return (
    <form className="flex flex-col" onSubmit={handleSubmit(validate)} id={formId}>
      {(guestDashboard || formFields.filter(typeFilter).length !== 0) && <h3>{t('APP_INSTALL_FORM_GENERAL')}</h3>}
      {formFields.filter(typeFilter).map(renderField)}
      {guestDashboard && (
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
      {/* Port section hidden - always use default port and route through Traefik */}
      {info.exposable && (
        <>
          {info.dynamic_config && (
            <>
              <h3>{t('APP_INSTALL_FORM_REVERSE_PROXY')}</h3>
              {renderDynamicConfigProxyForm()}
            </>
          )}
          {renderExposeForm()}
        </>
      )}
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
        <span className="text-muted">{t('APP_INSTALL_FORM_MAX_BACKUPS_HINT', { value: globalMaxBackups })}</span>
      </div>
    </form>
  );
};
