/**
 * What a key may DO on the surfaces its scopes let it reach.
 *
 * Two independent axes, each with one job: `scopes` say *which surface* a key opens ('mcp' tools,
 * 'app' callbacks — see api-key.scopes.ts), `capability` says *what it may do* there. Keeping them
 * apart is deliberate: folding verbs into the scope array ('mcp:write') would overload a list whose
 * only current meaning is surface membership, and would need every scope-parsing site to learn to
 * split `surface:verb`.
 *
 * - 'read':  read-only tools only. Nothing the key can call changes appliance state.
 * - 'write': read + mutating tools (install, start, stop, reconfigure), but NOT destructive ones.
 * - 'full':  everything, including destructive tools (uninstall, reset, delete, bulk actions).
 *
 * This replaces the appliance-wide MCP_ALLOW_DESTRUCTIVE gate (ISSUE-MCP-2). That switch could only
 * be on or off for every key at once, so granting destructive access to one agent granted it to all
 * of them; capability makes the same decision per credential.
 *
 * Capability gates the MCP tool surface only. An 'app'-scoped callback key is a different contract
 * (identity-checked against its owning app URN), so its capability is inert — the UI shows the
 * control only for keys carrying 'mcp'.
 */
export const API_KEY_CAPABILITIES = ['read', 'write', 'full'] as const;

export type ApiKeyCapability = (typeof API_KEY_CAPABILITIES)[number];

/**
 * Capability a key gets when none is stated — the create API, the CLI, managed-key provisioning and
 * the column DEFAULT all land here.
 *
 * 'write' rather than either extreme: 'read' would break the "create a key, connect an agent" flow
 * (an agent that can't install or restart anything looks broken, not restricted), and 'full' would
 * reintroduce exactly the leaked-key blast radius ISSUE-MCP-2 exists to prevent. 'write' is what a
 * key could already do before this column existed, on an appliance with the destructive gate off —
 * which is its default.
 */
export const DEFAULT_API_KEY_CAPABILITY: ApiKeyCapability = 'write';

/** Ascending authority. Only ordering lives here; which tools each level reaches is the tool
 *  registry's business (see McpToolRegistry). */
const CAPABILITY_RANK: Record<ApiKeyCapability, number> = { read: 0, write: 1, full: 2 };

export function isApiKeyCapability(value: unknown): value is ApiKeyCapability {
  return typeof value === 'string' && (API_KEY_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Narrow a stored value to a capability, falling back to the strictest level rather than the
 * default. A row whose capability we cannot read is a row we do not understand, and the safe
 * reading of an unreadable authority level is the smallest one — never 'write' (which is only safe
 * as the default for a key nobody has expressed an opinion about) and certainly never 'full'.
 */
export function coerceApiKeyCapability(value: unknown): ApiKeyCapability {
  return isApiKeyCapability(value) ? value : 'read';
}

/**
 * True when moving from `from` to `to` grants authority the key did not have. Promotions are the
 * only capability changes that need an operator confirmation; a demotion only ever takes authority
 * away, so making one harder would just discourage tightening a key.
 */
export function isCapabilityPromotion(from: ApiKeyCapability, to: ApiKeyCapability): boolean {
  return CAPABILITY_RANK[to] > CAPABILITY_RANK[from];
}
