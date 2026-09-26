import type { ApiKeyCapability } from '@/modules/api-keys/api-key.capabilities';
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
   * An MCP key. The tool registry already enforces its capability on each tool.
   *
   * `ownerAppUrn` is set for a MANAGED app key, which may do anything on its own
   * app; on the others, its `capability` decides how far it reaches
   * (`AppLifecycleService.actorMay`). `createdByUserId` names the Hub person who
   * created an unmanaged key: it acts with that person's grants and role, never
   * more. `null` there is a key nobody is recorded as creating — minted by the
   * CLI, or before creators were recorded — which keeps the per-app reach keys
   * had before, and gets nothing that takes a role.
   *
   * `capability` is the key's level as read for this request, so a change made in
   * Settings applies from the next call. Only the managed-key rule reads it here.
   */
  | { kind: 'mcp'; ownerAppUrn: string | null; createdByUserId: number | null; capability: ApiKeyCapability }
  /** The Hub acting on its own behalf, for a reason named here. */
  | { kind: 'system'; reason: SystemLifecycleReason };

/**
 * Why the Hub acts on an app with nobody's grant to check. Each reason is a step of an operation
 * somebody was already authorized for, or the Hub's own upkeep — so a new caller has to say which,
 * rather than borrow a reason that happens to pass.
 */
export type SystemLifecycleReason =
  // A step of an operation its caller was authorized for:
  | 'update-reapply' // `updateApp` re-applies the app's own config
  | 'reinstall-start' // `installApp` starts an app that is already installed
  | 'start-after-reset' // `resetApp` brings back an app that was running
  | 'restart-after-config-update' // `updateAppConfig` applies a saved config to a running app
  | 'resume-after-backup' // a backup starts the app it stopped
  | 'resume-after-restore' // a restore starts the app it stopped
  | 'hub-access-rotate' // a credential rotation restarts the app to re-provision it
  | 'sweep' // one app of an *-all sweep, which already asked `actorMay` of its own actor for that app
  | 'restore-after-pairing' // pairing back onto a device, with a code from its organization, restores the apps Portal lists for it
  // The Hub's own upkeep:
  | 'bootstrap-restart' // a Hub starting on a new version restarts the apps that were running
  | 'inference-env-refresh' // inference settings or the Hub version changed; AI apps pick up the new env
  | 'custom-domain-revert' // an app still forwarding a removed custom domain is restarted off it
  | 'custom-domain-apply' // the operator asked for a bound custom domain to start serving, so the app is recreated onto it
  | 'public-domain-move' // CI-Cloud published the app on another domain than it asked for, so it is recreated onto that one
  | 'memory-connect' // a Companion Memory connection change reaches the app holding it
  | 'device-key-refresh' // pairing issued a new Portal device key; the app that calls Portal as this device picks it up
  // The debug routes:
  | 'debug-seed'
  | 'debug-start-all'
  | 'debug-uninstall-all'
  | 'debug-backup-all';

/**
 * What a check is for, where its verb cannot say. A person is still checked on the verb alone: only a
 * managed app key with `write` capability, on an app that is not its own, reads this
 * (`AppLifecycleService.actorMay`).
 *
 * Only the call such a key may make is marked. A check that leaves the marker off is refused that key
 * on other apps, so a caller that forgets it fails closed rather than open.
 */
export interface ActorCheckContext {
  /** A call into the app's own MCP tools or HTTP API — `configure` to a person, or `view` for a read. */
  appCall?: true;
  /** Stopping the app. Cancelling its operation is `stop` to a person too, and is not marked. */
  stopsApp?: true;
}

/**
 * The actor for one action, for a caller that can only name itself once the verb is known: an
 * unrecognised principal is refused for the verb it asked for (`MarketplaceWhoIsService.lifecycleActor`).
 */
export type LifecycleActorFor = (action: HubAction) => LifecycleActor;
