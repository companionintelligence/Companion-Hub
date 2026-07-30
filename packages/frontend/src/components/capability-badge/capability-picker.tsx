import { useTranslation } from 'react-i18next';
import { API_KEY_CAPABILITIES, type ApiKeyCapability, CAPABILITY_HINT_KEYS, CAPABILITY_LABEL_KEYS } from './capability-badge';

/**
 * The three-way choice of what a key may do. Shared by the create dialog and the change dialog so an
 * operator meets one control, with one set of words, in both places.
 *
 * Native radios rather than a dropdown: the options are not interchangeable settings but three levels
 * of authority, and each needs a line of consequence next to it. A collapsed select would hide exactly
 * the sentence that makes the choice an informed one.
 */
export const CapabilityPicker = ({
  value,
  onChange,
  name,
  disabled,
}: {
  value: ApiKeyCapability;
  onChange: (capability: ApiKeyCapability) => void;
  /** Radio group name — distinct per dialog so two mounted pickers never share a selection. */
  name: string;
  disabled?: boolean;
}) => {
  const { t } = useTranslation();

  return (
    <fieldset className="min-w-0 space-y-2" data-testid={`${name}-capability`}>
      <legend className="text-sm font-medium">{t('API_KEYS_CAPABILITY_LABEL')}</legend>
      {API_KEY_CAPABILITIES.map((capability) => (
        <label key={capability} className="flex cursor-pointer items-start gap-2" htmlFor={`${name}-capability-${capability}`}>
          <input
            id={`${name}-capability-${capability}`}
            type="radio"
            name={name}
            className="mt-1"
            value={capability}
            checked={value === capability}
            disabled={disabled}
            onChange={() => onChange(capability)}
            data-testid={`${name}-capability-${capability}`}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{t(CAPABILITY_LABEL_KEYS[capability])}</span>
            <span className="block text-xs text-muted-foreground">{t(CAPABILITY_HINT_KEYS[capability])}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
};
