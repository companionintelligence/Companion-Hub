import { updateUserSettingsMutation, updateAdvancedModeMutation } from '@/api-client/@tanstack/react-query.gen';
import { useAppContext } from '@/context/app-context';
import type { Locale } from '@/lib/i18n/locales';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import i18next from 'i18next';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { type SettingsFormValues, UserSettingsForm } from '../components/user-settings-form/user-settings-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { Tooltip } from 'react-tooltip';

type Props = {
  initialValues?: SettingsFormValues;
};

export const UserSettingsContainer = ({ initialValues }: Props) => {
  const currentLocale = i18next.language;
  const { t } = useTranslation();
  const { refreshAppContext, user } = useAppContext();
  const [requireRestart, setRequireRestart] = useState(initialValues?.advancedSettings);

  const updateSettings = useMutation({
    ...updateUserSettingsMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: () => {
      toast.success(requireRestart ? t('SETTINGS_GENERAL_SETTINGS_UPDATED_RESTART') : t('SETTINGS_GENERAL_SETTINGS_UPDATED'));
      refreshAppContext();
    },
  });

  const updateAdvancedMode = useMutation({
    ...updateAdvancedModeMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: () => {
      toast.success(t('SETTINGS_GENERAL_SETTINGS_UPDATED'));
      refreshAppContext();
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
    updateAdvancedMode.mutate({ body: { advancedMode: checked } });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-xl">{t('SETTINGS_GENERAL_ADVANCED_MODE_TITLE')}</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">{t('SETTINGS_GENERAL_ADVANCED_MODE_SUBTITLE')}</p>
        </CardHeader>
        <CardContent>
          <Switch
            checked={user.advancedMode}
            onCheckedChange={onAdvancedModeChange}
            label={
              <>
                {t('SETTINGS_GENERAL_ADVANCED_MODE_TOGGLE')}
                <Tooltip className="tooltip" anchorSelect=".advanced-mode-hint">
                  {t('SETTINGS_GENERAL_ADVANCED_MODE_HINT')}
                </Tooltip>
                <span
                  className={clsx(
                    'ml-1 inline-flex items-center justify-center size-4 text-xs rounded-full border border-muted-foreground/40 text-muted-foreground cursor-help advanced-mode-hint',
                  )}
                >
                  ?
                </span>
              </>
            }
          />
        </CardContent>
      </Card>
      <UserSettingsForm initialValues={initialValues} currentLocale={currentLocale as Locale} onSubmit={onSubmit} />
    </div>
  );
};
