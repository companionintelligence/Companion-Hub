/**
 * Turning a Hub event into the text we hand to OpenClaw's wake hook.
 *
 * The text does NOT become the agent's prompt. OpenClaw queues it as a *system event* and
 * renders it into the next heartbeat turn as `System: [<ts>] <text>`. The prompt driving
 * that turn stays OpenClaw's generic default — roughly "check if anything needs attention;
 * if not, reply HEARTBEAT_OK". So the text has to carry its own instruction, or the agent
 * will cheerfully answer HEARTBEAT_OK to a crashed app.
 *
 * Three constraints are load-bearing. OpenClaw's `compactSystemEvent` SILENTLY DROPS an
 * event whose text trips any of them, and a dropped event looks exactly like a wake that
 * never fired:
 *
 *   1. must not contain "heartbeat poll", "heartbeat wake", or "reason periodic"
 *   2. must not start with "read heartbeat.md" or "System:" (a leading `System:` is also
 *      rewritten to `System (untrusted):` by the inbound-tag sanitiser)
 *   3. must not look like an exec completion — /^exec finished(:|\s*\()/i
 *
 * `wake-text.test.ts` asserts all three across every event the Hub actually emits.
 */

/** The urgency tiers the Hub emits. Ordered: info < low < medium < high. */
export type Urgency = 'high' | 'medium' | 'low' | 'info';

/**
 * The tiers, ranked. Exported so callers can validate an operator-supplied value against
 * the real vocabulary instead of re-listing it and drifting.
 */
export const URGENCY_TIERS: Record<Urgency, number> = { info: 0, low: 1, medium: 2, high: 3 };

/**
 * Default floor for what is worth waking the agent over.
 *
 * `low` passes high/medium/low and drops the `info` tier (`update_success`,
 * `system.mcp_ready`) — routine confirmations that would each cost a full agent turn while
 * telling the user nothing they did not already expect.
 */
export const DEFAULT_MIN_URGENCY: Urgency = 'low';

/** Whether an event clears the urgency floor. Unknown urgencies are treated as the lowest. */
export function passesUrgency(urgency: Urgency, minUrgency: Urgency = DEFAULT_MIN_URGENCY): boolean {
  return (URGENCY_TIERS[urgency] ?? 0) >= (URGENCY_TIERS[minUrgency] ?? 0);
}

/** Whether a string is one of the four tiers. `Object.hasOwn`, not `in`: `in` would accept
 * "constructor" and every other Object.prototype key, and a floor of "constructor" compares
 * as NaN — silently dropping every wake. */
export function isUrgency(value: string): value is Urgency {
  return Object.hasOwn(URGENCY_TIERS, value);
}

/** Total budget for the text. A system event competes with the real conversation for context. */
const MAX_TEXT_CHARS = 800;
/** Per-value budget inside the `data` summary, so one long error cannot eat the whole line. */
const MAX_VALUE_CHARS = 200;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * The app's own name, for a label a human (and the agent) can use.
 *
 * An AppUrn is `${appName}:${appStoreSlug}` — see `createAppUrn`. The name is the HEAD of the
 * pair, not the tail: taking the tail yields the store slug, so every app in the default store
 * would be introduced to the agent as "ci-store".
 */
function appNameOf(appUrn: string | undefined): string {
  if (!appUrn) return 'unknown';
  const name = appUrn.split(':')[0]?.trim();
  return name || appUrn;
}

function appUrnOf(data: Record<string, unknown>): string | undefined {
  return typeof data.appUrn === 'string' && data.appUrn.trim() ? data.appUrn.trim() : undefined;
}

/** `key=value, key=value` — bounded, and stable enough to read in a transcript. */
function summarizeData(data: Record<string, unknown>): string {
  const parts = Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${truncate(String(value), MAX_VALUE_CHARS)}`);
  return parts.length ? parts.join(', ') : 'no further detail';
}

/**
 * Build the wake text for a Hub event.
 *
 * The shape is deliberate: `CI-Hub [<urgency>] <event> — <what happened>. <what to do>.`
 * Leading with the source and urgency gives the agent the triage signal up front, and the
 * closing instruction is what turns a generic heartbeat into a useful reply. High-urgency
 * events tell it to investigate and speak; informational ones tell it to stay quiet unless
 * asked, so a successful update does not produce an unprompted message.
 */
export function buildWakeText(event: string, data: Record<string, unknown>, urgency: Urgency): string {
  const urn = appUrnOf(data);
  const app = appNameOf(urn);
  const prefix = `CI-Hub [${urgency}] ${event}`;
  const target = urn ? `app "${app}" (${urn})` : `app "${app}"`;

  const text = ((): string => {
    switch (event) {
      case 'app.crashed': {
        const previous = data.previousStatus ? ` It was previously ${String(data.previousStatus)}.` : '';
        return `${prefix} — ${target} stopped unexpectedly.${previous} Investigate with the ci-hub tools (check its status and logs), then tell the user what broke and what you did about it.`;
      }

      case 'system.update_available':
        return `${prefix} — a Hub update is available (${String(data.current ?? '?')} → ${String(data.latest ?? '?')}). Mention it to the user. Do not update anything unless they ask.`;

      case 'system.high_disk':
      case 'system.high_memory':
        return `${prefix} — the Hub is under resource pressure (${summarizeData(data)}). Check what is consuming it and advise the user.`;

      case 'system.health_check_failed':
        return `${prefix} — the Hub health check failed (${summarizeData(data)}). Note it; no user action yet.`;

      case 'registration.state_changed': {
        const reasons = Array.isArray(data.reasons) && data.reasons.length ? ` (${truncate(data.reasons.join('; '), MAX_VALUE_CHARS)})` : '';
        return `${prefix} — Hub registration moved ${String(data.from ?? '?')} → ${String(data.to ?? '?')}${reasons}. If it is degraded, explain the impact to the user.`;
      }

      case 'system.mcp_ready':
        return `${prefix} — Hub tools are ready (${String(data.toolCount ?? '?')} available). Informational; no reply needed.`;

      default: {
        // The Hub's event names are inconsistent by drift — dotted (`app.crashed`) and
        // snake (`install_error`) both occur. Match on the suffix so a new `*_error` the
        // Hub adds tomorrow still produces a sensible line instead of a bare dump.
        if (event.endsWith('_error')) {
          const action = event.replace(/_error$/, '').replace(/_/g, ' ');
          const cause = data.error ? `: ${truncate(String(data.error), MAX_VALUE_CHARS)}` : '';
          return `${prefix} — "${action}" failed for ${target}${cause}. Diagnose with the ci-hub tools and report back to the user.`;
        }
        if (event.endsWith('_success')) {
          const action = event.replace(/_success$/, '').replace(/_/g, ' ');
          return `${prefix} — "${action}" succeeded for ${target}. Informational; only mention it if the user asks.`;
        }
        return `${prefix} — ${summarizeData(data)}.`;
      }
    }
  })();

  return truncate(text, MAX_TEXT_CHARS);
}
