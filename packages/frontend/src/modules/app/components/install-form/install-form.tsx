import { fetchDnsAvailability, fetchPublicWebDiagnostics } from '@/lib/cloudflare-api';
import type { GetRandomPortResponse } from '@/api-client';
import { getRandomPortMutation, getDomainsOptions } from '@/api-client/@tanstack/react-query.gen';
import { Input } from '@/components/ui/Input';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { Switch } from '@/components/ui/Switch';
import { useAppContext } from '@/context/app-context';
import type { AppInfo, AppStatus, FormField } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Tooltip } from 'react-tooltip';
import { HintMarker } from '@/components/ui/field-hint/field-hint';
import type { AvailableDomain } from '@ci-hub/common/types';
import { buildPublicWebIdentity, sanitizeAppSubdomain } from '@ci-hub/common/types';
import { resolveExposureMode } from '@/modules/onboarding/helpers/agent-onboarding';
import { isMcpOptionalOnlyInstall } from '@ci-hub/common/validation';
import { isInstallFormValid, mergeFormFieldDefaults, validateAppConfig } from './form-validators';
import { HIDDEN_FIELD_TYPES } from '@ci-hub/common/validation';
import { CloudflareSubdomainField } from './cloudflare-subdomain-field';
import { HostnamePreviewCard } from './hostname-preview-card';
import { InstallFormField } from './install-form-field';
import { useDnsAvailability } from './use-dns-availability';

const isHiddenFieldType = (type: FormField['type']) => HIDDEN_FIELD_TYPES.includes(type as (typeof HIDDEN_FIELD_TYPES)[number]);
const typeFilter = (field: FormField) => !isHiddenFieldType(field.type);

interface IProps {
  formFields?: FormField[];
  onSubmit: (values: FormValues) => void;
  initialValues?: { [key: string]: unknown };
  info: AppInfo;
  loading?: boolean;
  formId: string;
  appStatus?: AppStatus;
  onValidityChange?: (isValid: boolean) => void;
  onDirtyChange?: (isDirty: boolean) => void;
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
  onDirtyChange,
  scrollable,
  editingAppUrn,
}) => {
  const { t } = useTranslation();
  const { userSettings, isProduction, user, cloudflareAvailable, tailscaleAvailable, tailscaleNodeFqdn, tailscaleHttpsEnabled } = useAppContext();
  const { guestDashboard, maxBackups: globalMaxBackups, ciHubOrganizationSlug, ciHubDeviceSlug, domain } = userSettings;
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

  const suggestedAppBaseUrl = useMemo(() => {
    if (watchExposureMode === 'cloudflare' && publicWebPreview?.publicUrl) {
      return publicWebPreview.publicUrl.replace(/\/+$/, '');
    }
    if (watchExposureMode === 'tailscale' && tailscalePreviewHost) {
      const scheme = tailscaleHttpsEnabled ? 'https' : 'http';
      return `${scheme}://${tailscalePreviewHost}`.replace(/\/+$/, '');
    }
    if (watchExposureMode === 'local' && localPreviewHost) {
      const host = localPreviewHost.startsWith('http') ? localPreviewHost : `http://${localPreviewHost}`;
      return host.replace(/\/+$/, '');
    }
    return publicWebPreview?.publicUrl?.replace(/\/+$/, '') ?? '';
  }, [watchExposureMode, publicWebPreview, tailscalePreviewHost, tailscaleHttpsEnabled, localPreviewHost]);

  const previewHostname =
    watchExposureMode === 'cloudflare'
      ? publicWebPreview?.hostname || ''
      : watchExposureMode === 'tailscale'
        ? tailscalePreviewHost || `${tailscaleNodeFqdn || 'tailnet'}${watchPort ? `:${watchPort}` : ''}`
        : localPreviewHost;

  const { data: availableDomainsData } = useQuery(getDomainsOptions());
  const availableDomains = useMemo(() => availableDomainsData?.domains ?? EMPTY_AVAILABLE_DOMAINS, [availableDomainsData?.domains]);

  const requiredFieldNames = formFields.filter((f) => f.required && !isHiddenFieldType(f.type)).map((f) => f.env_variable);
  const _watchedRequiredValues = watch(requiredFieldNames);

  // Track the previously-rendered app URN so the init effect can detect when
  // the form is reused for a different app and force-reset stale field values.
  const prevUrnRef = useRef<string | undefined>(undefined);
  const lastAutoPrefilledAppBaseUrl = useRef<Partial<Record<string, string>>>({});
  const [publicWebExpectedUrl, setPublicWebExpectedUrl] = useState<string | null>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(() => isMcpOptionalOnlyInstall(info));

  const mcpOptionalOnly = useMemo(() => isMcpOptionalOnlyInstall(info), [info]);
  const watchedFormValues = watch();

  const checkDnsAvailability = useCallback(
    async (subdomain: string, selectedDomain?: string) => {
      return fetchDnsAvailability(subdomain, {
        domain: selectedDomain,
        appUrn: editingAppUrn,
      }) as Promise<Response>;
    },
    [editingAppUrn],
  );

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

  // Track form validity for parent components — mirrors submit validation (defaults + field rules).
  useEffect(() => {
    if (!onValidityChange) return;

    if (info.exposable && info.dynamic_config && !watchExposureMode) {
      onValidityChange(false);
      return;
    }

    const withDefaults = mergeFormFieldDefaults(watchedFormValues as Record<string, unknown>, formFields);
    const formValues = {
      ...withDefaults,
      exposureMode: watchExposureMode,
      exposedLocal: info.exposable && watchExposureMode === 'cloudflare',
      port: watchPort || (info.port ? info.port.toString() : undefined),
    };

    if (isProduction && info.exposable && formValues.exposedLocal && info.dynamic_config && !formValues.port) {
      onValidityChange(false);
      return;
    }

    onValidityChange(isInstallFormValid(formValues, formFields, { requirePortWhenExposedLocal: isProduction }));
  }, [onValidityChange, info.exposable, info.dynamic_config, info.port, watchExposureMode, watchPort, formFields, watchedFormValues, isProduction]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    // Detect when the form is reused for a different app so we can force-reset
    // stale values (e.g. publicDomain left over from the previous app).
    const appChanged = prevUrnRef.current !== undefined && prevUrnRef.current !== info.urn;
    prevUrnRef.current = info.urn;

    // Whether this pass may (re)seed the form. Untouched forms seed normally. A DIRTY form does
    // not — this effect depends on isDirty, so re-seeding would re-assert defaults over what the
    // operator just typed and make their input bounce back. The exception is `appChanged`: the
    // dialog reuses one form instance across apps, and edits made against the PREVIOUS app are
    // stale by definition, so a switch reseeds as if freshly rendered. Every field in this effect
    // shares the one condition — seeding some (the exposure mode) while skipping others (port,
    // openPort, enableAuth) would leave a switched-to app wearing half of its predecessor's config.
    const shouldSeed = !isDirty || appChanged;

    if (initialValues && shouldSeed) {
      for (const [key, value] of Object.entries(initialValues)) {
        setValue(key, value as string);
      }
    }
    // Seed catalog form_field defaults into RHF so empty installs submit working env values
    // (uncontrolled defaultValue alone is easy to miss on validate/submit).
    if (shouldSeed) {
      for (const field of formFields) {
        if (isHiddenFieldType(field.type)) continue;
        if (field.default === undefined || field.default === null || String(field.default) === '') continue;
        const current = getValues(field.env_variable);
        if (current !== undefined && current !== null && current !== '') continue;
        if (initialValues?.[field.env_variable] !== undefined) continue;
        setValue(field.env_variable, field.default as string | boolean | number);
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
      if (shouldSeed) {
        setValue('exposureMode', defaultMode);
        setValue('exposedLocal', true); // backward compat
      }
      // Defaults, not overrides. These run AFTER initialValues have been applied above, so writing
      // unconditionally discarded the operator's choice — on an EDIT it reverted the stored value,
      // which is what `initialValues?.X === undefined` still guards. `shouldSeed` covers the other
      // half: without it this effect re-asserted the default the moment the form went dirty, so a
      // first attempt to turn auth off, or to set a custom port, appeared to bounce back.
      if (shouldSeed && initialValues?.openPort === undefined) {
        setValue('openPort', defaultMode === 'local');
      }
      if (shouldSeed && initialValues?.enableAuth === undefined) {
        setValue('enableAuth', true);
      }
      if (shouldSeed && info.port && initialValues?.port === undefined) {
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
    formFields,
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
    if (!suggestedAppBaseUrl) return;

    for (const field of formFields) {
      if (field.type !== 'app_base_url') continue;
      if (dirtyFields[field.env_variable]) continue;

      const initialValue = initialValues?.[field.env_variable];
      if (initialValue !== undefined && initialValue !== null && initialValue !== '') continue;

      const envVar = field.env_variable;
      const currentValue = getValues(envVar) as string | undefined;
      const lastPrefilled = lastAutoPrefilledAppBaseUrl.current[envVar];
      if (currentValue && currentValue !== lastPrefilled) continue;

      if (currentValue === suggestedAppBaseUrl) continue;

      setValue(envVar, suggestedAppBaseUrl, { shouldDirty: false });
      lastAutoPrefilledAppBaseUrl.current[envVar] = suggestedAppBaseUrl;
    }
  }, [suggestedAppBaseUrl, formFields, dirtyFields, getValues, setValue, initialValues]);

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
        const data = await fetchPublicWebDiagnostics();
        if (!data) return;
        const entry = data.apps.find((app) => app.appUrn === info.urn);
        if (cancelled) return;
        // `action`, not `envMismatch`: a freshly bound custom domain deliberately
        // leaves the env behind until the restart the user was asked for, and that
        // window reports `envMismatch: true, action: 'ok'`. Warning on it told the
        // operator a healthy app was broken and pointed them at a repair that (now
        // correctly) declines to touch it.
        const needsRepair = entry ? (entry.action ? entry.action === 'repair' : entry.envMismatch) : false;
        setPublicWebExpectedUrl(needsRepair && entry ? entry.computedPublicUrl : null);
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
    const resolvedField =
      field.type === 'app_base_url' && suggestedAppBaseUrl && !field.placeholder ? { ...field, placeholder: suggestedAppBaseUrl } : field;

    return (
      <InstallFormField
        loading={loading}
        initialValue={(initialValues ? initialValues[field.env_variable] : field.default) as string}
        register={register}
        field={resolvedField}
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
        {watchExposureMode === 'tailscale' && tailscaleAvailable && !tailscaleHttpsEnabled && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
            <Trans
              i18nKey="APP_INSTALL_FORM_EXPOSURE_TAILSCALE_HTTPS_DISABLED"
              components={{
                enableLink: (
                  // biome-ignore lint/a11y/useAnchorContent: link text is injected by Trans at runtime
                  <a
                    href="https://login.tailscale.com/admin/dns"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-2"
                  />
                ),
              }}
            />
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
      : (orgSlug ?? domain);

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
                <HintMarker anchorClass="enable-auth-hint" hint={t('APP_INSTALL_FORM_ENABLE_AUTH_HINT')} />
                {info.hub_integration?.edge_auth?.default ? (
                  <span className="ms-2 text-sm text-muted-foreground">{t('APP_INSTALL_FORM_ENABLE_AUTH_RECOMMENDED')}</span>
                ) : null}
              </>
            }
          />
        )}
      />
    );
  };

  const validate = async (values: FormValues) => {
    const exposureMode = resolveExposureMode(values.exposureMode, { cloudflareAvailable, tailscaleAvailable });
    const withFieldDefaults: FormValues = { ...values };
    for (const field of formFields) {
      if (isHiddenFieldType(field.type)) continue;
      if (field.default === undefined || field.default === null || String(field.default) === '') continue;
      const current = withFieldDefaults[field.env_variable];
      if (current === undefined || current === null || current === '') {
        withFieldDefaults[field.env_variable] = field.default;
      }
    }
    const formValues = {
      ...withFieldDefaults,
      exposureMode,
      exposedLocal: info.exposable && exposureMode === 'cloudflare', // backward compat
      enableAuth: withFieldDefaults.enableAuth ?? true,
      port: withFieldDefaults.port || (info.port ? info.port.toString() : undefined),
    };

    // Set default subdomain if not provided and app is exposable
    if (info.exposable && formValues.exposureMode === 'cloudflare' && !formValues.localSubdomain) {
      formValues.localSubdomain = info.urn.split(':')[0];
    }

    const validationErrors = validateAppConfig(formValues, formFields, { requirePortWhenExposedLocal: isProduction });

    // In production, require port when publishing to internet (legacy path when exposedLocal set without port)
    if (isProduction && info.exposable && formValues.exposedLocal && info.dynamic_config && !formValues.port) {
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
      const failingLabels = formFields
        .filter((f) => validationErrors[f.env_variable])
        .map((f) => f.label)
        .join(', ');
      toast.error(
        failingLabels
          ? t('APP_INSTALL_FORM_ERROR_INVALID_FIELDS', { fields: failingLabels, defaultValue: `Fix these fields: ${failingLabels}` })
          : t('APP_INSTALL_FORM_ERROR_INVALID'),
      );
    }
  };

  const onInvalid = () => {
    toast.error(t('APP_INSTALL_FORM_ERROR_INVALID'));
  };

  const hasOptionalFields = formFields.some((field) => !field.required && typeFilter(field));
  const hasAdvancedSimpleModeOptions = hasOptionalFields || (info.exposable && info.dynamic_config);
  const shouldShowAdvancedSettingsToggle = !isAdvancedMode && hasAdvancedSimpleModeOptions && !mcpOptionalOnly;
  const visibleFields =
    isAdvancedMode || showAdvancedSettings || mcpOptionalOnly
      ? formFields.filter(typeFilter)
      : formFields.filter((field) => field.required && typeFilter(field));
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
