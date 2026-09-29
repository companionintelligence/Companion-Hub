import { fetchDnsAvailability, fetchPublicWebDiagnostics, PUBLIC_WEB_DIAGNOSTICS_QUERY_KEY, repairPublicWebRouting } from '@/lib/cloudflare-api';
import type { PublicWebDiagnosticsApp } from '@/lib/cloudflare-api';
import { formatApiError } from '@/lib/format-api-error';
import { portalConfigQueryOptions } from '@/lib/portal-config';
import type { AvailableCustomDomainsResponseDto, GetRandomPortResponse } from '@/api-client';
import { getRandomPortMutation, getDomainsOptions, getCustomDomainsOptions } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useAppContext } from '@/context/app-context';
import type { AppInfo, AppStatus, FormField } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Download, History, Upload } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Tooltip } from 'react-tooltip';
import { HintMarker } from '@/components/ui/field-hint/field-hint';
import type { AvailableDomain } from '@ci-hub/common/types';
import { buildPublicWebIdentity, sanitizeAppSubdomain, selectOfferedDomains } from '@ci-hub/common/types';
import { resolveExposureMode } from '@/modules/onboarding/helpers/agent-onboarding';
import { saveBlobAsFile, splitSavedPath } from '@/lib/save-file';
import { manifestDefaultsEdgeAuthOn } from '@ci-hub/common/schemas';
import { isMcpOptionalOnlyInstall } from '@ci-hub/common/validation';
import {
  type LastUsedInstallConfig,
  installConfigFilename,
  parseInstallConfigJson,
  readLastUsedConfigs,
  recordLastUsedConfig,
  serializeInstallConfig,
} from '@/modules/app/lib/install-config-storage';
import { isInstallFormValid, mergeFormFieldDefaults, validateAppConfig } from './form-validators';
import { HIDDEN_FIELD_TYPES } from '@ci-hub/common/validation';
import { CloudflareSubdomainField } from './cloudflare-subdomain-field';
import { domainListNoteFor } from './domain-list-note';
import { CustomDomainField } from './custom-domain-field';
import { HostnamePreviewCard } from './hostname-preview-card';
import { InstallFormField } from './install-form-field';
import { keepsPublishedDomain, preselectedPublicDomain, publicDomainToUse } from './preselected-public-domain';
import { useDnsAvailability } from './use-dns-availability';

/**
 * The expected URL to warn about, or `null` when this app needs no repair.
 *
 * `action`, not `envMismatch`: a freshly bound custom domain deliberately leaves the
 * env behind until the restart the user was asked for, and that window reports
 * `envMismatch: true, action: 'ok'`. Warning on it told the operator a healthy app was
 * broken and pointed them at a repair that (now correctly) declines to touch it.
 */
const publicWebDriftUrl = (entry?: PublicWebDiagnosticsApp): string | null => {
  if (!entry) return null;
  const needsRepair = entry.action ? entry.action === 'repair' : entry.envMismatch;
  return needsRepair ? entry.computedPublicUrl : null;
};

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
  /** True while the operator has changed a field away from the value the form opened with. */
  onDirtyChange?: (hasEdits: boolean) => void;
  editingAppUrn?: string;
  /**
   * The form edits an app that is already installed (the settings dialog), rather
   * than a new install. Such an app, when served on the Web, already has its public
   * address, so the form never swaps its domain for the one Companion Portal would
   * preselect now. See `preselectedPublicDomain`.
   */
  isEdit?: boolean;
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
  /**
   * A connected custom domain to serve this app on, or `''` for the platform
   * address. Recorded as an intent and wired by Companion Portal after the app registers
   * — never written into the app's env directly.
   */
  customDomain?: string;
  /**
   * The operator confirmed that `customDomain` may be taken off whatever is
   * serving it now. Set only by the picker, and only after it has asked.
   */
  customDomainTakeover?: boolean;
  autoRestartOnDomainChange?: boolean;
  /**
   * What this app was being served on when the dialog was drawn — the
   * compare-and-swap half of `customDomain: ''` (R2-HUBDOMAINS-3).
   *
   * Seeded from the row and never edited, so a release acts on the state the
   * operator was SHOWN: the dialog's `''` is submitted on every save, and a
   * domain bound in the Portal while the dialog sat open would otherwise be
   * released by a save that never mentioned it. The Hub refuses the save when
   * this no longer matches the row.
   */
  customDomainExpected?: string;
  isVisibleOnGuestDashboard?: boolean;
  enableAuth: boolean;
  maxBackups?: number;
  cpuLimit?: string;
  [key: string]: unknown;
};

const EMPTY_AVAILABLE_DOMAINS: AvailableDomain[] = [];
const EMPTY_CUSTOM_DOMAINS: AvailableCustomDomainsResponseDto['domains'] = [];

function buildTailscalePortHost(nodeFqdn?: string | null, port?: number | null): string | null {
  const cleanNodeFqdn = nodeFqdn?.trim();
  if (!cleanNodeFqdn || !port) {
    return null;
  }

  return `${cleanNodeFqdn}:${port}`;
}

/** Compares a form value with its stored one, treating empty as equal and `9000` as `'9000'`. */
const isSameFormValue = (a: unknown, b: unknown) => {
  const isEmpty = (v: unknown) => v === undefined || v === null || v === '';
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
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
  editingAppUrn,
  isEdit = false,
}) => {
  const { t } = useTranslation();
  const { userSettings, isProduction, user, cloudflareAvailable, tailscaleAvailable, tailscaleNodeFqdn, tailscaleHttpsEnabled } = useAppContext();
  const { guestDashboard, maxBackups: globalMaxBackups, ciHubOrganizationSlug, ciHubDeviceSlug, domain } = userSettings;
  const globalCpuLimit = userSettings.defaultAppCpuLimit ?? '';
  const isAdvancedMode = user.advancedMode;

  const orgSlug = ciHubOrganizationSlug ? ciHubOrganizationSlug.toLowerCase().replace(/\s+/g, '-') : undefined;
  const defaultAppSubdomain = info.urn.split(':')[0] ?? info.urn;
  /*
   * The subdomain this app ROUTES on when the Local Subdomain field is empty —
   * which is not `defaultAppSubdomain`, the field's placeholder.
   *
   * ⚠ THE TWO DIFFER, AND ONLY THIS ONE MAY BE COMPARED AGAINST CI-CLOUD.
   * `resolveRoutingSubdomain` on the backend falls back to
   * `<appName>-<appStoreSlug>`, and that is what the bind sends and what comes
   * back as `boundAppSlug`. The placeholder is the bare app name. Comparing the
   * placeholder against CI-Cloud's answer makes every app whose `localSubdomain`
   * is null — an API, MCP or restore install — read as somebody else's: the
   * picker asks the operator to confirm moving the app's own domain away from
   * itself, and drops the hint that says the save will stop serving it.
   */
  const [urnAppName = info.urn, urnAppStoreSlug = ''] = info.urn.split(':');
  const routingAppSubdomain = urnAppStoreSlug ? `${urnAppName}-${urnAppStoreSlug}` : urnAppName;

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
    resetField,
  } = useForm<FormValues>({});
  const _watchExposed = watch('exposed', false);
  const _watchOpenPort = watch('openPort', !info.force_expose);
  const _watchExposedLocal = watch('exposedLocal', false);
  const watchLocalSubdomain = watch('localSubdomain', '');
  const watchExposureMode = watch('exposureMode');
  const watchPort = watch('port', info.port ? info.port.toString() : '');
  const watchPublicDomainRaw = watch('publicDomain');

  const initialExposureMode = typeof initialValues?.exposureMode === 'string' ? initialValues.exposureMode : undefined;
  const keepsPublished = keepsPublishedDomain(isEdit, initialExposureMode);

  const availableDomainsQuery = useQuery(getDomainsOptions());
  const availableDomainsData = availableDomainsQuery.data;
  // An app on the Web keeps its own domain listed even where Companion Portal no longer offers it
  // for a new name (`ci.computer`, a full zone): that is the name it serves from. A new name is
  // offered only what Companion Portal offers.
  const currentPublicSuffix = keepsPublished ? (typeof initialValues?.publicDomain === 'string' ? initialValues.publicDomain : domain) : undefined;
  const availableDomains = useMemo(
    () => selectOfferedDomains(availableDomainsData?.domains ?? EMPTY_AVAILABLE_DOMAINS, currentPublicSuffix),
    [availableDomainsData?.domains, currentPublicSuffix],
  );
  const domainListNote = domainListNoteFor(availableDomainsQuery);
  // What the form shows, checks and saves. `undefined` until Companion Portal's list gives a new
  // name a domain: never the Hub's own as a stand-in. See `publicDomainToUse`.
  const publicDomain = publicDomainToUse({
    chosen: watchPublicDomainRaw,
    hubDomain: domain,
    keepsPublished,
    availableDomains,
    listNote: domainListNote,
  });

  const publicWebPreview = useMemo(() => {
    if (watchExposureMode !== 'cloudflare' || !orgSlug) return null;
    const hubSubdomain = ciHubDeviceSlug ? `hub-${ciHubDeviceSlug}-${orgSlug}` : undefined;
    return buildPublicWebIdentity({
      appSubdomain: watchLocalSubdomain || defaultAppSubdomain,
      hubSubdomain,
      orgSlug,
      // The root only fills out the name while no domain is known; the address built on it is shown
      // and prefilled only once one is (`publicDomain`).
      publicDomainRoot: publicDomain || domain || 'example.com',
    });
  }, [watchExposureMode, orgSlug, watchLocalSubdomain, defaultAppSubdomain, ciHubDeviceSlug, publicDomain, domain]);

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
    if (watchExposureMode === 'cloudflare') {
      return publicDomain && publicWebPreview?.publicUrl ? publicWebPreview.publicUrl.replace(/\/+$/, '') : '';
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
  }, [watchExposureMode, publicDomain, publicWebPreview, tailscalePreviewHost, tailscaleHttpsEnabled, localPreviewHost]);

  const previewHostname =
    watchExposureMode === 'cloudflare'
      ? (publicDomain && publicWebPreview?.hostname) || ''
      : watchExposureMode === 'tailscale'
        ? tailscalePreviewHost || `${tailscaleNodeFqdn || 'tailnet'}${watchPort ? `:${watchPort}` : ''}`
        : localPreviewHost;

  /*
   * The organization's connected custom domains. Read unconditionally rather
   * than only for `exposureMode === 'cloudflare'`: the query is cached across
   * the dialog's lifetime and switching modes must not make the picker appear
   * with a request's worth of delay behind the rest of the section.
   */
  const { data: customDomainsData } = useQuery(getCustomDomainsOptions());
  const customDomains = useMemo(() => customDomainsData?.domains ?? EMPTY_CUSTOM_DOMAINS, [customDomainsData?.domains]);

  /*
   * The auto-restart switch shows only once the picker holds one of the organization's
   * domains, matched the way the picker marks one "no longer available". With no domain
   * in view it asked about nothing, and a domain connected later from the portal still
   * gets the default: a person confirms the restart. An app saved with the switch on
   * keeps it on screen, so a setting in force can always be turned off.
   */
  const savedAutoRestart = initialValues?.autoRestartOnDomainChange === true;
  const watchCustomDomain = watch('customDomain');
  const watchAutoRestart = watch('autoRestartOnDomainChange');
  const offerAutoRestart =
    watchExposureMode === 'cloudflare' &&
    customDomainsData?.supported === true &&
    (customDomains.some((entry) => entry.domain === watchCustomDomain) || savedAutoRestart);

  // A hidden switch never turns the restart on: turning it on and then clearing the
  // domain must not save a choice nobody can see any more.
  useEffect(() => {
    if (!offerAutoRestart && !savedAutoRestart && watchAutoRestart === true) {
      setValue('autoRestartOnDomainChange', false);
    }
  }, [offerAutoRestart, savedAutoRestart, watchAutoRestart, setValue]);

  /*
   * The portal's address, for the picker's link to where a domain another Hub
   * holds can be moved. Read alongside the listing rather than once such a
   * domain shows up, so the link does not arrive a request after its note.
   */
  const { data: portalConfig } = useQuery(portalConfigQueryOptions());

  const requiredFieldNames = formFields.filter((f) => f.required && !isHiddenFieldType(f.type)).map((f) => f.env_variable);
  const _watchedRequiredValues = watch(requiredFieldNames);

  // Track the previously-rendered app URN so the init effect can detect when
  // the form is reused for a different app and force-reset stale field values.
  const prevUrnRef = useRef<string | undefined>(undefined);
  const lastAutoPrefilledAppBaseUrl = useRef<Partial<Record<string, string>>>({});
  const [publicWebExpectedUrl, setPublicWebExpectedUrl] = useState<string | null>(null);
  const [isRepairingPublicWeb, setIsRepairingPublicWeb] = useState(false);
  const queryClient = useQueryClient();
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(() => isMcpOptionalOnlyInstall(info));

  const mcpOptionalOnly = useMemo(() => isMcpOptionalOnlyInstall(info), [info]);
  // What the enable-auth switch shows, and submits, when the form holds no value. A fresh install
  // starts protected. An EDIT shows what the Hub actually serves for a stored form that never
  // decided: the manifest's `hub_integration.edge_auth.default`, else off. The switch used to show
  // `?? true` on an edit while the backend persisted `?? false` and built the route without the
  // login, so an install that never decided looked protected and was not (OpenClaw, 2026-09-28).
  const enableAuthFallback = useMemo(() => (isEdit ? manifestDefaultsEdgeAuthOn(info) : true), [isEdit, info]);
  const watchedFormValues = watch();

  // Client-side install-config export/import + "recently used" list (no backend involved — see
  // packages/frontend/src/modules/app/lib/install-config-storage.ts for the sanitization rules).
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const [recentConfigs, setRecentConfigs] = useState<LastUsedInstallConfig[]>(() => readLastUsedConfigs(info.id));

  useEffect(() => {
    setRecentConfigs(readLastUsedConfigs(info.id));
  }, [info.id]);

  const applyImportedValues = useCallback(
    (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) {
        setValue(key, value as string, { shouldDirty: true, shouldValidate: true });
      }
    },
    [setValue],
  );

  const handleExportConfig = useCallback(async () => {
    const json = serializeInstallConfig(info.id, getValues(), formFields);
    const blob = new Blob([json], { type: 'application/json' });
    try {
      // Only the desktop app reports a path; a browser shows its own download UI.
      const savedPath = await saveBlobAsFile(installConfigFilename(info.id), blob);
      if (savedPath) {
        const { folder, file } = splitSavedPath(savedPath);
        // Sonner wraps a long path inside the card (overflow-wrap: anywhere), and the Toaster
        // keeps the \n, so the file and its folder land on separate lines.
        toast.success(t('APP_INSTALL_FORM_EXPORT_CONFIG_SAVED', { file, folder, defaultValue: 'Saved {{file}}\nto {{folder}}' }));
      }
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('APP_INSTALL_FORM_EXPORT_CONFIG_ERROR', { defaultValue: 'Could not save the install config.' }),
      );
    }
  }, [getValues, formFields, info.id, t]);

  const handleImportButtonClick = useCallback(() => {
    importFileInputRef.current?.click();
  }, []);

  const handleImportFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      let text: string;
      try {
        text = await file.text();
      } catch {
        toast.error(t('APP_INSTALL_FORM_IMPORT_CONFIG_ERROR', { defaultValue: 'Could not read that file.' }));
        return;
      }

      const result = parseInstallConfigJson(text, formFields);
      if (!result.ok) {
        toast.error(t('APP_INSTALL_FORM_IMPORT_CONFIG_ERROR', { defaultValue: 'That file is not a valid install config.' }));
        return;
      }

      applyImportedValues(result.values);

      if (result.unrecognizedKeys.length > 0) {
        toast.error(
          t('APP_INSTALL_FORM_IMPORT_CONFIG_UNRECOGNIZED', {
            defaultValue: `Ignored ${result.unrecognizedKeys.length} field(s) that don't apply to this app: ${result.unrecognizedKeys.join(', ')}`,
            count: result.unrecognizedKeys.length,
            fields: result.unrecognizedKeys.join(', '),
          }),
        );
      } else {
        toast.success(t('APP_INSTALL_FORM_IMPORT_CONFIG_SUCCESS', { defaultValue: 'Config imported.' }));
      }
    },
    [formFields, applyImportedValues, t],
  );

  const handleApplyRecentConfig = useCallback(
    (entry: LastUsedInstallConfig) => {
      applyImportedValues(entry.values);
      toast.success(t('APP_INSTALL_FORM_RECENTLY_USED_APPLIED', { defaultValue: 'Applied recently used config.' }));
    },
    [applyImportedValues, t],
  );

  const checkDnsAvailability = useCallback(
    async (subdomain: string, selectedDomain?: string) => {
      return fetchDnsAvailability(subdomain, {
        domain: selectedDomain,
        appUrn: editingAppUrn,
      });
    },
    [editingAppUrn],
  );

  /**
   * Re-apply the app's Public Web routing without touching its configuration.
   * The drift banner used to point at Save, but nothing on the form is dirty when
   * routing alone is out of sync, so the Update button it named was greyed out and
   * the only remedies left were the CLI or a throwaway config edit (#1208).
   */
  const handleRepairPublicWeb = async () => {
    setIsRepairingPublicWeb(true);
    try {
      /*
       * Re-read the verdict before acting on it. The banner is drawn from a snapshot
       * taken when the dialog opened, and the server repairs a NAMED app on
       * `envMismatch` alone — deliberately overriding the `action: 'ok'` window that a
       * freshly bound custom domain opens. That override is meant for an operator
       * typing the app on a command line; a click on a banner that has since gone stale
       * is not the same intent, and would force the very restart the bind deferred.
       */
      const current = await fetchPublicWebDiagnostics();
      if (!current) {
        toast.error(t('APP_PUBLIC_WEB_REPAIR_ERROR'));
        return;
      }
      // `info.urn`, not `editingAppUrn`: the banner is raised from the diagnostics entry
      // matched on `info.urn`, so targeting anything else could repair a different app
      // than the one the operator is being warned about.
      const stillDrifted = publicWebDriftUrl(current.apps.find((app) => app.appUrn === info.urn));
      if (!stillDrifted) {
        setPublicWebExpectedUrl(null);
        void queryClient.invalidateQueries({ queryKey: PUBLIC_WEB_DIAGNOSTICS_QUERY_KEY });
        toast.success(t('APP_PUBLIC_WEB_REPAIR_ALREADY_SYNCED'));
        return;
      }

      const results = await repairPublicWebRouting(info.urn);
      const outcome = results.find((result) => result.appUrn === info.urn);
      if (outcome && !outcome.success) {
        toast.error(t('APP_PUBLIC_WEB_REPAIR_ERROR'));
        return;
      }
      // No entry at all is NOT a failure: the Hub returns one per app it found drifted,
      // so an empty result means this app is already in sync — someone else repaired it,
      // or the diagnostics the banner was raised from went stale. Reporting that as an
      // error would leave a banner up that is asserting something no longer true. It is
      // not a repair either, though, so it does not get to claim one: nothing was
      // rewritten and nothing restarted.
      setPublicWebExpectedUrl(null);
      // The Public Web report is shared with the dashboard banner and the tile badge
      // under `PUBLIC_WEB_DIAGNOSTICS_QUERY_KEY`. Without this they keep asking for a
      // restart this click already performed, for as long as the dashboard stays open.
      // Only that key: the app's own queries are refreshed by the restart's SSE event.
      void queryClient.invalidateQueries({ queryKey: PUBLIC_WEB_DIAGNOSTICS_QUERY_KEY });
      toast.success(t(outcome ? 'APP_PUBLIC_WEB_REPAIR_SUCCESS' : 'APP_PUBLIC_WEB_REPAIR_ALREADY_SYNCED'));
    } catch (error) {
      // `formatApiError`, not a fixed string: a repair the operator has no grant for
      // comes back as APP_ACTION_GRANT_DENIED, and "check the Hub logs" would send
      // them looking for a fault that is not there.
      toast.error(formatApiError(error, t));
    } finally {
      setIsRepairingPublicWeb(false);
    }
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

  // Only fields the operator changed, and only while they differ from what the form opened with.
  // Not `isDirty`: the form has no defaultValues (the seeding effect fills it with setValue), so
  // react-hook-form compares every loaded value against an empty baseline and reports an untouched
  // settings dialog as edited — its "changes will apply" banner showed on open and Update was never
  // disabled. Derived during render: `dirtyFields` is mutated in place, so an effect keyed on it
  // alone never re-runs.
  const hasEdits = Object.keys(dirtyFields).some((key) => !isSameFormValue(watchedFormValues[key], initialValues?.[key]));

  useEffect(() => {
    onDirtyChange?.(hasEdits);
  }, [hasEdits, onDirtyChange]);

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
      // `HIDDEN_FIELD_TYPES` fields (currently `type: 'random'`, e.g. an app's auto-generated DB
      // password) are never rendered or editable by this form — the defaults loop right below
      // and the field renderer both skip them for that reason. `initialValues` on the Edit
      // Settings flow is the app's live config (`update-settings-dialog.tsx` passes the real
      // env values), so seeding one of these into RHF state would put a live secret into
      // getValues() and therefore into Export config / the "recently used" cache, even though
      // stripSecretFields() strips it again downstream. Skipping it here means it never enters
      // form state at all — see CI-Hub #972.
      const hiddenEnvVars = new Set(formFields.filter((field) => isHiddenFieldType(field.type)).map((field) => field.env_variable));
      for (const [key, value] of Object.entries(initialValues)) {
        if (hiddenEnvVars.has(key)) continue;
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
        setValue('enableAuth', enableAuthFallback);
      }
      if (shouldSeed && info.port && initialValues?.port === undefined) {
        setValue('port', info.port.toString());
      }
      // An app already on the Web serves from the Hub's own domain when it saved none, so the field
      // holds it; otherwise only write it when the field hasn't been customised yet. A new name
      // waits for Companion Portal's list instead (`publicDomainToUse`): the Hub's domain is never
      // its stand-in. Either way, switching apps (appChanged) clears what the previous app left.
      const currentPD = getValues('publicDomain');
      if (!initialValues?.publicDomain) {
        if (keepsPublished) {
          if (domain && (appChanged || !currentPD || currentPD === domain)) {
            setValue('publicDomain', domain);
          }
        } else if (appChanged && currentPD) {
          resetField('publicDomain');
        }
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
    keepsPublished,
    resetField,
    cloudflareAvailable,
    domain,
    tailscaleAvailable,
    enableAuthFallback,
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: info.urn is a deliberate re-run trigger — the dialog reuses one form across apps, and a switch clears the field above.
  useEffect(() => {
    if (watchExposureMode !== 'cloudflare' || availableDomains.length === 0) {
      return;
    }

    // See `preselectedPublicDomain`: a new install takes what Companion Portal
    // preselects; an installed app served on the Web, and a domain the operator
    // picked, never do.
    const next = preselectedPublicDomain({
      availableDomains,
      currentPublicDomain: getValues('publicDomain'),
      hubDomain: domain,
      dirty: Boolean(dirtyFields.publicDomain),
      isEdit,
      initialExposureMode,
    });

    if (next) {
      setValue('publicDomain', next);
    }
  }, [availableDomains, dirtyFields.publicDomain, domain, getValues, initialExposureMode, isEdit, setValue, watchExposureMode, info.urn]);

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
        setPublicWebExpectedUrl(publicWebDriftUrl(entry));
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

  const { isCheckingDns, dnsAvailabilityError, domainAvailabilityError } = useDnsAvailability({
    // Only once there is a domain to ask about: none while Companion Portal's list is on its way.
    enabled: info.exposable && isProduction && watchExposureMode === 'cloudflare' && Boolean(publicDomain),
    subdomain: watchLocalSubdomain || defaultAppSubdomain,
    selectedDomain: publicDomain,
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
                        'flex h-full w-full items-center justify-center rounded-md border px-3 py-2 text-sm font-medium transition-colors',
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
          <p className="mt-2 text-xs text-warning">
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
          <div
            className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning"
            data-testid="public-web-drift-banner"
          >
            <p className="mb-2">{t('APP_PUBLIC_WEB_DRIFT_HINT', { url: publicWebExpectedUrl })}</p>
            {/* `type="button"`: this sits inside the config form, and a bare button
                would submit it — the one thing the drifted app does not need. */}
            <Button
              type="button"
              size="sm"
              intent="warning"
              loading={isRepairingPublicWeb}
              onClick={handleRepairPublicWeb}
              data-testid="public-web-repair-button"
            >
              {t('APP_PUBLIC_WEB_REPAIR_ACTION')}
            </Button>
          </div>
        )}
        {watchExposureMode === 'cloudflare' ? (
          <CloudflareSubdomainField
            control={control}
            availableDomains={availableDomains}
            shownDomain={publicDomain}
            cloudflareSuffix={cloudflareSuffix}
            register={register}
            loading={loading}
            localSubdomainError={errors.localSubdomain?.message || dnsAvailabilityError || undefined}
            publicDomainError={errors.publicDomain?.message || domainAvailabilityError || undefined}
            placeholder={defaultAppSubdomain}
            isCheckingDns={isCheckingDns}
            domainListNote={domainListNote}
            onRetryDomainList={() => void availableDomainsQuery.refetch()}
            t={t}
          />
        ) : null}
        {/*
         * Directly under the subdomain that composes it, and ABOVE the custom
         * domain picker. This card shows the PLATFORM hostname — the address the
         * subdomain field builds — so sitting below the picker read as though it
         * were previewing the chosen custom domain, which it never is.
         */}
        <HostnamePreviewCard hostname={previewHostname} onCopy={copyToClipboard} title={t('COMMON_HOSTNAME')} />
        {/*
         * Only under Cloudflare exposure. A custom domain is delivered by cloning
         * this app's tunnel ingress rule, so an app that publishes no public
         * route has nothing for one to alias — offering the choice there would be
         * offering something that cannot be honoured.
         */}
        {watchExposureMode === 'cloudflare' ? (
          <CustomDomainField
            control={control}
            domains={customDomains}
            supported={customDomainsData?.supported === true}
            platformHostname={publicWebPreview?.hostname}
            /*
             * The same value the bind sends as `appSlug`, so a domain already
             * serving THIS app is recognised instead of warned about.
             *
             * ⚠ TRIMMED, because the value being compared against is. CI-Cloud's
             * `boundAppSlug` mirrors the subdomain the Hub SYNCS, which is
             * trimmed on the way out; the raw field value is not. While somebody
             * is typing in the Local Subdomain box, an untrimmed value stops
             * matching and the app's own domain briefly reads as another app's —
             * warning about a move that is not one, and dropping the
             * irreversible-release hint for a domain that is still being served.
             */
            currentAppSlug={watchLocalSubdomain?.trim() || routingAppSubdomain}
            portalUrl={portalConfig?.portalUrl}
            onTakeoverChange={(confirmed) => setValue('customDomainTakeover', confirmed)}
            loading={loading}
            t={t}
          />
        ) : null}
        {/*
         * Beside the picker because it answers the question the picker raises: when a
         * domain is connected, who chooses the moment the app restarts to pick it up.
         * OFF by default — the restart makes the app briefly unavailable, so a person
         * confirms it. `offerAutoRestart` says when it is asked at all.
         */}
        {offerAutoRestart ? (
          <Controller
            control={control}
            name="autoRestartOnDomainChange"
            defaultValue={false}
            render={({ field: { onChange, value, ref, ...props } }) => (
              <Switch
                {...props}
                className="mb-3"
                ref={ref}
                checked={value ?? false}
                onCheckedChange={onChange}
                label={
                  <>
                    {t('APP_INSTALL_FORM_AUTO_RESTART_ON_DOMAIN_CHANGE')}
                    <HintMarker anchorClass="auto-restart-domain-hint" hint={t('APP_INSTALL_FORM_AUTO_RESTART_ON_DOMAIN_CHANGE_HINT')} />
                  </>
                }
              />
            )}
          />
        ) : null}
      </>
    );
  };

  const renderAdvancedExposureOptions = () => {
    if (!info.exposable || (!isAdvancedMode && !showAdvancedSettings)) return null;

    return (
      <Controller
        control={control}
        name="enableAuth"
        defaultValue={enableAuthFallback}
        render={({ field: { onChange, value, ref, ...props } }) => (
          <Switch
            {...props}
            className="mb-3"
            ref={ref}
            checked={value ?? enableAuthFallback}
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
      enableAuth: withFieldDefaults.enableAuth ?? enableAuthFallback,
      port: withFieldDefaults.port || (info.port ? info.port.toString() : undefined),
    };

    // Set default subdomain if not provided and app is exposable
    if (info.exposable && formValues.exposureMode === 'cloudflare' && !formValues.localSubdomain) {
      formValues.localSubdomain = info.urn.split(':')[0];
    }

    // The domain the form shows. None while Companion Portal's list has not given one: the app then
    // names none, and Companion Portal places it, as it does any app that names none.
    if (formValues.exposureMode === 'cloudflare') {
      formValues.publicDomain = publicDomain;
    }

    const validationErrors = validateAppConfig(formValues, formFields, { requirePortWhenExposedLocal: isProduction });

    // In production, require port when publishing to internet (legacy path when exposedLocal set without port)
    if (isProduction && info.exposable && formValues.exposedLocal && info.dynamic_config && !formValues.port) {
      validationErrors.port = { messageKey: 'APP_INSTALL_FORM_ERROR_REQUIRED', params: { label: t('COMMON_PORT') } };
    }

    // Check DNS availability synchronously if in production and exposable
    if (
      isProduction &&
      info.exposable &&
      formValues.exposureMode === 'cloudflare' &&
      formValues.exposedLocal &&
      formValues.localSubdomain &&
      formValues.publicDomain
    ) {
      if (isCheckingDns) {
        // Wait a bit for DNS check to complete
        await new Promise((resolve) => setTimeout(resolve, 600));
      }

      // If DNS check found an error, prevent submission
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
      // Perform a final DNS check before submission
      try {
        const response = await checkDnsAvailability(formValues.localSubdomain, formValues.publicDomain);

        if (response.ok) {
          const data = await response.json();
          if (!data.available) {
            if (data.reason === 'zone_unreachable') {
              const message = typeof data.message === 'string' && data.message ? data.message : t('APP_INSTALL_FORM_ERROR_DOMAIN_UNAVAILABLE');
              setError('publicDomain', { message });
              toast.error(message);
              return;
            }

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
      // Client-side "recently used" cache — mirrors community-scripts.org/generator's "Last used"
      // list. Recorded at submission time (not after a backend round-trip), same as its export/copy
      // actions. Secrets are stripped inside recordLastUsedConfig before anything touches storage.
      setRecentConfigs(recordLastUsedConfig(info.id, formValues, formFields));
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
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {recentConfigs.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <History className="me-1.5 size-3.5" />
                {t('APP_INSTALL_FORM_RECENTLY_USED', { defaultValue: 'Recently used' })}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>{t('APP_INSTALL_FORM_RECENTLY_USED', { defaultValue: 'Recently used' })}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {recentConfigs.map((entry) => (
                <DropdownMenuItem key={entry.id} onSelect={() => handleApplyRecentConfig(entry)}>
                  {new Date(entry.savedAt).toLocaleString()}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <input ref={importFileInputRef} type="file" accept="application/json" className="hidden" onChange={handleImportFileChange} />
          <Button type="button" variant="outline" size="sm" onClick={handleImportButtonClick}>
            <Upload className="me-1.5 size-3.5" />
            {t('APP_INSTALL_FORM_IMPORT_CONFIG', { defaultValue: 'Import config' })}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={handleExportConfig}>
            <Download className="me-1.5 size-3.5" />
            {t('APP_INSTALL_FORM_EXPORT_CONFIG', { defaultValue: 'Export config' })}
          </Button>
        </div>
      </div>

      {/* Exposure mode selector — always shown when applicable, even in simple mode */}
      {info.exposable && info.dynamic_config && renderExposureModeSelector()}
      {renderHostnameSettings()}

      {/* Configuration section. No scroll container of its own: both dialogs that host this form
          already scroll their body, and a nested fixed-height one showed a second scrollbar. */}
      {hasConfigSection && (
        <div>
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
        </div>
      )}
    </form>
  );
};
