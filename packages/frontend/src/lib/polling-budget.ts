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
} as const;
