import { cn } from '@/lib/utils';
import { MCP_ACCESS_CHOICES, type McpAccessChoice } from '@ci-hub/common/types';
import { useTranslation } from 'react-i18next';
import { CAPABILITY_LABEL_KEYS, MANAGED_CAPABILITY_HINT_KEYS } from './capability-badge';

/**
 * The answer to an app's request for the Hub's MCP tools: no access, or the level its own key reaches
 * the apps beside it at. The levels read as they do in `CapabilityPicker`'s managed mode, the same
 * key seen from Settings → Security, so a person meets one set of words for one thing.
 *
 * `unavailable` lists levels this person may not give, shown disabled with `unavailableHint` in place
 * of their consequence line, as `CapabilityPicker` does.
 */
export const McpAccessPicker = ({
  value,
  onChange,
  name,
  disabled,
  unavailable = [],
  unavailableHint,
}: {
  value: McpAccessChoice;
  onChange: (access: McpAccessChoice) => void;
  /** Radio group name — distinct per screen so two mounted pickers never share a selection. */
  name: string;
  disabled?: boolean;
  unavailable?: readonly McpAccessChoice[];
  unavailableHint?: string;
}) => {
  const { t } = useTranslation();

  return (
    <fieldset className="min-w-0 space-y-2" data-testid={`${name}-mcp-access`}>
      <legend className="sr-only">{t('APP_MCP_ACCESS_TITLE')}</legend>
      {MCP_ACCESS_CHOICES.map((access) => {
        const isUnavailable = unavailable.includes(access);
        const label = access === 'none' ? t('APP_MCP_ACCESS_NONE') : t(CAPABILITY_LABEL_KEYS[access]);
        const hint =
          isUnavailable && unavailableHint
            ? unavailableHint
            : access === 'none'
              ? t('APP_MCP_ACCESS_NONE_HINT')
              : t(MANAGED_CAPABILITY_HINT_KEYS[access]);

        return (
          <label
            key={access}
            className={cn('flex items-start gap-2', isUnavailable ? 'cursor-not-allowed' : 'cursor-pointer')}
            htmlFor={`${name}-mcp-access-${access}`}
          >
            <input
              id={`${name}-mcp-access-${access}`}
              type="radio"
              name={name}
              className="mt-1"
              value={access}
              checked={value === access}
              disabled={disabled || isUnavailable}
              onChange={() => onChange(access)}
              data-testid={`${name}-mcp-access-${access}`}
            />
            <span className="min-w-0">
              <span className={cn('block text-sm font-medium', isUnavailable && 'text-muted-foreground')}>{label}</span>
              <span className="block text-xs text-muted-foreground">{hint}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
};
