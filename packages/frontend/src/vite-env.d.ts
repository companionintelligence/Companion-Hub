/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Injected at build time from `CI_CLOUD_URL` (see `vite.config.ts`). */
  readonly CI_CLOUD_URL: string;
}
