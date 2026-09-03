import { describe, expect, it } from 'vitest';
import { resolveOnboardingRecommendations } from './alternatives';
import type { AltsCategory } from './types';

const mockAlts: AltsCategory = {
  social: [
    {
      proprietary: [{ name: 'Slack', icon: '', url: null }],
      alternatives: [
        { name: 'Mattermost', icon: '', url: '', appSlug: 'mattermost' },
        { name: 'Rocket.Chat', icon: '', url: '', appSlug: 'rocketchat' },
      ],
    },
  ],
  media: [
    {
      proprietary: [{ name: 'Google Photos', icon: '', url: null }],
      alternatives: [{ name: 'Immich', icon: '', url: '', appSlug: 'immich' }],
    },
  ],
  utilities: [
    {
      proprietary: [{ name: 'Google Drive', icon: '', url: null }],
      alternatives: [{ name: 'Nextcloud', icon: '', url: '', appSlug: 'nextcloud' }],
    },
  ],
};

const mockStoreApps = [
  { id: 'mattermost', urn: 'mattermost:ci-marketplace', name: 'Mattermost', icon: '/m.png' },
  { id: 'immich', urn: 'immich:ci-marketplace', name: 'Immich', icon: '/i.png' },
  { id: 'nextcloud', urn: 'nextcloud:ci-marketplace', name: 'Nextcloud', icon: '/n.png' },
  { id: 'gitea', urn: 'gitea:ci-marketplace', name: 'Gitea', icon: '/g.png' },
  { id: 'appflowy', urn: 'appflowy:ci-marketplace', name: 'AppFlowy', icon: '/a.png' },
  { id: 'vaultwarden', urn: 'vaultwarden:ci-marketplace', name: 'Vaultwarden', icon: '/v.png' },
  { id: 'n8n', urn: 'n8n:ci-marketplace', name: 'n8n', icon: '/n8.png' },
  { id: 'open-webui', urn: 'open-webui:ci-marketplace', name: 'Open WebUI', icon: '/o.png' },
];

describe('resolveOnboardingRecommendations', () => {
  it('returns one pick per preferred slug present in the catalog', () => {
    const result = resolveOnboardingRecommendations([], mockAlts, mockStoreApps);

    expect(result.every((r) => r.alternatives.length === 1)).toBe(true);
    expect(result.map((r) => r.alternatives[0]?.appSlug)).toEqual(expect.arrayContaining(['mattermost', 'immich', 'nextcloud']));
  });

  it('includes every preferred slug present in the catalog, in preferred order', () => {
    const result = resolveOnboardingRecommendations([], mockAlts, [
      ...mockStoreApps,
      { id: 'rocketchat', urn: 'rocketchat:ci-marketplace', name: 'Rocket.Chat' },
    ]);

    const socialSlugs = result.filter((r) => r.category === 'social').map((r) => r.alternatives[0]?.appSlug);
    expect(socialSlugs).toEqual(['mattermost', 'rocketchat']);
  });

  it('falls back to second preferred slug when first is missing from catalog', () => {
    const result = resolveOnboardingRecommendations([], mockAlts, [
      { id: 'rocketchat', urn: 'rocketchat:ci-marketplace', name: 'Rocket.Chat', icon: '/r.png' },
      ...mockStoreApps.filter((a) => a.id !== 'mattermost'),
    ]);

    const social = result.find((r) => r.category === 'social');
    expect(social?.alternatives[0]?.appSlug).toBe('rocketchat');
  });

  it('excludes alternatives already running on the host', () => {
    const result = resolveOnboardingRecommendations(['Immich'], mockAlts, mockStoreApps);

    expect(result.find((r) => r.category === 'media')).toBeUndefined();
    expect(result.find((r) => r.category === 'social')).toBeDefined();
  });

  it('boosts picks when detected services match proprietary targets', () => {
    const result = resolveOnboardingRecommendations(['Slack'], mockAlts, mockStoreApps);

    const social = result.find((r) => r.category === 'social');
    expect(social?.boosted).toBe(true);
    expect(result[0]?.category).toBe('social');
  });

  it('enriches proprietary names from alternatives.json when available', () => {
    const result = resolveOnboardingRecommendations([], mockAlts, mockStoreApps);
    const social = result.find((r) => r.category === 'social');

    expect(social?.proprietary).toContain('Slack');
  });
});
