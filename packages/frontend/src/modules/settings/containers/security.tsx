import { Key, Lock, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { ChangePasswordForm } from '../components/change-password-form/change-password-form';
import { ChangeUsernameForm } from '../components/change-username-form/change-username-form';
import { OtpForm } from '../components/otp-form/otp-form';

export const SecurityContainer = (props: { totpEnabled: boolean; username?: string }) => {
  const { totpEnabled, username } = props;
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <User className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-xl">{t('SETTINGS_SECURITY_CHANGE_USERNAME_TITLE')}</CardTitle>
          </div>
          <CardDescription>{t('SETTINGS_SECURITY_CHANGE_USERNAME_SUBTITLE')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangeUsernameForm username={username} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Key className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-xl">{t('SETTINGS_SECURITY_CHANGE_PASSWORD_TITLE')}</CardTitle>
          </div>
          <CardDescription>{t('SETTINGS_SECURITY_CHANGE_PASSWORD_SUBTITLE')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-xl">{t('SETTINGS_SECURITY_2FA_TITLE')}</CardTitle>
          </div>
          <CardDescription>
            {t('SETTINGS_SECURITY_2FA_SUBTITLE')}
            <br />
            {t('SETTINGS_SECURITY_2FA_SUBTITLE_2')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OtpForm totpEnabled={totpEnabled} />
        </CardContent>
      </Card>
    </div>
  );
};
