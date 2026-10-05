/** Central polling intervals for React Query refetchInterval (ms). */
export const POLLING = {
  /** App runtime / install progress when SSE is unavailable. */
  APP_STATUS_MS: 3000,
  /** Inference model pull progress. */
  MODEL_PULL_MS: 2000,
  /** Registration / tailscale readiness during onboarding. */
  REGISTRATION_MS: 3000,
  /** System inspector / docker stats. */
  SYSTEM_INSPECTOR_MS: 5000,
  /** Desktop Tauri hub-status / docker-access poll. */
  HUB_STATUS_MS: 5000,
  /** Hub Pool setup guide, approval step: how often to re-read pool status while a request waits. Stops when nothing is waiting. */
  POOL_SETUP_WAIT_MS: 3000,
  /** Hub Pool setup guide, readiness step: how often to re-read Tailscale while the user signs in. */
  POOL_SETUP_READINESS_MS: 5000,
  /** Home page Hub Pool suggestion: how often to re-read pool status. Cheap; never the discovery route. */
  POOL_NUDGE_MS: 30_000,
} as const;
