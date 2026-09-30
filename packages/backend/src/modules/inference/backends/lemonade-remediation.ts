import type { HostFirewallInfo } from '@ci-hub/common/types';
import { HUB_APP_POOL_CIDR } from '@/modules/network/network-constants';
import {
  type BridgeFailureMode,
  type BridgeTopology,
  buildBridgeRemediation,
  buildFirewallAllowCommand,
  classifyBridgeFailure,
} from './ollama-host-bridge';

/** How the Hub's probe of Lemonade failed: a bridge failure, or `auth` — Lemonade answered and refused the key. */
export type LemonadeFailureMode = BridgeFailureMode | 'auth';

/**
 * A 401 or 403 means the Hub reached Lemonade and Lemonade turned its key down. Widening the bind or
 * opening the firewall fixes nothing then, so this is checked before the bridge classifier (which
 * would call the same failure `none` and leave the card showing its rebind steps).
 */
export function classifyLemonadeFailure(error: string | undefined, endpointUrl: string): LemonadeFailureMode {
  if (error && /status code 40[13]\b/.test(error)) return 'auth';
  return classifyBridgeFailure(error, endpointUrl);
}

export interface LemonadeRemediationInput {
  mode: LemonadeFailureMode;
  hostPlatform?: string;
  firewall?: HostFirewallInfo;
  /** From `resolveBridgeTopology`; firewall rules are left out when it is missing. */
  topology?: BridgeTopology;
  /** The Hub holds a `LEMONADE_API_KEY`. */
  apiKeyConfigured: boolean;
}

export interface LemonadeRemediation {
  /** Prose for the modes whose fix the card does not already spell out (`filtered`, `dns`, `auth`). */
  hint?: string;
  /**
   * Host commands admitting the Hub's container network and the app subnet to Lemonade's port. Two
   * sources, because the Hub probes Lemonade from its own network while marketplace apps live in
   * {@link HUB_APP_POOL_CIDR}, and they call Lemonade directly whenever pool routing is off. Empty on
   * macOS and Windows (Docker Desktop reaches host services itself), when the host probe found no
   * enabled firewall, or when the addresses are unknown.
   */
  firewallCommands: string[];
}

/**
 * Guidance for a Lemonade the Hub cannot use, built from what the Hub measured rather than one
 * Linux recipe for every failure. The rebind and API-key steps for a refused connection are the
 * card's own copy, which is translated; this supplies the parts only the server can know — the
 * failure mode, the host's firewall and the real addresses.
 */
export function buildLemonadeRemediation(input: LemonadeRemediationInput): LemonadeRemediation {
  const { mode, hostPlatform, firewall, topology, apiKeyConfigured } = input;
  const linuxHost = hostPlatform !== 'darwin' && hostPlatform !== 'win32';
  const firewallOff = firewall?.kind === 'none' || firewall?.active === false;
  const firewallCommands =
    linuxHost && !firewallOff && mode !== 'auth' && mode !== 'dns'
      ? [topology?.containerCidr, HUB_APP_POOL_CIDR]
          .map((containerCidr) => buildFirewallAllowCommand({ ...topology, containerCidr }, firewall))
          .filter((command): command is string => Boolean(command))
      : [];

  if (mode === 'auth') {
    return {
      hint: apiKeyConfigured
        ? "Lemonade answered but refused the Hub's API key. Set LEMONADE_API_KEY to the same value in Lemonade's service environment and in the Hub's .env, restart Lemonade and recreate the Hub, then re-check."
        : "Lemonade answered but requires an API key the Hub does not have. Add Lemonade's LEMONADE_API_KEY to the Hub's .env and recreate the Hub, then re-check.",
      firewallCommands,
    };
  }
  if (mode === 'filtered' || mode === 'dns') {
    // buildBridgeRemediation names the cause for both; its single firewall command is replaced by
    // the pair above, which also covers the app subnet.
    const { hint } = buildBridgeRemediation({ mode, hostPlatform, topology, firewall, service: 'Lemonade' });
    return { hint, firewallCommands };
  }
  return { firewallCommands };
}
