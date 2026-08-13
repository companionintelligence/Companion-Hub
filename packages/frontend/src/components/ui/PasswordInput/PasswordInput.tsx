import { useId, useState, type ComponentProps } from 'react';
import { InputGroup } from '../Input';
import { Tooltip } from 'react-tooltip';
import { Button } from '../Button';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

type Props = Omit<ComponentProps<typeof InputGroup>, 'type'>;

export const PasswordInput = ({ className, size = 'default', disabled, ...props }: Props) => {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const tooltipAnchorClass = `toggle-password-visibility-${useId().replaceAll(':', '')}`;

  const { t } = useTranslation();
  const toggleLabel = passwordVisible ? t('APP_INSTALL_FORM_HIDE_PASSWORD') : t('APP_INSTALL_FORM_SHOW_PASSWORD');

  return (
    <InputGroup
      {...props}
      size={size}
      disabled={disabled}
      type={passwordVisible ? 'text' : 'password'}
      // `::-ms-reveal` is Edge's own reveal control, which this toggle replaces.
      className={cn('[&_input::-ms-reveal]:hidden', className)}
      groupSuffix={
        <>
          <Tooltip className="tooltip" anchorSelect={`.${tooltipAnchorClass}`}>
            {toggleLabel}
          </Tooltip>
          <Button
            size="icon"
            variant="outline"
            onClick={() => setPasswordVisible(!passwordVisible)}
            // Keep focus and caret in the input instead of moving them to the button.
            onMouseDown={(e) => e.preventDefault()}
            type="button"
            aria-label={toggleLabel}
            disabled={disabled}
            className={cn(tooltipAnchorClass, 'rounded-l-none border-l-0', size === 'sm' ? 'h-8 w-8' : 'h-11 w-11')}
          >
            {passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
        </>
      }
    />
  );
};
