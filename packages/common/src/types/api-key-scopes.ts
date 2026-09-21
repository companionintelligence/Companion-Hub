/**
 * The API-key scopes an operator may mint for themselves, shared between the Hub's create route and
 * the Settings screen that calls it.
 *
 * Here in `@ci-hub/common` rather than beside the rest of the scope definitions in
 * `packages/backend/src/modules/api-keys/api-key.scopes.ts` because both ends of one contract need
 * it: the DTO validates against this list and the picker renders it, and a screen offering a scope
 * the route would refuse is the failure this placement prevents. The full scope list — including
 * the two nobody mints by hand — stays in the backend, since nothing outside it may use those.
 *
 * Narrower than the backend's `API_KEY_SCOPES` by exactly two:
 * - 'app' needs an owning app URN to satisfy the callback guard's identity check, so an
 *   operator-minted one would list as a credential and authenticate nothing.
 * - 'qa:read' is minted over ssh on the node under test, and putting it beside 'mcp' in a browser
 *   would invite it as a "safer MCP key", which it is not — it is a different surface.
 *
 * A tuple so `z.enum` can consume it directly; 'mcp' is first because it is the DTO's default.
 */
export const OPERATOR_MINTABLE_SCOPES = ['mcp', 'inference'] as const;

export type OperatorMintableScope = (typeof OPERATOR_MINTABLE_SCOPES)[number];
