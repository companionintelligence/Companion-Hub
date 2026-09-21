import { useTranslation } from 'react-i18next';

/** Known API-key scopes → their i18n label key. Unknown scopes fall back to the raw string, so a
 *  scope added to the backend still renders (untranslated) rather than disappearing. Single source
 *  for both the Settings → Security key list and the app-detail Hub-access card, so the same scope
 *  can never render as a translated label in one screen and a raw string in the other. */
const SCOPE_BADGE_KEYS: Record<string, string> = {
  mcp: 'API_KEYS_SCOPE_MCP',
  app: 'API_KEYS_SCOPE_APP',
  inference: 'API_KEYS_SCOPE_INFERENCE',
  // Minted by the CLI only (`cihub api-key create --scope qa:read`); the list must still name it.
  'qa:read': 'API_KEYS_SCOPE_QA_READ',
};

/** A small pill labelling one scope a key carries (e.g. "MCP", "App"). */
export const ScopeBadge = ({ scope }: { scope: string }) => {
  const { t } = useTranslation();
  return (
    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{SCOPE_BADGE_KEYS[scope] ? t(SCOPE_BADGE_KEYS[scope]) : scope}</span>
  );
};
