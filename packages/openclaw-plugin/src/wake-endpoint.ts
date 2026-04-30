import type { OpenClawPluginApi, WakePayload } from './types';

const URGENCY_ORDER: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export interface WakeFilterConfig {
  minUrgency?: 'info' | 'low' | 'medium' | 'high';
  events?: string[];
}

/**
 * Handles incoming wake webhook requests from the Hub.
 * Validates auth, filters events, translates payloads, and triggers wakes.
 */
export function createWakeEndpointHandler(api: OpenClawPluginApi, wakeSecret?: string, wakeFilter?: WakeFilterConfig) {
  return async (req: { headers: Record<string, string | undefined>; body: unknown }) => {
    // Validate auth if wakeSecret is configured
    if (wakeSecret) {
      const authHeader = req.headers.authorization ?? req.headers.Authorization;
      if (!authHeader || !constantTimeEqual(authHeader, `Bearer ${wakeSecret}`)) {
        return { status: 403, body: { error: 'Forbidden' } };
      }
    }

    const payload = req.body as WakePayload;
    if (!payload?.event || !payload?.urgency) {
      return { status: 400, body: { error: 'Invalid payload' } };
    }

    // Apply wake filter
    if (!passesFilter(payload, wakeFilter)) {
      api.log.debug(`Wake event ${payload.event} filtered out`);
      return { status: 200, body: { received: true, filtered: true } };
    }

    // Translate to human-readable message and wake
    const message = translateWakeMessage(payload);
    api.wake(message);
    api.log.info(`Wake triggered: ${payload.event} (${payload.urgency})`);

    return { status: 200, body: { received: true } };
  };
}

/**
 * Check if a wake payload passes the configured filter.
 * Both minUrgency and events filters must pass (AND logic).
 */
export function passesFilter(payload: WakePayload, filter?: WakeFilterConfig): boolean {
  if (!filter) return true;

  // Check minimum urgency
  if (filter.minUrgency) {
    const payloadLevel = URGENCY_ORDER[payload.urgency] ?? 0;
    const minLevel = URGENCY_ORDER[filter.minUrgency] ?? 0;
    if (payloadLevel < minLevel) return false;
  }

  // Check event allowlist
  if (filter.events && filter.events.length > 0) {
    if (!filter.events.includes(payload.event)) return false;
  }

  return true;
}

/**
 * Translate a wake payload into a human-readable message for the OpenClaw agent.
 */
export function translateWakeMessage(payload: WakePayload): string {
  const { event, data, urgency } = payload;
  const parts: string[] = [`CI-Hub alert (${urgency}):`];

  switch (event) {
    case 'app.crashed': {
      const appName = extractAppName(data.appUrn as string);
      parts.push(`App ${appName} crashed.`);
      if (data.previousStatus) parts.push(`Previous status: ${data.previousStatus}.`);
      break;
    }
    case 'system.update_available':
      parts.push(`System update available: ${data.current} → ${data.latest}.`);
      break;
    case 'system.mcp_ready':
      parts.push('Hub MCP server is ready.');
      break;
    case 'registration.state_changed':
      parts.push(`Registration phase changed: ${data.from} → ${data.to}.`);
      break;
    default: {
      // Generic format for error/success events
      if (event.endsWith('_error') || event.endsWith('_success')) {
        const appName = data.appUrn ? extractAppName(data.appUrn as string) : 'unknown';
        const action = event.replace(/_error$|_success$/, '').replace(/_/g, ' ');
        const status = event.endsWith('_error') ? 'failed' : 'succeeded';
        parts.push(`App ${appName}: ${action} ${status}.`);
      } else {
        parts.push(`Event: ${event}.`);
        if (Object.keys(data).length > 0) parts.push(`Data: ${JSON.stringify(data)}`);
      }
    }
  }

  return parts.join(' ');
}

function extractAppName(appUrn?: string): string {
  if (!appUrn) return 'unknown';
  const parts = appUrn.split(':');
  return parts[1] ?? appUrn;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
