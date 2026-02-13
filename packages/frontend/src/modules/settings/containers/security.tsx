import { Key, Lock, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CardContent } from '@/components/ui/Card';
import { ChangePasswordForm } from '../components/change-password-form/change-password-form';
import { ChangeUsernameForm } from '../components/change-username-form/change-username-form';
import { OtpForm } from '../components/otp-form/otp-form';

export const SecurityContainer = (props: { totpEnabled: boolean; username?: string }) => {
  const { totpEnabled, username } = props;
  const { t } = useTranslation();

  return (
    <CardContent>
      <div className="flex mb-2">
        <User className="me-2" />
        <h2 className="mb-0">{t('SETTINGS_SECURITY_CHANGE_USERNAME_TITLE')}</h2>
      </div>
      <p className="text-muted">{t('SETTINGS_SECURITY_CHANGE_USERNAME_SUBTITLE')}</p>
      <ChangeUsernameForm username={username} />
      <div className="d-flex mb-2">
        <Key className="me-2" />
        <h2 className="mb-0">{t('SETTINGS_SECURITY_CHANGE_PASSWORD_TITLE')}</h2>
      </div>
      <p className="text-muted">{t('SETTINGS_SECURITY_CHANGE_PASSWORD_SUBTITLE')}</p>
      <ChangePasswordForm />
      <div className="d-flex mb-2">
        <Lock className="me-2" />
        <h2 className="mb-0">{t('SETTINGS_SECURITY_2FA_TITLE')}</h2>
      </div>
      <p className="text-muted">
        {t('SETTINGS_SECURITY_2FA_SUBTITLE')}
        <br />
        {t('SETTINGS_SECURITY_2FA_SUBTITLE_2')}
      </p>
      <OtpForm totpEnabled={totpEnabled} />
    </CardContent>
  );
};
