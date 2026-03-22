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
