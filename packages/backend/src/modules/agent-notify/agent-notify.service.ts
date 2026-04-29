import { Injectable } from '@nestjs/common';

/**
 * Service for emitting events to a configured agent webhook (OpenClaw).
 * Fire-and-forget with debouncing of identical events within a 30s window.
 *
 * Configured via environment variables:
 *   AGENT_WEBHOOK_URL     — target URL
 *   AGENT_WEBHOOK_TOKEN   — Bearer token for Authorization header
 *   AGENT_WEBHOOK_ENABLED — master toggle (default: true when URL is set)
 */
@Injectable()
export class AgentNotifyService {
  async notify(event: string, data: Record<string, unknown>, urgency: 'high' | 'medium' | 'low' | 'info'): Promise<void> {
    // TODO: implement
  }
}
