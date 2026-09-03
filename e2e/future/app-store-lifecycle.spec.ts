/**
 * App Store Lifecycle — PROMOTED to active coverage.
 *
 * This file previously contained aspirational full-lifecycle tests that
 * required Docker-in-Docker and a real app catalog. The core verification
 * logic has been promoted to maintained tests:
 *
 *   - e2e/launch-path.spec.ts — launch-path smoke tests across all Hub states
 *   - e2e/app-lifecycle.spec.ts — DB-level app lifecycle reconciliation
 *   - e2e/dev-mode.spec.ts — multi-store configuration verification
 *
 * The `generateAppLifecycleTest` pattern is preserved below for use by
 * future Docker-in-Docker test runs (e.g. via e2e/docker-compose.e2e.yml),
 * but it is no longer the primary lifecycle coverage.
 */

// biome-ignore lint/performance/noBarrelFile: Intentional re-export for backward compatibility with Docker-in-Docker test runners
export { generateAppLifecycleTest } from './app-lifecycle-generator';
