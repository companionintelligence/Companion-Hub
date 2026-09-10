/**
 * Meaningful names for the generated `getStatusN` helpers.
 *
 * The generator numbers every operation that collapses to the same name, so five
 * different `/status` routes become `getStatus`…`getStatus5` in *spec order*. That
 * order is positional: adding, removing or reordering a `/status` route renumbers
 * the ones after it, and every call site silently changes meaning without a type
 * error — the shapes are all `unknown`-ish JSON at the boundary.
 *
 * That is not hypothetical. The Private VPN card and the onboarding Tailscale step
 * both called `getStatus5`, which had come to mean `/api/mcp-admin/status`. Both
 * rendered an MCP payload with no `installed`/`connected` field, so Tailscale showed
 * "inactive" with "the Hub could not access Tailscale" on every node — including nodes
 * whose backend was reporting `installed: true, connected: true`. Their tests passed
 * because they mocked `getStatus5Options` to return tailscale-shaped data, so the mock
 * encoded the bug.
 *
 * Import these names instead of the numbered ones. `named-status-routes.test.ts` pins
 * each to its URL, so a regeneration that renumbers fails the suite instead of the UI.
 */
// biome-ignore lint/performance/noBarrelFile: the point of this file is the rename — see the doc comment above.
export {
  getStatusOptions as registrationStatusOptions,
  getStatusQueryKey as registrationStatusQueryKey,
  getStatus2Options as cloudflareStatusOptions,
  getStatus2QueryKey as cloudflareStatusQueryKey,
  getStatus3Options as tailscaleStatusOptions,
  getStatus3QueryKey as tailscaleStatusQueryKey,
  getStatus4Options as inferenceStatusOptions,
  getStatus4QueryKey as inferenceStatusQueryKey,
  getStatus5Options as mcpAdminStatusOptions,
  getStatus5QueryKey as mcpAdminStatusQueryKey,
} from '@/api-client/@tanstack/react-query.gen';

/** The URL each alias must resolve to. Asserted against the generated SDK by the test. */
export const NAMED_STATUS_ROUTES = {
  getStatus: '/api/registration/status',
  getStatus2: '/api/cloudflare/status',
  getStatus3: '/api/tailscale/status',
  getStatus4: '/api/inference/status',
  getStatus5: '/api/mcp-admin/status',
} as const;
