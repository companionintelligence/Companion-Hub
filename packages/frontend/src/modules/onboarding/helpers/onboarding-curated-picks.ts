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

/**
 * The compact shortlist shown in the FTUE. This follows the Hub's Alternatives chart while keeping
 * the first-run choice focused: twenty high-value apps across the chart's category sequence.
 * Catalog metadata is layered on at runtime, so entries that are not synced into this Hub are
 * still visible with a truthful "Soon" state instead of disappearing from the comparison.
 */
export type OnboardingTopAlternative = {
  category: string;
  icon?: string;
  proprietary: readonly string[];
  slug: string;
  name: string;
};

export const ONBOARDING_TOP_ALTERNATIVES: readonly OnboardingTopAlternative[] = [
  { category: 'utilities', proprietary: ['Microsoft Office', 'Google Workspace'], slug: 'onlyoffice', name: 'OnlyOffice' },
  { category: 'utilities', proprietary: ['Notion'], slug: 'appflowy', name: 'AppFlowy' },
  { category: 'utilities', proprietary: ['Evernote'], slug: 'joplin', name: 'Joplin' },
  { category: 'utilities', proprietary: ['Adobe Acrobat', 'Smallpdf'], slug: 'stirling-pdf', name: 'Stirling PDF' },
  { category: 'social', proprietary: ['Slack', 'Discord'], slug: 'mattermost', name: 'Mattermost' },
  { category: 'social', proprietary: ['Zoom', 'Microsoft Teams'], slug: 'jitsi', name: 'Jitsi Meet' },
  { category: 'development', proprietary: ['Jira', 'Asana', 'Trello'], slug: 'plane', name: 'Plane' },
  { category: 'development', proprietary: ['GitHub', 'GitLab (SaaS)'], slug: 'gitea', name: 'Gitea' },
  { category: 'development', proprietary: ['VS Code (Proprietary)', 'Cursor'], slug: 'code-server', name: 'code-server' },
  { category: 'data', proprietary: ['Airtable'], slug: 'nocodb', name: 'NocoDB' },
  { category: 'data', proprietary: ['Google Drive', 'Dropbox'], slug: 'nextcloud', name: 'Nextcloud' },
  { category: 'finance', proprietary: ['Rocket Money', 'YNAB'], slug: 'wallos', name: 'Wallos' },
  { category: 'media', proprietary: ['Figma', 'Sketch'], slug: 'penpot', name: 'Penpot' },
  { category: 'media', proprietary: ['Miro', 'Mural'], slug: 'excalidraw', name: 'Excalidraw' },
  { category: 'automation', proprietary: ['Google Home', 'Amazon Alexa', 'Apple HomeKit'], slug: 'home-assistant', name: 'Home Assistant' },
  { category: 'automation', proprietary: ['Zapier', 'Make'], slug: 'n8n', name: 'n8n' },
  {
    category: 'security',
    icon: '/brands/vaultwarden.png',
    proprietary: ['LastPass', '1Password'],
    slug: 'vaultwarden',
    name: 'Vaultwarden',
  },
  { category: 'security', proprietary: ['AdGuard', 'NextDNS'], slug: 'pi-hole', name: 'Pi-hole' },
  { category: 'photography', proprietary: ['Google Photos', 'iCloud Photos'], slug: 'immich', name: 'Immich' },
  { category: 'ai', proprietary: ['ChatGPT', 'Claude'], slug: 'open-webui', name: 'Open WebUI' },
] as const;
