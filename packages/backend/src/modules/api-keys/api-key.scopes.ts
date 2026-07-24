/**
 * Scopes a locally-minted API key can carry. One key row may hold several scopes — e.g. a
 * companion app that both consumes Hub MCP tools and calls the Hub's app-facing REST endpoints
 * holds a single key with ['mcp', 'app'] — so provisioning never mints parallel credentials for
 * one app, and upgrading an app's scopes never rotates the secret it already holds.
 *
 * - 'mcp': accepted by the agent-facing MCP endpoint (/api/mcp). Operator keys carry this scope.
 * - 'app': accepted by app→Hub callback surfaces (memory-connect /apps/:urn/state|skip). Only
 *   ever minted as a managed key owned by an installed first-party app; an operator-created key
 *   never carries it because those have no owning app URN to satisfy the guard's identity check.
 */
export const API_KEY_SCOPES = ['mcp', 'app'] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const MCP_SCOPE: ApiKeyScope = 'mcp';
export const APP_SCOPE: ApiKeyScope = 'app';
