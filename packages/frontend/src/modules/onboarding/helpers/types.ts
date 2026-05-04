export interface AltAlternative {
  name: string;
  icon: string;
  url: string;
  appSlug?: string;
}

export interface AltProprietary {
  name: string;
  icon: string;
  url: string | null;
}

export interface AltEntry {
  proprietary: AltProprietary[];
  alternatives: AltAlternative[];
}

export type AltsCategory = Record<string, AltEntry[]>;

export interface OnboardingApp {
  appSlug: string;
  name: string;
  icon: string;
  category: string;
  replacesNames: string[];
  urn?: string; // resolved from app store
  localSubdomain?: string;
}

/** Fine-grained install status for each app during the install step. */
export type AppInstallStatus = 'queued' | 'installing' | 'running' | 'incomplete' | 'failed';

/** Per-app result surfaced after the install step finishes. */
export interface AppInstallResult {
  app: OnboardingApp;
  status: AppInstallStatus;
  error?: string;
}

/** Aggregate summary passed from InstallStep → CompleteStep so
 *  the completion screen can render truthful copy. */
export interface InstallSummary {
  results: AppInstallResult[];
  /** Apps confirmed running by the installed-apps poll. */
  running: number;
  /** Install request accepted but the app was not confirmed ready within the timeout. */
  incomplete: number;
  /** Install request failed or the server rejected it. */
  failed: number;
  /** Total number of apps that were submitted for install. */
  total: number;
}

// Re-export AiSetupConfig from the dedicated AI setup types module
export type { AiSetupConfig } from './ai-setup-types';
