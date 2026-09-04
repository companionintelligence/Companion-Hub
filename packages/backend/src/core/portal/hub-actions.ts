/**
 * Hub verbs for `ci.computer/cap/hub`. Keep in lockstep with Portal
 * `HUB_ACTIONS` (CI-Engineering org-app-grants SPEC).
 *
 * Unlinked operators (no federated Portal row) get this explicit member
 * list — not owner `*` — and we log `whois_skipped_unlinked_operator`.
 */
export const HUB_CAPABILITY = 'ci.computer/cap/hub';

export const HUB_ACTIONS = ['view', 'start', 'stop', 'restart', 'install', 'update', 'uninstall', 'reset', 'backup', 'restore', 'configure'] as const;

export type HubAction = (typeof HUB_ACTIONS)[number];

export const DEFAULT_MEMBER_ACTIONS: readonly HubAction[] = HUB_ACTIONS;

export const WHOIS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_WHOIS_APP_IDS = 200;

export function isHubAction(value: string): value is HubAction {
  return (HUB_ACTIONS as readonly string[]).includes(value);
}
