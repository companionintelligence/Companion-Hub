import { useId, useState, type ComponentProps } from 'react';
import { InputGroup } from '../Input';
import { Tooltip } from 'react-tooltip';
import { Button } from '../Button';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

// Everything this component pins after the prop spread is omitted rather than accepted
// and ignored. `children` is omitted for a harder reason: InputGroup forwards it onto
// the void `<input>`, which throws at render.
type Props = Omit<ComponentProps<typeof InputGroup>, 'type' | 'groupSuffix' | 'spellCheck' | 'autoCapitalize' | 'autoCorrect' | 'children'>;

export const PasswordInput = ({ className, ...props }: Props) => {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const tooltipAnchorClass = `toggle-password-visibility-${useId().replaceAll(':', '')}`;

  const { t } = useTranslation();
  const toggleLabel = passwordVisible ? t('APP_INSTALL_FORM_HIDE_PASSWORD') : t('APP_INSTALL_FORM_SHOW_PASSWORD');
  // The change-password form stacks three of these, so on its own the toggle label reads
  // identically three times over. Name each one after the field it sits in. Taken from
  // whichever of the two is present rather than a new prop: both are already translated
  // at the call site and cannot drift from what the user sees.
  const fieldName = typeof props.label === 'string' ? props.label : props.placeholder;
  const toggleName = fieldName ? `${toggleLabel}: ${fieldName}` : toggleLabel;

  return (
    <InputGroup
      {...props}
      type={passwordVisible ? 'text' : 'password'}
      // Revealing makes this a text input, and browsers exempt only `type="password"`
      // from spellcheck — enhanced spellcheck would ship the revealed value to a
      // third-party service.
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
            aria-label={toggleName}
            // Names the relationship the label alone cannot: which field this unmasks.
            aria-controls={props.id || props.name}
            disabled={props.disabled}
            className={cn(
              tooltipAnchorClass,
              'rounded-l-none border-l-0',
              // `size-*` rather than `h-*`/`w-*` so tailwind-merge replaces the `size-8`
              // that Button's icon variant sets instead of leaving both.
              props.size === 'sm' ? 'size-8' : 'size-11',
              // The toggle butts against the input, so it has to carry the error border
              // too or the joined control ends up half red.
              (props.error || props.isInvalid) && 'border-destructive',
            )}
          >
            {passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
        </>
      }
    />
  );
};
