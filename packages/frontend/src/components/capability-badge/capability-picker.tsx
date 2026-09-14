import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import {
  API_KEY_CAPABILITIES,
  type ApiKeyCapability,
  CAPABILITY_HINT_KEYS,
  CAPABILITY_LABEL_KEYS,
  MANAGED_CAPABILITY_HINT_KEYS,
} from './capability-badge';

/**
 * The three-way choice of what a key may do. Shared by the create dialog and the change dialog so an
 * operator meets one control, with one set of words, in both places.
 *
 * Native radios rather than a dropdown: the options are not interchangeable settings but three levels
 * of authority, and each needs a line of consequence next to it. A collapsed select would hide exactly
 * the sentence that makes the choice an informed one.
 *
 * `unavailable` lists levels this operator may not grant — full capability takes an organization owner
 * or admin — shown disabled with `unavailableHint` in place of their consequence line, rather than
 * hidden, so a member can see the level exists and who to ask.
 *
 * `managed` is for a key the Hub provisioned to an app: its level also decides how far it reaches the
 * apps beside its own, so each consequence line says that instead.
 */
export const CapabilityPicker = ({
  value,
  onChange,
  name,
  disabled,
  unavailable = [],
  unavailableHint,
  managed = false,
}: {
  value: ApiKeyCapability;
  onChange: (capability: ApiKeyCapability) => void;
  /** Radio group name — distinct per dialog so two mounted pickers never share a selection. */
  name: string;
  disabled?: boolean;
  unavailable?: readonly ApiKeyCapability[];
  unavailableHint?: string;
  managed?: boolean;
}) => {
  const { t } = useTranslation();
  const hintKeys = managed ? MANAGED_CAPABILITY_HINT_KEYS : CAPABILITY_HINT_KEYS;

  return (
    <fieldset className="min-w-0 space-y-2" data-testid={`${name}-capability`}>
      <legend className="text-sm font-medium">{t('API_KEYS_CAPABILITY_LABEL')}</legend>
      {API_KEY_CAPABILITIES.map((capability) => {
        const isUnavailable = unavailable.includes(capability);

        return (
          <label
            key={capability}
            className={cn('flex items-start gap-2', isUnavailable ? 'cursor-not-allowed' : 'cursor-pointer')}
            htmlFor={`${name}-capability-${capability}`}
          >
            <input
              id={`${name}-capability-${capability}`}
              type="radio"
              name={name}
              className="mt-1"
              value={capability}
              checked={value === capability}
              disabled={disabled || isUnavailable}
              onChange={() => onChange(capability)}
              data-testid={`${name}-capability-${capability}`}
            />
            <span className="min-w-0">
              <span className={cn('block text-sm font-medium', isUnavailable && 'text-muted-foreground')}>
                {t(CAPABILITY_LABEL_KEYS[capability])}
              </span>
              <span className="block text-xs text-muted-foreground">
                {isUnavailable && unavailableHint ? unavailableHint : t(hintKeys[capability])}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
};
