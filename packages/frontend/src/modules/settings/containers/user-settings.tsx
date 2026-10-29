import { updateUserSettingsMutation, updateAdvancedModeMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { openExternal } from '@/lib/helpers/open-external';
import { portalAccountSettingsUrl } from '@/lib/hub-removal-watch';
import type { Locale } from '@/lib/i18n/locales';
import { portalConfigQueryOptions } from '@/lib/portal-config';
import { refreshTelemetryConsent } from '@/lib/telemetry-consent';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQuery } from '@tanstack/react-query';
import i18next from 'i18next';
import { ExternalLink, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { type SettingsFormValues, UserSettingsForm } from '../components/user-settings-form/user-settings-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { SettingsHint } from '../components/settings-hint';

type Props = {
  initialValues?: SettingsFormValues;
  /** hub-{device}-{org}.{domain} from registration + settings; display-only */
  publicHubHostname?: string;
  /** Whether this person may change the Hub's settings; a member keeps only their own (`useHubAccess`). */
  manageHub?: boolean;
};

export const UserSettingsContainer = ({ initialValues, publicHubHostname, manageHub = true }: Props) => {
  const currentLocale = i18next.language;
  const { t } = useTranslation();
  const { refreshAppContext, user } = useAppContext();
  const { data: portalConfig } = useQuery(portalConfigQueryOptions());
  const [requireRestart, setRequireRestart] = useState(initialValues?.advancedSettings);
  const [advancedModeDraft, setAdvancedModeDraft] = useState<boolean | null>(null);

  const updateSettings = useMutation({
    ...updateUserSettingsMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: () => {
      toast.success(requireRestart ? t('SETTINGS_GENERAL_SETTINGS_UPDATED_RESTART') : t('SETTINGS_GENERAL_SETTINGS_UPDATED'));
      refreshAppContext();
      // "Allow error monitoring" lives in this form. Re-ask the Hub straight
      // away so a flip takes effect on the next captured error rather than at
      // the next staleness refresh.
      void refreshTelemetryConsent();
    },
  });

  const updateAdvancedMode = useMutation({
    ...updateAdvancedModeMutation(),
    onError: (e: TranslatableError) => {
      setAdvancedModeDraft(null);
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: async () => {
      toast.success(t('SETTINGS_GENERAL_SETTINGS_UPDATED'));
      await refreshAppContext();
      setAdvancedModeDraft(null);
    },
  });

  const onSubmit = (values: SettingsFormValues) => {
    if (values.advancedSettings) {
      setRequireRestart(true);
    } else {
      setRequireRestart(false);
    }
    updateSettings.mutate({ body: { ...values } });
  };

  const onAdvancedModeChange = (checked: boolean) => {
    setAdvancedModeDraft(checked);
    updateAdvancedMode.mutate({ body: { advancedMode: checked } });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 shrink-0 text-muted-foreground" />
            <CardTitle className="text-xl">{t('SETTINGS_GENERAL_ADVANCED_MODE_TITLE')}</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">{t('SETTINGS_GENERAL_ADVANCED_MODE_SUBTITLE')}</p>
        </CardHeader>
        <CardContent>
          <Switch
            checked={advancedModeDraft ?? Boolean(user.advancedMode)}
            disabled={updateAdvancedMode.isPending}
            onCheckedChange={onAdvancedModeChange}
            label={
              <>
                {t('SETTINGS_GENERAL_ADVANCED_MODE_TOGGLE')}
                <SettingsHint className="advanced-mode-hint" hint={t('SETTINGS_GENERAL_ADVANCED_MODE_HINT')} />
              </>
            }
          />
        </CardContent>
      </Card>
      <UserSettingsForm
        initialValues={initialValues}
        currentLocale={currentLocale as Locale}
        onSubmit={onSubmit}
        loading={updateSettings.isPending}
        publicHubHostname={publicHubHostname}
        manageHub={manageHub}
      />

      <Card data-testid="companion-account-settings">
        <CardHeader>
          <CardTitle className="text-xl">{t('SETTINGS_COMPANION_ACCOUNT_TITLE')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('SETTINGS_COMPANION_ACCOUNT_DESC')}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => void openExternal(portalAccountSettingsUrl(portalConfig?.portalUrl))}
          >
            {t('SETTINGS_COMPANION_ACCOUNT_OPEN')}
            <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
          <button
            type="button"
            className="text-left text-sm text-primary underline-offset-2 hover:underline sm:text-right"
            onClick={() => void openExternal('https://ci.computer/privacy-policy')}
          >
            {t('SETTINGS_COMPANION_ACCOUNT_PRIVACY')}
          </button>
        </CardContent>
      </Card>
    </div>
  );
};
