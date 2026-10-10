import { LanguageSelector } from '@/components/language-selector/language-selector';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import type { Locale } from '@/lib/i18n/locales';
import { SlidersHorizontal, Sliders, Info, User, Copy } from 'lucide-react';
import clsx from 'clsx';
import type React from 'react';
import { Suspense, lazy, useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { SettingsHint } from '../settings-hint';
import validator from 'validator';
import { z } from 'zod';
import { AdvancedSettingsModal } from '../advanced-settings-modal/advanced-settings-modal';
import './user-settings-form.css';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { THEME_COLOR_ENUM } from '../color-selector/color-selector';
import { THEME_BASE_ENUM, type ThemeBase, ThemeBaseSelector } from '../theme-base-selector/theme-base-selector';
import { TimeZoneSuspense } from '@/components/timezone-selector/timezone.suspense';

const TimeZoneSelector = lazy(() =>
  import('@/components/timezone-selector/timezone-selector').then((module) => ({
    default: module.TimeZoneSelector,
  })),
);

const LOG_LEVEL_ENUM = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
} as const;
type LogLevel = (typeof LOG_LEVEL_ENUM)[keyof typeof LOG_LEVEL_ENUM];

// The Hub fills in `localhost` when no Local domain is set, and browsers resolve `<app>.localhost` to
// this machine. `isFQDN` rejects every name without a dot, so `localhost` is allowed by name.
const isValidLocalDomain = (value: string) => value.toLowerCase() === 'localhost' || validator.isFQDN(value);

const settingsSchema = z.object({
  appsRepoUrl: z.string().optional(),
  localDomain: z.string().optional(),
  guestDashboard: z.boolean().optional(),
  allowAutoThemes: z.boolean().optional(),
  allowErrorMonitoring: z.boolean().optional(),
  defaultAppCpuLimit: z.string().optional(),
  timeZone: z.string().optional(),
  advancedSettings: z.boolean().optional(),
  internalIp: z.ipv4().optional(),
  listenIp: z.ipv4().optional(),
  port: z.number().min(1).max(65535).optional(),
  sslPort: z.number().min(1).max(65535).optional(),
  eventsTimeout: z.coerce.number().int().min(1).optional(),
  maxBackups: z.coerce.number().int().min(0).max(100).optional(),
  persistTraefikConfig: z.boolean().optional(),
  domain: z.string().optional(),
  appDataPath: z.string().optional(),
  forwardAuthUrl: z.url().optional(),
  logLevel: z.enum(LOG_LEVEL_ENUM).optional(),
  themeColor: z.enum(THEME_COLOR_ENUM).optional(),
  themeBase: z.enum(THEME_BASE_ENUM).optional(),
});

export type SettingsFormValues = {
  appsRepoUrl?: string;
  localDomain?: string;
  guestDashboard?: boolean;
  allowAutoThemes?: boolean;
  allowErrorMonitoring?: boolean;
  defaultAppCpuLimit?: string;
  timeZone?: string;
  advancedSettings?: boolean;
  internalIp?: string;
  listenIp?: string;
  port?: number;
  sslPort?: number;
  eventsTimeout?: number;
  maxBackups?: number;
  persistTraefikConfig?: boolean;
  domain?: string;
  appDataPath?: string;
  forwardAuthUrl?: string;
  logLevel?: LogLevel;
  themeColor?: string;
  themeBase?: string;
};

interface IProps {
  currentLocale?: Locale;
  currentBaseTheme?: ThemeBase;
  onSubmit: (values: SettingsFormValues) => void;
  initialValues?: Partial<SettingsFormValues>;
  loading?: boolean;
  submitErrors?: Record<string, string>;
  /** Read-only hub-{device}-{org}.{domain} from app context */
  publicHubHostname?: string;
}

export const UserSettingsForm = (props: IProps) => {
  const { onSubmit, initialValues, loading, currentLocale = 'en-US', submitErrors, publicHubHostname } = props;
  const { t } = useTranslation();
  const advancedSettingsDisclosure = useDisclosure();

  const validateFields = (values: SettingsFormValues) => {
    const errors: { [K in keyof SettingsFormValues]?: string } = {};

    // Check only a Local domain the person changed. The field is read-only until Advanced settings
    // are on, so a value the Hub already had that fails the check would block every save on the page.
    if (values.localDomain && values.localDomain !== initialValues?.localDomain && !isValidLocalDomain(values.localDomain)) {
      errors.localDomain = t('SETTINGS_GENERAL_INVALID_DOMAIN');
    }

    if (values.appsRepoUrl && !validator.isURL(values.appsRepoUrl)) {
      errors.appsRepoUrl = t('SETTINGS_GENERAL_INVALID_URL');
    }

    return errors;
  };

  const {
    register,
    handleSubmit,
    setError,
    control,
    watch,
    formState: { errors, isDirty },
  } = useForm<SettingsFormValues>({ values: initialValues });

  useEffect(() => {
    if (submitErrors) {
      for (const [key, value] of Object.entries(submitErrors)) {
        setError(key as keyof SettingsFormValues, { message: value });
      }
    }
  }, [submitErrors, setError]);

  const validate = (values: SettingsFormValues) => {
    const validationErrors = validateFields(values);

    for (const [key, value] of Object.entries(validationErrors)) {
      if (value) {
        setError(key as keyof SettingsFormValues, { message: value });
      }
    }

    if (Object.keys(validationErrors).length === 0) {
      onSubmit(settingsSchema.parse(values));
    }
  };

  const downloadCertificate = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    window.open('/api/system/certificate');
  };

  const localDomainValue = watch('localDomain') ?? '';

  const copyToClipboard = async (text: string) => {
    const v = text.trim();
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
      toast.success(t('SETTINGS_NETWORK_COPIED'));
    } catch {
      toast.error(t('SETTINGS_GENERAL_COPY_FAILED'));
    }
  };

  const renderFieldCopyButton = (value: string) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="absolute inset-y-0 right-1 size-7 text-muted-foreground hover:text-foreground"
      disabled={!value.trim()}
      onClick={() => void copyToClipboard(value)}
      title={t('SETTINGS_GENERAL_COPY')}
      aria-label={t('SETTINGS_GENERAL_COPY')}
    >
      <Copy className="h-4 w-4" />
    </Button>
  );

  return (
    <div className="space-y-6">
      {isDirty && (
        <Alert variant="info" className="fade-in">
          <AlertIcon>
            <Info strokeWidth={2} />
          </AlertIcon>
          <div>
            <AlertHeading>{t('SETTINGS_GENERAL_SAVE_ALERT_TITLE')}</AlertHeading>
            <AlertDescription>{t('SETTINGS_GENERAL_SAVE_ALERT_SUBTITLE')}</AlertDescription>
          </div>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <User className="h-5 w-5 shrink-0 text-muted-foreground" />
            <CardTitle className="text-xl">{t('SETTINGS_GENERAL_USER_SETTINGS')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <LanguageSelector showLabel locale={currentLocale} />
          <Controller
            control={control}
            name="themeBase"
            render={({ field: { onChange, value } }) => <ThemeBaseSelector value={value as ThemeBase} onChange={onChange} />}
          />
          {/* ColorSelector hidden — theme colors don't apply yet */}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5 shrink-0 text-muted-foreground" />
            <CardTitle className="text-xl">{t('SETTINGS_GENERAL_TITLE')}</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">{t('SETTINGS_GENERAL_SUBTITLE')}</p>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col mt-2" onSubmit={handleSubmit(validate)}>
            <div className="mb-3">
              <Controller
                control={control}
                name="guestDashboard"
                defaultValue={false}
                render={({ field: { onChange, value, ref, ...rest } }) => (
                  <Switch
                    className="mb-3"
                    ref={ref}
                    checked={value}
                    onCheckedChange={onChange}
                    {...rest}
                    label={
                      <>
                        {t('SETTINGS_GENERAL_GUEST_DASHBOARD')}
                        <SettingsHint className="guest-dashboard-hint" hint={t('SETTINGS_GENERAL_GUEST_DASHBOARD_HINT')} />
                      </>
                    }
                  />
                )}
              />
            </div>
            <div className="mb-3">
              <Controller
                control={control}
                name="allowErrorMonitoring"
                defaultValue={false}
                render={({ field: { onChange, value, ref, ...rest } }) => (
                  <Switch
                    className="mb-3"
                    ref={ref}
                    checked={value}
                    onCheckedChange={onChange}
                    {...rest}
                    label={
                      <>
                        {t('SETTINGS_GENERAL_ALLOW_ERROR_MONITORING')}
                        <SettingsHint className="allow-errors-hint" hint={t('SETTINGS_GENERAL_ALLOW_ERROR_MONITORING_HINT')} />
                      </>
                    }
                  />
                )}
              />
            </div>
            <div className="mb-3">
              <Input
                type="number"
                step="0.1"
                min="0.1"
                {...register('defaultAppCpuLimit', {
                  // An emptied field is sent as '', which the Hub reads as "no default". Dropping it
                  // left the saved default in place.
                  setValueAs: (value) => (value === null || value === undefined ? undefined : String(value)),
                })}
                label={t('SETTINGS_GENERAL_DEFAULT_APP_CPU_LIMIT')}
                error={errors.defaultAppCpuLimit?.message}
                placeholder="1.0"
              />
              <span className="text-sm text-muted-foreground">{t('SETTINGS_GENERAL_DEFAULT_APP_CPU_LIMIT_HINT')}</span>
            </div>
            <div className="mb-3">
              <Controller
                control={control}
                name="allowAutoThemes"
                defaultValue={false}
                render={({ field: { onChange, value, ref, ...rest } }) => (
                  <Switch
                    className="mb-3"
                    ref={ref}
                    checked={value}
                    onCheckedChange={onChange}
                    {...rest}
                    label={
                      <>
                        {t('SETTINGS_GENERAL_ALLOW_AUTO_THEMES')}
                        <SettingsHint className="allow-auto-themes-hint" hint={t('SETTINGS_GENERAL_ALLOW_AUTO_THEMES_HINT')} />
                      </>
                    }
                  />
                )}
              />
            </div>
            <div className="mb-3">
              <Controller
                control={control}
                name="advancedSettings"
                defaultValue={false}
                render={({ field: { onChange, value, ref, ...rest } }) => (
                  <div>
                    <AdvancedSettingsModal
                      onEnable={() => {
                        advancedSettingsDisclosure.close();
                        onChange(true);
                      }}
                      advancedSettingsDisclosure={advancedSettingsDisclosure}
                    />
                    <Switch
                      className="mb-3"
                      ref={ref}
                      checked={value}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          advancedSettingsDisclosure.open();
                        } else {
                          onChange(false);
                        }
                      }}
                      {...rest}
                      label={
                        <>
                          {t('SETTINGS_GENERAL_ADVANCED_SETTINGS_TITLE')}
                          <SettingsHint className="advanced-settings-hint" hint={t('SETTINGS_GENERAL_ADVANCED_SETTINGS_SUBTITLE')} />
                        </>
                      }
                    />
                  </div>
                )}
              />
            </div>
            {/* <div className="mb-3">
          <Input
            {...register('appsRepoUrl')}
            label={
              <>
                {t('SETTINGS_GENERAL_APPS_REPO')}
                <SettingsHint className="apps-repo-hint" hint={t('SETTINGS_GENERAL_APPS_REPO_HINT')} />
              </>
            }
            error={errors.appsRepoUrl?.message}
            placeholder="https://github.com/companionintelligence/ci-hub-appstore"
          />
        </div> */}
            <div>
              <Controller
                control={control}
                name="timeZone"
                defaultValue="Etc/GMT"
                render={({ field: { onChange, value } }) => (
                  <Suspense fallback={<TimeZoneSuspense />}>
                    <TimeZoneSelector onChange={onChange} timeZone={value} />
                  </Suspense>
                )}
              />
            </div>
            <div className="mb-3 space-y-4">
              <div className="space-y-2">
                <div className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  <label htmlFor="settings-local-domain" className="inline">
                    {t('SETTINGS_GENERAL_LOCAL_DOMAIN')}
                  </label>
                  <SettingsHint className="local-domain-hint align-middle" hint={t('SETTINGS_GENERAL_LOCAL_DOMAIN_HINT')} />
                </div>
                {/* Copy sits inside the field rather than beside it, so the row keeps the
                    full width of every other control in this card. Input wraps children
                    against the control itself so an error line cannot stretch the overlay. */}
                <Input
                  id="settings-local-domain"
                  {...register('localDomain')}
                  error={errors.localDomain?.message}
                  placeholder={t('SETTINGS_GENERAL_LOCAL_DOMAIN_PLACEHOLDER')}
                  readOnly={initialValues?.advancedSettings === false}
                  className={clsx('[&_input]:pr-9', initialValues?.advancedSettings === false && '[&_input]:cursor-default')}
                >
                  {renderFieldCopyButton(localDomainValue)}
                </Input>
              </div>
              <div className="space-y-2">
                <div className="text-sm font-medium leading-none">
                  <label htmlFor="public-hub-hostname" className="inline">
                    {t('COMMON_PUBLIC_DOMAIN')}
                  </label>
                  <SettingsHint className="public-domain-hint align-middle" hint={t('SETTINGS_GENERAL_PUBLIC_DOMAIN_HINT')} />
                </div>
                <Input
                  id="public-hub-hostname"
                  name="public-hub-hostname"
                  value={publicHubHostname ?? ''}
                  placeholder={t('SETTINGS_GENERAL_PUBLIC_DOMAIN_PENDING')}
                  readOnly
                  className="[&_input]:pr-9 [&_input]:cursor-default"
                  onChange={() => {
                    /* display-only; value is derived from app context */
                  }}
                >
                  {renderFieldCopyButton(publicHubHostname ?? '')}
                </Input>
              </div>
              <Button variant="outline" className="mt-2 mb-2" onClick={downloadCertificate}>
                {t('SETTINGS_GENERAL_DOWNLOAD_CERTIFICATE')}
              </Button>
            </div>
            {initialValues?.advancedSettings && (
              <div>
                <div className="flex items-center mb-2">
                  <Sliders className="mr-2" />
                  <h2 className="text-2xl font-bold">{t('SETTINGS_GENERAL_ADVANCED_SETTINGS_TITLE')}</h2>
                </div>
                <p className="mb-4">{t('SETTINGS_GENERAL_ADVANCED_SETTINGS_SUBTITLE')}</p>
                <div className="mb-3">
                  <Controller
                    control={control}
                    name="persistTraefikConfig"
                    defaultValue={false}
                    render={({ field: { onChange, value, ref, ...rest } }) => (
                      <Switch
                        className="mb-3"
                        ref={ref}
                        checked={value}
                        onCheckedChange={onChange}
                        {...rest}
                        label={
                          <>
                            {t('SETTINGS_GENERAL_PERSIST_TRAEFIK_CONFIG')}
                            <SettingsHint className="persist-traefik-config-hint" hint={t('SETTINGS_GENERAL_PERSIST_TRAEFIK_CONFIG_HINT')} />
                          </>
                        }
                      />
                    )}
                  />
                </div>
                <div className="mb-3">
                  <Input
                    {...register('domain')}
                    label={
                      <>
                        {t('COMMON_DOMAIN_NAME')}
                        <SettingsHint className="domain-hint" hint={t('SETTINGS_GENERAL_DOMAIN_HINT')} />
                      </>
                    }
                    error={errors.domain?.message}
                    placeholder={t('SETTINGS_GENERAL_DOMAIN_PLACEHOLDER')}
                  />
                </div>
                <div className="mb-3">
                  <Input
                    {...register('internalIp')}
                    label={
                      <>
                        {t('SETTINGS_GENERAL_INTERNAL_IP')}
                        <SettingsHint className="internal-ip-hint" hint={t('SETTINGS_GENERAL_INTERNAL_IP_HINT')} />
                      </>
                    }
                    error={errors.internalIp?.message}
                    placeholder="192.168.1.1"
                  />
                </div>
                <div className="mb-3">
                  <Input
                    {...register('listenIp')}
                    label={
                      <>
                        {t('SETTINGS_GENERAL_LISTEN_IP')}
                        <SettingsHint className="listen-ip-hint" hint={t('SETTINGS_GENERAL_LISTEN_IP_HINT')} />
                      </>
                    }
                    error={errors.listenIp?.message}
                    placeholder="0.0.0.0"
                  />
                </div>
                <div className="mb-3">
                  <Input
                    {...register('port', {
                      valueAsNumber: true,
                    })}
                    label={
                      <>
                        {t('COMMON_PORT')}
                        <SettingsHint className="port-hint" hint={t('SETTINGS_GENERAL_PORT_HINT')} />
                      </>
                    }
                    error={errors.port?.message}
                    placeholder="80"
                    type="number"
                    max={65535}
                  />
                </div>
                <div className="mb-3">
                  <Input
                    {...register('sslPort', {
                      valueAsNumber: true,
                    })}
                    label={
                      <>
                        {t('SETTINGS_GENERAL_SSL_PORT')}
                        <SettingsHint className="sslPort-hint" hint={t('SETTINGS_GENERAL_SSL_PORT_HINT')} />
                      </>
                    }
                    error={errors.sslPort?.message}
                    placeholder="443"
                    type="number"
                    max={65535}
                  />
                </div>
                <div className="mb-3">
                  <Input
                    {...register('eventsTimeout', {
                      valueAsNumber: true,
                      required: true,
                    })}
                    label={
                      <>
                        {t('SETTINGS_GENERAL_EVENTS_TIMEOUT')}
                        <SettingsHint className="events-timeout-hint" hint={t('SETTINGS_GENERAL_EVENTS_TIMEOUT_HINT')} />
                      </>
                    }
                    error={errors.eventsTimeout?.message}
                    placeholder="5"
                    type="number"
                  />
                </div>
                <div className="mb-3">
                  <Input
                    {...register('maxBackups', {
                      valueAsNumber: true,
                      required: true,
                    })}
                    label={
                      <>
                        {t('SETTINGS_GENERAL_MAX_BACKUPS')}
                        <SettingsHint className="max-backups-hint" hint={t('SETTINGS_GENERAL_MAX_BACKUPS_HINT')} />
                      </>
                    }
                    error={errors.maxBackups?.message}
                    placeholder="5"
                    type="number"
                    min={0}
                    max={100}
                  />
                </div>
                <div className="mb-3">
                  <Input
                    {...register('appDataPath')}
                    label={
                      <>
                        {t('SETTINGS_GENERAL_APP_DATA_PATH')}
                        <SettingsHint className="app-data-path-hint" hint={t('SETTINGS_GENERAL_APP_DATA_PATH_HINT')} />
                      </>
                    }
                    error={errors.appDataPath?.message}
                    placeholder="/path/to/app/data"
                  />
                </div>
                <div className="mb-3">
                  <Input
                    {...register('forwardAuthUrl')}
                    label={
                      <>
                        {t('SETTINGS_GENERAL_FORWARD_AUTH_URL')}
                        <SettingsHint className="forward-auth-url-hint" hint={t('SETTINGS_GENERAL_FORWARD_AUTH_URL_HINT')} />
                      </>
                    }
                    error={errors.forwardAuthUrl?.message}
                    placeholder={t('SETTINGS_GENERAL_FORWARD_AUTH_URL_PLACEHOLDER')}
                  />
                </div>
                <div className="mb-3">
                  <Controller
                    control={control}
                    name="logLevel"
                    defaultValue="info"
                    render={({ field: { onChange, value } }) => (
                      <Select value={value} defaultValue="info" onValueChange={onChange}>
                        <SelectTrigger className="mb-3" name="logLevel" label={t('SETTINGS_GENERAL_LOG_LEVEL')}>
                          <SelectValue placeholder={t('SETTINGS_GENERAL_LOG_LEVEL')} />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.values(LOG_LEVEL_ENUM).map((level) => (
                            <SelectItem key={level} value={level}>
                              {level}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              </div>
            )}
            <div className="flex justify-center pt-2">
              <Button loading={loading} type="submit" className="px-12">
                {t('SETTINGS_GENERAL_SUBMIT')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
