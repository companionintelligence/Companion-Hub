/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Injected at build time from `CI_CLOUD_URL` (see `vite.config.ts`). */
  readonly CI_CLOUD_URL: string;
  /** Injected at build time from `CI_HUB_VERSION` (see `vite.config.ts`). */
  readonly CI_HUB_VERSION: string;
  /**
   * Injected at build time from `CI_HUB_ENVIRONMENT` (see `vite.config.ts`).
   * `"production"` in release builds; empty string in dev/local builds.
   * Mirrors the Rust binary's compile-time `option_env!("CI_HUB_ENVIRONMENT")` check.
   */
  readonly CI_HUB_ENVIRONMENT: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_RELEASE?: string;
}
