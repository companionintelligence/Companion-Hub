import { AGENT_APP_SLUG, type AgentFramework, type ExposureMode } from './ai-setup-types';
import type { OnboardingApp } from './types';

/** Minimal shape of a store app entry (from AppContextDto.apps) needed to resolve the agent. */
export interface StoreAppLite {
  id: string;
  name: string;
  urn: string;
}

const AGENT_FALLBACK_NAME: Record<AgentFramework, string> = {
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
};

const AGENT_ICON_URL: Record<AgentFramework, string> = {
  openclaw: '/agents/openclaw.png',
  hermes: '/agents/hermes.png',
};

/**
 * Resolve the chosen agent framework to an installable {@link OnboardingApp}, pulling its name/urn
 * from the synced store apps. `urn` is undefined when the agent app is not present in the store
 * (callers should treat that as unavailable).
 */
export function buildAgentApp(framework: AgentFramework, storeApps: StoreAppLite[]): OnboardingApp {
  const slug = AGENT_APP_SLUG[framework];
  const store = storeApps.find((a) => a.id === slug);
  return {
    appSlug: slug,
    name: store?.name ?? AGENT_FALLBACK_NAME[framework],
    icon: AGENT_ICON_URL[framework],
    category: 'ai',
    replacesNames: [],
    urn: store?.urn,
    localSubdomain: slug,
  };
}

/**
 * Resolve the exposure mode to actually install with, given what's currently available. A user can
 * pick "Private VPN" (tailscale) or "Web" (cloudflare) before those transports are connected, so we
 * fall back gracefully: the chosen transport if available, otherwise the other remote transport,
 * otherwise local (device-only). An explicit `local` choice is respected; `undefined` (AI skipped)
 * uses whatever remote transport is available.
 */
export function resolveExposureMode(
  chosen: ExposureMode | undefined,
  availability: { cloudflareAvailable: boolean; tailscaleAvailable: boolean },
): ExposureMode {
  const { cloudflareAvailable, tailscaleAvailable } = availability;
  if (chosen === 'tailscale') {
    return tailscaleAvailable ? 'tailscale' : cloudflareAvailable ? 'cloudflare' : 'local';
  }
  if (chosen === 'cloudflare') {
    return cloudflareAvailable ? 'cloudflare' : tailscaleAvailable ? 'tailscale' : 'local';
  }
  if (chosen === 'local') {
    return 'local';
  }
  // Undefined (AI setup skipped): use whatever remote transport is configured, else local.
  return cloudflareAvailable ? 'cloudflare' : tailscaleAvailable ? 'tailscale' : 'local';
}

/** Human label for an exposure mode, used in onboarding summaries. */
export function exposureModeLabel(mode: ExposureMode): string {
  switch (mode) {
    case 'tailscale':
      return 'Private VPN (Tailscale)';
    case 'cloudflare':
      return 'Web (Cloudflare)';
    case 'local':
      return 'This device only';
  }
}
