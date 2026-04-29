import { Injectable } from '@nestjs/common';

/**
 * Periodic system health check service.
 * Monitors disk and memory usage and emits agent notifications
 * when thresholds are exceeded.
 *
 * Configured via:
 *   AGENT_HEALTH_CHECK_INTERVAL_MINUTES — check interval (default: 15)
 *
 * Emits:
 *   system.high_disk   — when disk usage > 90% (urgency: high)
 *   system.high_memory — when memory usage > 90% (urgency: medium)
 *
 * Health check events are debounced: same event not re-emitted within 1 hour.
 */
@Injectable()
export class AgentHealthCheckService {}
