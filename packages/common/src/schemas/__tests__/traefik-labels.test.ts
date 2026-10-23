/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose expansions, written as a manifest writes them */
import { describe, expect, it } from 'vitest';
import { collectTraefikLabelIssues } from '../traefik-labels.js';

const messages = (labels: Record<string, string | boolean>, appId?: string, hubNetworks?: readonly string[]) =>
  collectTraefikLabelIssues(labels, appId, { hubNetworks }).map(({ label, message }) => [label, message]);

describe('collectTraefikLabelIssues', () => {
  // The shapes the store apps that set Traefik labels use, one per kind.
  it.each([
    [
      'Donetick: a chain on the Hub router and its own middleware',
      {
        'traefik.http.middlewares.{{CI_HUB_APP_ID}}-public-host.headers.customrequestheaders.X-Forwarded-Host': '${APP_BASE_HOST}',
        'traefik.http.routers.{{CI_HUB_APP_ID}}.middlewares': 'ci-hub@file,{{CI_HUB_APP_ID}}-public-host@docker',
        'traefik.http.routers.{{CI_HUB_APP_ID}}-insecure.middlewares': 'ci-hub@file,{{CI_HUB_APP_ID}}-public-host@docker',
      },
    ],
    [
      'Kimai: its LAN name on the Hub router',
      { 'traefik.http.routers.{{CI_HUB_APP_ID}}.rule': 'Host(`${APP_LOCAL_DOMAIN}`) || Host(`${APP_BASE_HOST}`)' },
    ],
    [
      'Koodo Reader: a router of its own on part of its host',
      {
        'traefik.http.routers.{{CI_HUB_APP_ID}}-api.rule':
          'Host(`${APP_DOMAIN}`) && (PathPrefix(`/upload`) || PathPrefix(`/download`) || PathPrefix(`/opds`))',
        'traefik.http.routers.{{CI_HUB_APP_ID}}-api.entrypoints': 'web',
        'traefik.http.routers.{{CI_HUB_APP_ID}}-api.service': '{{CI_HUB_APP_ID}}-api',
        'traefik.http.routers.{{CI_HUB_APP_ID}}-api-secure.tls': 'true',
        'traefik.http.routers.{{CI_HUB_APP_ID}}-api-secure.priority': '100',
        'traefik.http.services.{{CI_HUB_APP_ID}}-api.loadbalancer.server.port': '8080',
      },
    ],
    [
      'FreePBX: middlewares named through ${APP_ID}',
      {
        'traefik.http.middlewares.{{CI_HUB_APP_ID}}-M1.compress': 'true',
        'traefik.http.routers.{{CI_HUB_APP_ID}}.middlewares': '${APP_ID}-M1,${APP_ID}-M2',
      },
    ],
    [
      'Claude Code: an HTTPS backend through the Hub transport',
      {
        'traefik.http.services.{{CI_HUB_APP_ID}}.loadbalancer.server.scheme': 'https',
        'traefik.http.services.{{CI_HUB_APP_ID}}.loadbalancer.serverstransport': 'insecuretransport@file',
      },
    ],
    [
      'Pocketbase: its own middleware before the Hub login',
      {
        'traefik.http.middlewares.{{CI_HUB_APP_ID}}-root-redirect.redirectregex.replacement': 'https://$${1}/_/',
        'traefik.http.routers.{{CI_HUB_APP_ID}}-local.middlewares': '{{CI_HUB_APP_ID}}-root-redirect@docker,ci-hub@docker',
      },
    ],
    ['traefik.enable and labels outside Traefik', { 'traefik.enable': true, 'com.example.team': 'web' }],
  ])('accepts %s', (_shape, labels) => {
    expect(collectTraefikLabelIssues(labels)).toEqual([]);
  });

  it('names the rule, the label and the name for a router that is not the app’s', () => {
    expect(collectTraefikLabelIssues({ 'traefik.http.routers.n8n-ci-marketplace.rule': 'Host(`${APP_DOMAIN}`)' })).toEqual([
      {
        label: 'traefik.http.routers.n8n-ci-marketplace.rule',
        message: 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN',
        params: { label: 'traefik.http.routers.n8n-ci-marketplace.rule', name: 'n8n-ci-marketplace', placeholder: '{{CI_HUB_APP_ID}}' },
      },
    ]);
  });

  it.each([
    'traefik.http.routers.web.rule',
    'traefik.http.services.n8n-ci-marketplace.loadbalancer.server.port',
    'traefik.http.middlewares.ci-hub.forwardauth.address',
    // Without a dash the id runs into the name, and `{{CI_HUB_APP_ID}}x` can be another app's id.
    'traefik.http.routers.{{CI_HUB_APP_ID}}x.rule',
    // Compose leaves keys as written, so ${APP_ID} is no id in one.
    'traefik.http.routers.${APP_ID}.rule',
  ])('refuses the name in %s', (label) => {
    expect(messages({ [label]: 'x' })).toEqual([[label, 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN']]);
  });

  // A container on more than one network needs it, or Traefik may pick one it can't reach.
  it.each(['ci-hub_network', 'ci-os-hub_network'])('keeps traefik.docker.network set to the Hub network %s', (network) => {
    expect(messages({ 'traefik.docker.network': network, 'Traefik.Docker.Network': network })).toEqual([]);
  });

  it.each([['another-app_network'], ['ci-hub_network2'], [' ci-hub_network'], ['${HUB_NET}'], [true]])(
    'refuses traefik.docker.network set to %s',
    (network) => {
      expect(collectTraefikLabelIssues({ 'traefik.docker.network': network })).toEqual([
        {
          label: 'traefik.docker.network',
          message: 'CUSTOM_APP_ERROR_TRAEFIK_NETWORK_NOT_HUB',
          params: { label: 'traefik.docker.network', networks: 'ci-hub_network, ci-os-hub_network' },
        },
      ]);
    },
  );

  it('takes the Hub networks the container is on from the caller', () => {
    expect(messages({ 'traefik.docker.network': 'hub2_network' }, undefined, ['hub2_network'])).toEqual([]);
    expect(messages({ 'traefik.docker.network': 'ci-hub_network' }, undefined, ['hub2_network'])).toEqual([
      ['traefik.docker.network', 'CUSTOM_APP_ERROR_TRAEFIK_NETWORK_NOT_HUB'],
    ]);
    // A service the Hub keeps off its networks has none to name.
    expect(messages({ 'traefik.docker.network': 'ci-hub_network' }, undefined, [])).toEqual([
      ['traefik.docker.network', 'CUSTOM_APP_ERROR_TRAEFIK_NETWORK_NOT_HUB'],
    ]);
  });

  it.each([
    // Matched before every HTTP router on the same entry point.
    'traefik.tcp.routers.{{CI_HUB_APP_ID}}.rule',
    'Traefik.TCP.Routers.{{CI_HUB_APP_ID}}.rule',
    'traefik.udp.services.{{CI_HUB_APP_ID}}.loadbalancer.server.port',
    'traefik.docker.allownonrunning',
    'traefik.http.services.{{CI_HUB_APP_ID}}.loadbalancer.server.url',
    'traefik.http.services.{{CI_HUB_APP_ID}}.weighted.services[0].name',
    // The Hub's login is the only forward auth on an app's routes.
    'traefik.http.middlewares.{{CI_HUB_APP_ID}}-auth.forwardauth.address',
    'traefik.http.middlewares.{{CI_HUB_APP_ID}}-auth.forwardAuth.trustForwardHeader',
    // A request keeps the host the visitor asked for, which the Hub's login goes by.
    'traefik.http.middlewares.{{CI_HUB_APP_ID}}-host.headers.customrequestheaders.Host',
  ])('refuses %s whatever it holds', (label) => {
    expect(messages({ [label]: 'http://ci-hub:5002' })).toEqual([[label, 'CUSTOM_APP_ERROR_TRAEFIK_LABEL_NOT_ALLOWED']]);
  });

  it.each([
    ['another app’s service', 'n8n-ci-marketplace'],
    ['another app’s service on the Docker provider', 'n8n-ci-marketplace@docker'],
    ['Traefik’s own API', 'api@internal'],
    ['a service of the Hub’s file provider', 'ci-hub-app-starting@file'],
    ['its own name on another provider', '{{CI_HUB_APP_ID}}@file'],
    ['a name that only starts like its id', '${APP_ID}x'],
  ])('refuses a router that sends traffic to %s', (_target, target) => {
    const label = 'traefik.http.routers.{{CI_HUB_APP_ID}}-x.service';

    expect(collectTraefikLabelIssues({ [label]: target })).toEqual([
      { label, message: 'CUSTOM_APP_ERROR_TRAEFIK_SERVICE_NOT_OWN', params: { label, target, placeholder: '{{CI_HUB_APP_ID}}' } },
    ]);
  });

  // TraefikConfigService copies routers into the file provider by the option's last part.
  it.each([
    ['traefik.http.routers.{{CI_HUB_APP_ID}}-x.extra.rule', 'Host(`n8n-hub1-acme.ci.lan`)', 'CUSTOM_APP_ERROR_TRAEFIK_RULE_NOT_OWN_HOST'],
    [
      'traefik.http.routers.{{CI_HUB_APP_ID}}-x.extra.middlewares',
      'n8n-ci-marketplace-public-host@docker',
      'CUSTOM_APP_ERROR_TRAEFIK_MIDDLEWARE_NOT_OWN',
    ],
  ])('refuses %s, which the Hub’s file-provider copy reads as the option it ends with', (label, value, message) => {
    expect(messages({ [label]: value })).toEqual([[label, message]]);
  });

  it('keeps headers other than Host on the app’s own middlewares', () => {
    expect(
      collectTraefikLabelIssues({
        'traefik.http.middlewares.{{CI_HUB_APP_ID}}-h.headers.customrequestheaders.X-Forwarded-Host': '${APP_BASE_HOST}',
        'traefik.http.middlewares.{{CI_HUB_APP_ID}}-h.headers.customresponseheaders.Host': 'x',
      }),
    ).toEqual([]);
  });

  it('refuses an errors middleware that answers with another app’s service', () => {
    const label = 'traefik.http.middlewares.{{CI_HUB_APP_ID}}-oops.errors.service';

    expect(messages({ [label]: 'n8n-ci-marketplace' })).toEqual([[label, 'CUSTOM_APP_ERROR_TRAEFIK_SERVICE_NOT_OWN']]);
  });

  it.each([
    [
      'traefik.http.routers.{{CI_HUB_APP_ID}}.middlewares',
      'ci-hub@file,n8n-ci-marketplace-public-host@docker',
      'n8n-ci-marketplace-public-host@docker',
    ],
    ['traefik.http.routers.{{CI_HUB_APP_ID}}.middlewares', '{{CI_HUB_APP_ID}}-a, other@file', 'other@file'],
    ['traefik.http.middlewares.{{CI_HUB_APP_ID}}-all.chain.middlewares', 'n8n-ci-marketplace-errors', 'n8n-ci-marketplace-errors'],
    // A compose expansion after the id: compose expands it after the check, so it can't be checked.
    ['traefik.http.routers.{{CI_HUB_APP_ID}}.middlewares', '${APP_ID}-${M}', '${APP_ID}-${M}'],
    ['traefik.http.routers.{{CI_HUB_APP_ID}}.middlewares', '{{CI_HUB_APP_ID}}-${M}@docker', '{{CI_HUB_APP_ID}}-${M}@docker'],
  ])('refuses %s set to %s', (label, value, target) => {
    expect(collectTraefikLabelIssues({ [label]: value })).toEqual([
      { label, message: 'CUSTOM_APP_ERROR_TRAEFIK_MIDDLEWARE_NOT_OWN', params: { label, target, placeholder: '{{CI_HUB_APP_ID}}' } },
    ]);
  });

  describe('router rules', () => {
    const rule = (value: string | boolean) => messages({ 'traefik.http.routers.{{CI_HUB_APP_ID}}.rule': value });
    const refused = [['traefik.http.routers.{{CI_HUB_APP_ID}}.rule', 'CUSTOM_APP_ERROR_TRAEFIK_RULE_NOT_OWN_HOST']];

    it.each([
      'Host(`${APP_DOMAIN}`)',
      'Host("${APP_DOMAIN}")',
      'Host(`${APP_DOMAIN}`, `${APP_LOCAL_DOMAIN}`)',
      '(Host(`${APP_DOMAIN}`) || Host(`${APP_LOCAL_DOMAIN}`)) && !PathPrefix(`/admin`)',
      'PathPrefix(`/api`) && Host(`${APP_DOMAIN}`)',
      'HostHeader(`${APP_DOMAIN}`)',
    ])('accepts %s', (value) => {
      expect(rule(value)).toEqual([]);
    });

    it.each([
      ['a literal host, which could be another app’s', 'Host(`n8n.example.com`)'],
      ['one own host and one literal', 'Host(`${APP_DOMAIN}`, `n8n.example.com`)'],
      ['no host at all, which matches every app’s', 'PathPrefix(`/`)'],
      ['a branch with no host', 'Host(`${APP_DOMAIN}`) || PathPrefix(`/api`)'],
      ['only a negated host', '!Host(`${APP_DOMAIN}`)'],
      ['another host even under a negation', 'Host(`${APP_DOMAIN}`) && !Host(`n8n.example.com`)'],
      ['a host pattern', 'HostRegexp(`.+`)'],
      ['a host pattern beside its own host', 'Host(`${APP_DOMAIN}`) && HostRegexp(`.+`)'],
      ['an SNI match beside its own host', 'Host(`${APP_DOMAIN}`) && HostSNI(`*`)'],
      ['another expansion compose would change after the check', 'Host(`${APP_DOMAIN}`) && Path(`${X:-/`)'],
      ['an expansion standing in for a host', 'Host(`${OTHER_APP_DOMAIN}`)'],
      ['the Hub’s local domain', 'Host(`n8n.${LOCAL_DOMAIN}`)'],
      ['an empty host list', 'Host()'],
      ['text it can’t read', 'Host(`${APP_DOMAIN}`) &&'],
      ['an unclosed string', 'Host(`${APP_DOMAIN})'],
      ['a value that is no rule', true],
      ['nesting past any rule a person writes', `${'('.repeat(40)}Host(\`\${APP_DOMAIN}\`)${')'.repeat(40)}`],
    ])('refuses %s', (_why, value) => {
      expect(rule(value)).toEqual(refused);
    });
  });

  describe('with the app id the builder knows', () => {
    it('accepts the id written out', () => {
      expect(
        collectTraefikLabelIssues(
          {
            'traefik.http.routers.my-app-_user-admin.rule': 'Host(`${APP_DOMAIN}`) && PathPrefix(`/admin`)',
            'traefik.http.routers.my-app-_user-admin.service': 'my-app-_user-admin',
          },
          'my-app-_user',
        ),
      ).toEqual([]);
    });

    it('still refuses another app’s id', () => {
      expect(messages({ 'traefik.http.routers.n8n-ci-marketplace.rule': 'Host(`${APP_DOMAIN}`)' }, 'my-app-_user')).toEqual([
        ['traefik.http.routers.n8n-ci-marketplace.rule', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN'],
      ]);
    });
  });
});
