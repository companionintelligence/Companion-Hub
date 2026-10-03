import type { AiSetupConfig } from './ai-setup-types';
import type { OnboardingApp } from './types';

const STORAGE_KEY = 'ci-hub.onboarding-install';

export interface OnboardingInstallSession {
  apps: OnboardingApp[];
  /** Secrets removed. A reload must not overwrite a saved cloud key with a blank. */
  aiSetupConfig?: AiSetupConfig;
  /** Urns this tab already asked the Hub to install. */
  claimedUrns: string[];
}

function readRaw(): OnboardingInstallSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OnboardingInstallSession;
    if (!parsed || !Array.isArray(parsed.apps) || !Array.isArray(parsed.claimedUrns)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readOnboardingInstallSession(): OnboardingInstallSession | null {
  return readRaw();
}

export function writeOnboardingInstallSession(session: OnboardingInstallSession): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearOnboardingInstallSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

function withoutSecrets(config: AiSetupConfig): AiSetupConfig {
  return {
    ...config,
    vllmApiKey: undefined,
    cloudProviders: config.cloudProviders.map((provider) => ({ ...provider, apiKey: '' })),
  };
}

/** What a reload needs in order to show the install again, without the keys the person typed. */
export function installSessionFromSelection(apps: OnboardingApp[], aiSetupConfig: AiSetupConfig | undefined): OnboardingInstallSession {
  const existing = readRaw();
  return {
    apps,
    aiSetupConfig: aiSetupConfig ? withoutSecrets(aiSetupConfig) : undefined,
    claimedUrns: existing?.claimedUrns ?? [],
  };
}

export function onboardingInstallUrnClaimed(urn: string): boolean {
  return readRaw()?.claimedUrns.includes(urn) ?? false;
}

export function claimOnboardingInstallUrn(urn: string): void {
  const current = readRaw() ?? { apps: [], claimedUrns: [] };
  if (current.claimedUrns.includes(urn)) return;
  writeOnboardingInstallSession({ ...current, claimedUrns: [...current.claimedUrns, urn] });
}

export function releaseOnboardingInstallUrn(urn: string): void {
  const current = readRaw();
  if (!current) return;
  if (!current.claimedUrns.includes(urn)) return;
  writeOnboardingInstallSession({ ...current, claimedUrns: current.claimedUrns.filter((claimed) => claimed !== urn) });
}
