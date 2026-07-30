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

/** Colour carries the same meaning as everywhere else in the Hub: muted = inert, primary = ordinary
 *  action, destructive = can lose data. So 'full' looks like the Revoke button, not like a feature. */
const CAPABILITY_CLASSES: Record<ApiKeyCapability, string> = {
  read: 'bg-muted text-muted-foreground',
  write: 'bg-primary/10 text-primary',
  full: 'bg-destructive/10 text-destructive',
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
