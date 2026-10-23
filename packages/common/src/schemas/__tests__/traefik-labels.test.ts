/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose expansions, written as a manifest writes them */
import { describe, expect, it } from 'vitest';
import { collectTraefikLabelIssues } from '../traefik-labels.js';

const messages = (labels: Record<string, string | boolean>, appId?: string) =>
  collectTraefikLabelIssues(labels, appId).map(({ label, message }) => [label, message]);

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

  it.each([
    // Matched before every HTTP router on the same entry point.
    'traefik.tcp.routers.{{CI_HUB_APP_ID}}.rule',
    'Traefik.TCP.Routers.{{CI_HUB_APP_ID}}.rule',
    'traefik.udp.services.{{CI_HUB_APP_ID}}.loadbalancer.server.port',
    'traefik.docker.network',
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

  // compose expands a host variable the Hub left unset from wherever else it finds it, or to nothing.
  describe('with the hosts the Hub set for the app', () => {
    const rules = (value: string, hostVariables: string[]) =>
      collectTraefikLabelIssues({ 'traefik.http.routers.{{CI_HUB_APP_ID}}-web.rule': value }, 'app-home', { hostVariables }).map(
        ({ message }) => message,
      );

    it('takes a rule that names only those hosts', () => {
      expect(rules('Host(`${APP_DOMAIN}`) && PathPrefix(`/api`)', ['APP_DOMAIN'])).toEqual([]);
      expect(rules('Host(`${APP_LOCAL_DOMAIN}`) || Host(`${APP_BASE_HOST}`)', ['APP_DOMAIN', 'APP_LOCAL_DOMAIN', 'APP_BASE_HOST'])).toEqual([]);
    });

    it.each([
      ['Host(`${APP_LOCAL_DOMAIN}`)', ['APP_DOMAIN', 'APP_BASE_HOST']],
      ['Host(`${APP_LOCAL_DOMAIN}`) || Host(`${APP_BASE_HOST}`)', ['APP_BASE_HOST']],
      ['Host(`${APP_DOMAIN}`) && PathPrefix(`/api`)', []],
      // Only the three host variables count as hosts.
      ['Host(`${APP_ID}`)', ['APP_ID', 'APP_DOMAIN']],
    ])('refuses %s when the Hub set only %j', (value, hostVariables) => {
      expect(rules(value, hostVariables)).toEqual(['CUSTOM_APP_ERROR_TRAEFIK_RULE_NOT_OWN_HOST']);
    });

    it('takes all three when the caller doesn’t say', () => {
      expect(
        collectTraefikLabelIssues(
          { 'traefik.http.routers.{{CI_HUB_APP_ID}}.rule': 'Host(`${APP_LOCAL_DOMAIN}`) || Host(`${APP_BASE_HOST}`)' },
          'app-home',
        ),
      ).toEqual([]);
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

  /*
   * An app's id is its name and its store's slug joined by a dash. Both may hold dashes. The same app
   * in stores `home` and `home-lab` is `app-home` and `app-home-lab`, so `app-home` and a dash begin
   * the other app's id. So do its other names.
   */
  describe('with the ids of the other apps the Hub knows', () => {
    const owned = (labels: Record<string, string | boolean>, appId: string, knownAppIds: string[]) =>
      collectTraefikLabelIssues(labels, appId, { knownAppIds }).map(({ label, message, params }) => [label, message, params.owner]);

    it('gives a name to the app with the longer id that covers it', () => {
      expect(
        owned(
          {
            'traefik.http.routers.{{CI_HUB_APP_ID}}-lab.rule': 'Host(`${APP_DOMAIN}`)',
            'traefik.http.services.{{CI_HUB_APP_ID}}-lab-web.loadbalancer.server.port': '80',
            'traefik.http.middlewares.app-home-lab-strip.stripprefix.prefixes': '/x',
            'traefik.http.routers.{{CI_HUB_APP_ID}}-side.service': '{{CI_HUB_APP_ID}}-lab-web',
            'traefik.http.routers.{{CI_HUB_APP_ID}}-side.middlewares': 'ci-hub@file,${APP_ID}-lab-strip@docker',
          },
          'app-home',
          ['app-home', 'app-home-lab'],
        ),
      ).toEqual([
        ['traefik.http.routers.{{CI_HUB_APP_ID}}-lab.rule', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', 'app-home-lab'],
        ['traefik.http.services.{{CI_HUB_APP_ID}}-lab-web.loadbalancer.server.port', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', 'app-home-lab'],
        ['traefik.http.middlewares.app-home-lab-strip.stripprefix.prefixes', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', 'app-home-lab'],
        ['traefik.http.routers.{{CI_HUB_APP_ID}}-side.service', 'CUSTOM_APP_ERROR_TRAEFIK_SERVICE_NOT_OWN', 'app-home-lab'],
        ['traefik.http.routers.{{CI_HUB_APP_ID}}-side.middlewares', 'CUSTOM_APP_ERROR_TRAEFIK_MIDDLEWARE_NOT_OWN', 'app-home-lab'],
      ]);
    });

    it('keeps the names the longer id does not cover', () => {
      expect(
        owned(
          {
            'traefik.http.routers.{{CI_HUB_APP_ID}}.rule': 'Host(`${APP_DOMAIN}`)',
            'traefik.http.routers.{{CI_HUB_APP_ID}}-web.service': '{{CI_HUB_APP_ID}}-web',
            // `app-home-labs` is not `app-home-lab` followed by a dash.
            'traefik.http.services.{{CI_HUB_APP_ID}}-labs.loadbalancer.server.port': '80',
            'traefik.http.routers.app-home-admin.middlewares': '${APP_ID}-strip@docker,ci-hub@docker',
          },
          'app-home',
          ['app-home-lab'],
        ),
      ).toEqual([]);
    });

    it('leaves the app with the longer id its own names', () => {
      expect(
        owned(
          {
            'traefik.http.routers.{{CI_HUB_APP_ID}}.rule': 'Host(`${APP_DOMAIN}`)',
            'traefik.http.routers.{{CI_HUB_APP_ID}}-web.service': 'app-home-lab-web',
          },
          'app-home-lab',
          ['app-home', 'app-home-lab'],
        ),
      ).toEqual([]);
      // The shorter id's own names are not this app's: they don't start with its id.
      expect(owned({ 'traefik.http.routers.app-home-web.rule': 'Host(`${APP_DOMAIN}`)' }, 'app-home-lab', ['app-home'])).toEqual([
        ['traefik.http.routers.app-home-web.rule', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', undefined],
      ]);
    });

    it('names the longest of several ids that cover a name', () => {
      expect(
        owned({ 'traefik.http.routers.{{CI_HUB_APP_ID}}-lab-east-web.rule': 'Host(`${APP_DOMAIN}`)' }, 'app-home', [
          'app-home-lab',
          'app-home-lab-east',
          'app-home-labs',
        ]),
      ).toEqual([['traefik.http.routers.{{CI_HUB_APP_ID}}-lab-east-web.rule', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', 'app-home-lab-east']]);
    });

    it('reads the ids without regard to case, as Traefik reads names', () => {
      expect(owned({ 'traefik.http.routers.{{CI_HUB_APP_ID}}-LAB-web.rule': 'Host(`${APP_DOMAIN}`)' }, 'app-home', ['App-Home-Lab'])).toEqual([
        ['traefik.http.routers.{{CI_HUB_APP_ID}}-LAB-web.rule', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', 'app-home-lab'],
      ]);
    });

    it('keeps an app’s names when another app has the very same id', () => {
      const labels = {
        'traefik.http.routers.{{CI_HUB_APP_ID}}-web.rule': 'Host(`${APP_DOMAIN}`)',
        'traefik.http.routers.{{CI_HUB_APP_ID}}-web.service': '{{CI_HUB_APP_ID}}-web',
      };
      // `a-b` in store `c` and `a` in store `b-c` are both `a-b-c`.
      expect(owned(labels, 'a-b-c', ['a-b-c', 'a-b-c'])).toEqual([]);
    });

    // A store whose slug splits an official app's id at a dash: app `app` in a store `ci` is `app-ci`.
    it('gives the official store’s names to the official app', () => {
      expect(
        owned(
          {
            'traefik.http.routers.{{CI_HUB_APP_ID}}-marketplace.rule': 'Host(`${APP_DOMAIN}`)',
            'traefik.http.routers.{{CI_HUB_APP_ID}}-side.service': '{{CI_HUB_APP_ID}}-marketplace',
            'traefik.http.routers.{{CI_HUB_APP_ID}}-side.rule': 'Host(`${APP_DOMAIN}`)',
          },
          'app-ci',
          ['app-ci-marketplace', 'other-ci-marketplace'],
        ),
      ).toEqual([
        ['traefik.http.routers.{{CI_HUB_APP_ID}}-marketplace.rule', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', 'app-ci-marketplace'],
        ['traefik.http.routers.{{CI_HUB_APP_ID}}-side.service', 'CUSTOM_APP_ERROR_TRAEFIK_SERVICE_NOT_OWN', 'app-ci-marketplace'],
      ]);
    });

    it('accepts a custom app’s id written out', () => {
      expect(
        owned(
          {
            'traefik.http.routers.my-app-_user-admin.rule': 'Host(`${APP_DOMAIN}`) && PathPrefix(`/admin`)',
            'traefik.http.routers.my-app-_user-admin.service': 'my-app-_user-admin',
          },
          'my-app-_user',
          ['my-app-_user', 'my-_user', 'app-ci-marketplace'],
        ),
      ).toEqual([]);
    });

    /*
     * The Hub container defines the router, service and middleware `ci-hub` on the Docker provider,
     * and its files define `ci-hub-edge-headers`, `hub-service` and the rest. App `ci` in a store
     * `hub` is `ci-hub`, and app `ci` in a store `hub-edge` is `ci-hub-edge`.
     */
    it('gives the Hub its own names, also over an app id as long as one of them', () => {
      expect(
        owned(
          {
            'traefik.http.routers.{{CI_HUB_APP_ID}}.rule': 'Host(`${APP_DOMAIN}`)',
            'traefik.http.services.{{CI_HUB_APP_ID}}.loadbalancer.server.port': '80',
            'traefik.http.middlewares.{{CI_HUB_APP_ID}}-strip.stripprefix.prefixes': '/x',
          },
          'ci-hub',
          ['ci-hub'],
        ),
      ).toEqual([
        ['traefik.http.routers.{{CI_HUB_APP_ID}}.rule', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', 'the Hub'],
        ['traefik.http.services.{{CI_HUB_APP_ID}}.loadbalancer.server.port', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', 'the Hub'],
        ['traefik.http.middlewares.{{CI_HUB_APP_ID}}-strip.stripprefix.prefixes', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', 'the Hub'],
      ]);
      expect(
        owned(
          {
            'traefik.http.middlewares.{{CI_HUB_APP_ID}}-headers.headers.customrequestheaders.X-Test': 'x',
            'traefik.http.routers.{{CI_HUB_APP_ID}}-web.middlewares': '{{CI_HUB_APP_ID}}-headers@docker',
            'traefik.http.routers.{{CI_HUB_APP_ID}}.rule': 'Host(`${APP_DOMAIN}`)',
          },
          'ci-hub-edge',
          [],
        ),
      ).toEqual([
        [
          'traefik.http.middlewares.{{CI_HUB_APP_ID}}-headers.headers.customrequestheaders.X-Test',
          'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN',
          'the Hub',
        ],
        ['traefik.http.routers.{{CI_HUB_APP_ID}}-web.middlewares', 'CUSTOM_APP_ERROR_TRAEFIK_MIDDLEWARE_NOT_OWN', 'the Hub'],
      ]);
      expect(owned({ 'traefik.http.routers.{{CI_HUB_APP_ID}}.service': 'hub-service' }, 'hub-service', [])).toEqual([
        ['traefik.http.routers.{{CI_HUB_APP_ID}}.service', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', 'the Hub'],
      ]);
    });

    it('leaves an app whose id is longer than the Hub’s name its own names', () => {
      expect(
        owned(
          {
            'traefik.http.routers.{{CI_HUB_APP_ID}}.rule': 'Host(`${APP_DOMAIN}`)',
            'traefik.http.routers.{{CI_HUB_APP_ID}}-web.service': '{{CI_HUB_APP_ID}}',
          },
          'ci-hub-lab',
          [],
        ),
      ).toEqual([]);
      expect(owned({ 'traefik.http.routers.{{CI_HUB_APP_ID}}-web.rule': 'Host(`${APP_DOMAIN}`)' }, 'CI-Hub', [])).toEqual([
        ['traefik.http.routers.{{CI_HUB_APP_ID}}-web.rule', 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', 'the Hub'],
      ]);
    });

    it('leaves the check as it was without an app id', () => {
      expect(
        collectTraefikLabelIssues({ 'traefik.http.routers.{{CI_HUB_APP_ID}}-lab.rule': 'Host(`${APP_DOMAIN}`)' }, undefined, {
          knownAppIds: ['app-home-lab'],
        }),
      ).toEqual([]);
    });
  });
});
