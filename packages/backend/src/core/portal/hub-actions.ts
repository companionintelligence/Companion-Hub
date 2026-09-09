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

/**
 * What a caller gets when the grant could not be resolved from Portal.
 *
 * ⚠ THIS WAS `HUB_ACTIONS` — THE COMPLETE VERB SET — while the comment above
 * called it "this explicit member list, not owner `*`". It was owner `*`, spelt
 * out. So an unlinked operator, and every caller on a Hub with no Portal
 * configured, and every WhoIs outage, resolved to `install`, `uninstall`,
 * `reset`, `restore` and `configure` on every app.
 *
 * A fallback is a state in which we do not know what somebody may do. The verbs
 * that survive that are the ones whose worst outcome is an app being stopped
 * and started again; nothing that installs software, destroys data, or rewrites
 * an app's configuration belongs in a list reached by a failure.
 */
export const DEFAULT_MEMBER_ACTIONS: readonly HubAction[] = ['view', 'start', 'stop', 'restart'] as const;

export const WHOIS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_WHOIS_APP_IDS = 200;

export function isHubAction(value: string): value is HubAction {
  return (HUB_ACTIONS as readonly string[]).includes(value);
}
