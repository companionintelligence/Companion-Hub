import { useTranslation } from 'react-i18next';

/**
 * What an API key may DO on the surfaces its scopes reach — mirrors API_KEY_CAPABILITIES in
 * packages/backend/src/modules/api-keys/api-key.capabilities.ts. Ordered by authority, which is the
 * order the picker renders in and the order a promotion is judged against.
 */
export const API_KEY_CAPABILITIES = ['read', 'write', 'full'] as const;

export type ApiKeyCapability = (typeof API_KEY_CAPABILITIES)[number];

/** i18n keys for each level: a short label for the badge, and one line saying what it lets a key do.
 *  Single source, so the level named on a row, in the picker and in the confirmation always reads the
 *  same — an operator comparing them must never have to wonder whether two words mean one thing. */
export const CAPABILITY_LABEL_KEYS: Record<ApiKeyCapability, string> = {
  read: 'API_KEYS_CAPABILITY_READ',
  write: 'API_KEYS_CAPABILITY_WRITE',
  full: 'API_KEYS_CAPABILITY_FULL',
};

export const CAPABILITY_HINT_KEYS: Record<ApiKeyCapability, string> = {
  read: 'API_KEYS_CAPABILITY_READ_HINT',
  write: 'API_KEYS_CAPABILITY_WRITE_HINT',
  full: 'API_KEYS_CAPABILITY_FULL_HINT',
};

/** The same levels for a managed key, which acts for the app that owns it: there each level says what it
 *  may do on that app and how far it reaches every other app, which is what an operator is deciding. */
export const MANAGED_CAPABILITY_HINT_KEYS: Record<ApiKeyCapability, string> = {
  read: 'API_KEYS_CAPABILITY_MANAGED_READ_HINT',
  write: 'API_KEYS_CAPABILITY_MANAGED_WRITE_HINT',
  full: 'API_KEYS_CAPABILITY_MANAGED_FULL_HINT',
};

/**
 * Three steps of one escalating scale, so a row's authority is legible at a glance rather than by
 * reading the word: inert → ordinary → caution.
 *
 * Amber, not destructive red, for 'full'. Red is this UI's colour for the destructive *action*
 * (Revoke sits on the same row), and a key an operator deliberately granted delete rights is not an
 * error state — rendering it identically to a danger button trains people to ignore the colour where
 * it does mean danger. Amber says "can lose data" without claiming something is wrong.
 *
 * Every level gets a ring so all three read as the same kind of object at different intensities; a
 * level with no styling at all would look like a missing value rather than the lowest rung.
 */
const CAPABILITY_CLASSES: Record<ApiKeyCapability, string> = {
  read: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
  write: 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/20',
  full: 'bg-amber-500/10 text-amber-700 ring-1 ring-inset ring-amber-500/30 dark:text-amber-400',
};

/** True when moving to `to` grants authority `from` did not have — the test for whether a change
 *  needs an operator confirmation. Mirrors isCapabilityPromotion on the backend. */
export const isCapabilityPromotion = (from: ApiKeyCapability, to: ApiKeyCapability): boolean =>
  API_KEY_CAPABILITIES.indexOf(to) > API_KEY_CAPABILITIES.indexOf(from);

/** A small pill naming what a key can do ("Read-only", "Read & write", "Full access"). */
export const CapabilityBadge = ({ capability }: { capability: ApiKeyCapability }) => {
  const { t } = useTranslation();
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${CAPABILITY_CLASSES[capability]}`} data-testid={`api-key-capability-${capability}`}>
      {t(CAPABILITY_LABEL_KEYS[capability])}
    </span>
  );
};
