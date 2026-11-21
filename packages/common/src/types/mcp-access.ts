/**
 * A person's answer when an app's manifest asks for the Hub's MCP tools (`hub_integration.mcp_client`):
 * `none` refuses, and `read` / `write` / `full` let the app's own MCP key reach the apps beside it at
 * that level. `full` takes an organization owner or admin, as it does for any key.
 *
 * Shared because both ends of one contract need it: the install and Hub access routes validate
 * against this list, and the install dialog and the app's Hub access section render it.
 */
export const MCP_ACCESS_CHOICES = ['none', 'read', 'write', 'full'] as const;

export type McpAccessChoice = (typeof MCP_ACCESS_CHOICES)[number];

/** Whether a stored `app.mcp_access` lets the Hub mint the app's MCP key. `null` (never asked) does not. */
export function mcpAccessGranted(access: string | null | undefined): access is Exclude<McpAccessChoice, 'none'> {
  return access === 'read' || access === 'write' || access === 'full';
}
