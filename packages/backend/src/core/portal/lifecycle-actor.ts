import type { HubAction } from './hub-actions';

/**
 * Who is asking the app lifecycle to act — named, never inferred.
 *
 * ⚠ ABSENCE USED TO BE CONSENT. `AppLifecycleService.installApp` and
 * `updateAppConfig` did no authorization of their own: the org-role gate lived
 * in the HTTP controller, so MCP and rehydrate walked past it, and the bulk
 * sweeps' `operatorMay` returned `true` whenever no operator id was passed —
 * which is exactly the MCP case, a key with no person behind it. A new
 * transport started unguarded by default, and the gate that did exist could not
 * tell "no person is present" from "a permitted person is present"
 * (CI-Hub#1397, R2-HUBHOSTESCAPE-6).
 *
 * So the service takes one of these, REQUIRED, and decides from it. Following
 * the named-principal pattern `isGrantExemptPrincipal` established (#1299,
 * #1309): name the principal, then let each gate say what it admits.
 */
export type LifecycleActor =
  /** A Hub session person — checked against their WhoIs grant for the action. */
  | { kind: 'operator'; userId: number }
  /** A grant-exempt named principal; see `isGrantExemptPrincipal`. */
  | { kind: 'exempt'; principal: 'portal-device' | 'cli' }
  /**
   * An MCP key. Its capability is already enforced by the tool registry;
   * `ownerAppUrn` is set for a MANAGED app key, which may act on its own app
   * and nothing else.
   */
  | { kind: 'mcp'; ownerAppUrn: string | null }
  /** The Hub acting on its own behalf, for a reason named here. */
  | { kind: 'system'; reason: 'update-reapply' | 'debug-seed' };

/**
 * The actor for one action, for a caller that can only name itself once the verb is known: an
 * unrecognised principal is refused for the verb it asked for (`MarketplaceWhoIsService.lifecycleActor`).
 */
export type LifecycleActorFor = (action: HubAction) => LifecycleActor;
