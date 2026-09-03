import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApiKeyContext } from '@/modules/api-keys/api-key.service';

/**
 * The authenticated key behind the MCP request currently being handled.
 *
 * Why async storage rather than a parameter: between the controller and a tool handler sits the MCP
 * SDK — the transport parses the JSON-RPC frame and the `Server` dispatches it to a handler
 * registered once, at session creation. There is no seam to thread a request through, and the SDK
 * offers none.
 *
 * Why not bind the key to the session instead: a session is created by one `initialize` but reused by
 * every later request, and the guard re-authenticates each of those. Binding at initialize would make
 * a session's authority outlive the credential that opened it — a key demoted to read-only mid-session
 * would keep writing until the session was closed. Per-request storage keeps the answer to "what may
 * this caller do" exactly as fresh as authentication.
 *
 * Set by {@link McpController} around `transport.handleRequest`, read by {@link McpServerFactory}.
 * Absence is not treated as full authority anywhere — the registry fails closed to 'read'.
 */
export const mcpCallContext = new AsyncLocalStorage<ApiKeyContext>();
