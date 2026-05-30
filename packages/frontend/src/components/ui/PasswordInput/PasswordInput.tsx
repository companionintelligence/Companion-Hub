import { useId, useState, type ComponentProps } from 'react';
import { InputGroup } from '../Input';
import { Tooltip } from 'react-tooltip';
import { Button } from '../Button';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Props = ComponentProps<typeof InputGroup> & {};

export const PasswordInput = (props: Props) => {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const tooltipAnchorClass = `toggle-password-visibility-${useId().replaceAll(':', '')}`;

  const { t } = useTranslation();
  const toggleLabel = passwordVisible ? t('APP_INSTALL_FORM_HIDE_PASSWORD') : t('APP_INSTALL_FORM_SHOW_PASSWORD');

  return (
    <InputGroup
      type={passwordVisible ? 'text' : 'password'}
      {...props}
      groupSuffix={
        <>
          <Tooltip className="tooltip" anchorSelect={`.${tooltipAnchorClass}`}>
            {toggleLabel}
          </Tooltip>
          <Button
            size="icon"
            variant="outline"
            onClick={() => setPasswordVisible(!passwordVisible)}
            type="button"
            aria-label={toggleLabel}
            className={`${tooltipAnchorClass} rounded-l-none border-l-0 h-11 w-11`}
          >
            {passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
        </>
      }
    />
  );
};
