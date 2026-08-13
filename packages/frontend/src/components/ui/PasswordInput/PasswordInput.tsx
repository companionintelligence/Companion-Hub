import { useId, useState, type ComponentProps } from 'react';
import { InputGroup } from '../Input';
import { Tooltip } from 'react-tooltip';
import { Button } from '../Button';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

// `groupSuffix` joins `type` in the Omit: the toggle occupies that slot, so a caller
// passing one would have it silently dropped.
type Props = Omit<ComponentProps<typeof InputGroup>, 'type' | 'groupSuffix'>;

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
      // Revealing makes this a text input, and browsers exempt only `type="password"`
      // from spellcheck — enhanced spellcheck would ship the revealed value to a
      // third-party service. Keyboard assistance is wrong for a password either way.
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
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
            // `size-*` rather than `h-* w-*` so tailwind-merge actually replaces the
            // `size-8` that Button's icon variant sets, instead of leaving both and
            // letting CSS source order decide the height.
            className={cn(tooltipAnchorClass, 'rounded-l-none border-l-0', size === 'sm' ? 'size-8' : 'size-11')}
          >
            {passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
        </>
      }
    />
  );
};
