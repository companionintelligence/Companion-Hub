import type { HubIntegration } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { describe, expect, it } from 'vitest';
import { appLinkNetworkName, isActiveLink, type LinkPlanApp, planAppLinks } from '../app-link-plan';

const app = (urn: string, hubIntegration?: HubIntegration): LinkPlanApp => ({ urn: urn as AppUrn, hubIntegration });
const links = (connects_to: unknown[] = [], accepts_from: unknown[] = []) => ({ links: { connects_to, accepts_from } }) as unknown as HubIntegration;

const RADARR = 'radarr:media';
const PROWLARR = 'prowlarr:media';
const MEMORY = { appUrn: 'ci-memory:ci-marketplace' as AppUrn, service: 'gateway' };

describe('planAppLinks', () => {
  it('links two apps of one store that name each other, under the name the consumer asked for', () => {
    const plans = planAppLinks(
      [app(RADARR, links([{ app: 'prowlarr', service: 'prowlarr' }])), app(PROWLARR, links([], [{ app: 'radarr' }]))],
      null,
      [],
    );

    expect(plans).toEqual([
      { consumerUrn: RADARR, providerUrn: PROWLARR, service: 'prowlarr', alias: 'prowlarr', status: 'mutual', reciprocal: true, sameStore: true },
    ]);
    expect(plans.map(isActiveLink)).toEqual([true]);
  });

  // A manifest cannot reach an app that did not ask for it.
  it('leaves a link only one side declares to the operator', () => {
    const [plan] = planAppLinks([app(RADARR, links([{ app: 'prowlarr', service: 'prowlarr' }])), app(PROWLARR)], null, []);

    expect(plan).toMatchObject({ status: 'needs-approval', reciprocal: false, sameStore: true });
    expect(plan && isActiveLink(plan)).toBe(false);
  });

  // A store cannot reach another store's apps without the operator, even when both name each other.
  it('leaves a link between two stores to the operator, even when both sides declare it', () => {
    const [plan] = planAppLinks(
      [
        app('sniffer:sketchy', links([{ app: 'prowlarr', store: 'media', service: 'prowlarr' }])),
        app(PROWLARR, links([], [{ app: 'sniffer', store: 'sketchy' }])),
      ],
      null,
      [],
    );

    expect(plan).toMatchObject({ providerUrn: PROWLARR, status: 'needs-approval', reciprocal: true, sameStore: false });
  });

  it('names the other app by its store too: a same-named app of another store is not the one asked for', () => {
    const [plan] = planAppLinks(
      [app(RADARR, links([{ app: 'prowlarr', service: 'prowlarr' }])), app('prowlarr:sketchy', links([], [{ app: 'radarr', store: 'media' }]))],
      null,
      [],
    );

    expect(plan).toMatchObject({ providerUrn: PROWLARR, status: 'provider-missing' });
  });

  it('makes a link the operator allowed, for the service and name it was allowed with only', () => {
    const apps = [app(RADARR, links([{ app: 'prowlarr', service: 'prowlarr' }])), app(PROWLARR)];
    const approval = { consumerUrn: RADARR, providerUrn: PROWLARR, service: 'prowlarr', alias: 'prowlarr' };

    expect(planAppLinks(apps, null, [approval])[0]).toMatchObject({ status: 'approved' });
    // The manifest now points the link at another service: ask again.
    expect(planAppLinks(apps, null, [{ ...approval, service: 'postgres' }])[0]).toMatchObject({ status: 'needs-approval' });
  });

  it('links every Companion Memory consumer to ci-memory’s gateway as ci-memory, and not ci-memory to itself', () => {
    const consumer = { memory: { url_env: 'CI_SERVER_URL', token_env: 'CI_SERVER_TOKEN' } } as unknown as HubIntegration;
    const plans = planAppLinks(
      [app('ci-openclaw:ci-marketplace', consumer), app('ci-memory:ci-marketplace', consumer), app('n8n:ci-marketplace')],
      MEMORY,
      [],
    );

    expect(plans).toEqual([
      {
        consumerUrn: 'ci-openclaw:ci-marketplace',
        providerUrn: 'ci-memory:ci-marketplace',
        service: 'gateway',
        alias: 'ci-memory',
        status: 'memory',
        reciprocal: true,
        sameStore: true,
      },
    ]);
  });

  it('ignores a link an app declares to itself', () => {
    expect(planAppLinks([app(RADARR, links([{ app: 'radarr', service: 'radarr' }]))], null, [])).toEqual([]);
  });
});

describe('appLinkNetworkName', () => {
  it('is the same for the same link and different for any other', () => {
    const plan = { consumerUrn: RADARR as AppUrn, providerUrn: PROWLARR as AppUrn, service: 'prowlarr', alias: 'prowlarr' };

    expect(appLinkNetworkName(plan)).toMatch(/^ci-hub-link_[0-9a-f]{16}$/);
    expect(appLinkNetworkName({ ...plan })).toBe(appLinkNetworkName(plan));
    expect(appLinkNetworkName({ ...plan, service: 'other' })).not.toBe(appLinkNetworkName(plan));
    expect(appLinkNetworkName({ ...plan, consumerUrn: 'sonarr:media' as AppUrn })).not.toBe(appLinkNetworkName(plan));
  });
});
