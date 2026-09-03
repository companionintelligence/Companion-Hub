/** Curated onboarding picks: one high-value alternative per category (hub manifest). */
export type OnboardingCuratedPick = {
  category: string;
  proprietaryLabel: string;
  preferredSlugs: readonly string[];
};

export const ONBOARDING_CURATED_PICKS: readonly OnboardingCuratedPick[] = [
  { category: 'social', proprietaryLabel: 'Slack', preferredSlugs: ['mattermost', 'rocketchat'] },
  { category: 'media', proprietaryLabel: 'Google Photos', preferredSlugs: ['immich'] },
  { category: 'utilities', proprietaryLabel: 'Google Drive', preferredSlugs: ['nextcloud'] },
  { category: 'development', proprietaryLabel: 'GitHub', preferredSlugs: ['gitea', 'forgejo'] },
  { category: 'data', proprietaryLabel: 'Notion', preferredSlugs: ['appflowy', 'nocodb'] },
  { category: 'security', proprietaryLabel: '1Password', preferredSlugs: ['vaultwarden'] },
  { category: 'automation', proprietaryLabel: 'Zapier', preferredSlugs: ['n8n'] },
  { category: 'ai', proprietaryLabel: 'cloud AI chat', preferredSlugs: ['open-webui'] },
] as const;
