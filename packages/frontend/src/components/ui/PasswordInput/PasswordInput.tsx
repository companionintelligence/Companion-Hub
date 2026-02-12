import { useState, type ComponentProps } from 'react';
import { InputGroup } from '../Input';
import { Tooltip } from 'react-tooltip';
import { Button } from '../Button';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Props = ComponentProps<typeof InputGroup> & {};

export const PasswordInput = (props: Props) => {
  const [passwordVisible, setPasswordVisible] = useState(false);

  const { t } = useTranslation();

  return (
    <InputGroup
      type={passwordVisible ? 'text' : 'password'}
      {...props}
      groupSuffix={
        <>
          <Tooltip className="tooltip" anchorSelect=".toggle-password-visibility">
            {passwordVisible ? t('APP_INSTALL_FORM_HIDE_PASSWORD') : t('APP_INSTALL_FORM_SHOW_PASSWORD')}
          </Tooltip>
          <Button
            size="icon"
            variant="outline"
            onClick={() => setPasswordVisible(!passwordVisible)}
            type="button"
            className="toggle-password-visibility rounded-l-none border-l-0 h-9 w-9"
          >
            {passwordVisible ? (
              <EyeOff aria-label={t('APP_INSTALL_FORM_HIDE_PASSWORD')} size={16} />
            ) : (
              <Eye aria-label={t('APP_INSTALL_FORM_SHOW_PASSWORD')} size={16} />
            )}
          </Button>
        </>
      }
    />
  );
};
