import { describe, expect, it } from 'vitest';
import { collectComposeOverrideViolations, describeComposeOverrideViolations } from '../compose-override-sandbox';

const CUSTOM_APP = 'plain-app:_user' as never;
const OFFICIAL_APP = (name: string) => `${name}:ci-marketplace` as never;

const check = (override: string, appEnv = '', appUrn = CUSTOM_APP) =>
  collectComposeOverrideViolations(override, appEnv, { appUrn, hubEnvironment: ['HUB_ONLY_VALUE'] });
const rules = (override: string, appEnv = '', appUrn = CUSTOM_APP) => check(override, appEnv, appUrn).map((violation) => violation.rule);
const service = (body: string) => `services:\n  web:\n${body.replace(/^/gm, '    ')}\n`;

describe('collectComposeOverrideViolations', () => {
  describe('the builder rules', () => {
    it.each([
      ['privileged', 'privileged: true', 'CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED'],
      ['a privileged string', 'privileged: "yes"', 'CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED'],
      ['a privileged variable', 'privileged: ${ANYTHING}', 'CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED'],
      ['a capability', 'cap_add: [SYS_ADMIN]', 'CUSTOM_APP_ERROR_CAP_ADD_NOT_ALLOWED'],
      ['a lower-case capability', 'cap_add: [cap_sys_admin]', 'CUSTOM_APP_ERROR_CAP_ADD_NOT_ALLOWED'],
      ['the host pid namespace', 'pid: host', 'CUSTOM_APP_ERROR_PID_HOST_NOT_ALLOWED'],
      ['the host network', 'network_mode: host', 'CUSTOM_APP_ERROR_NETWORK_MODE_HOST_NOT_ALLOWED'],
      ['a named network mode', 'network_mode: some_network', 'CUSTOM_APP_ERROR_NETWORK_MODE_NOT_ALLOWED'],
      ['an unconfined security option', 'security_opt: ["seccomp:unconfined"]', 'CUSTOM_APP_ERROR_SECURITY_OPT_NOT_ALLOWED'],
      ['a block device', 'devices: ["/dev/sda:/dev/sda"]', 'CUSTOM_APP_ERROR_DEVICE_NOT_ALLOWED'],
      ['a block device in long form', 'devices:\n  - source: /dev/sda\n    target: /dev/sda', 'CUSTOM_APP_ERROR_DEVICE_NOT_ALLOWED'],
      ['a system folder', 'volumes: ["/etc:/config"]', 'CUSTOM_APP_ERROR_HOST_PATH_DENIED'],
      ['the Docker socket', 'volumes: ["/var/run/docker.sock:/sock"]', 'CUSTOM_APP_ERROR_HOST_PATH_DENIED'],
      [
        'the Docker socket in long form',
        'volumes:\n  - type: bind\n    source: /var/run/docker.sock\n    target: /sock',
        'CUSTOM_APP_ERROR_HOST_PATH_DENIED',
      ],
      ['a path that climbs', 'volumes: ["../..:/x"]', 'CUSTOM_APP_ERROR_HOST_PATH_DENIED'],
      ['a path from a variable', 'volumes: ["${ANYTHING}:/x"]', 'CUSTOM_APP_ERROR_HOST_PATH_DENIED'],
      ['a mount that is all variable', 'volumes: ["${ANYTHING}"]', 'CUSTOM_APP_ERROR_HOST_PATH_DENIED'],
      ['a reserved label', 'labels:\n  ci-hub.appurn: other', 'CUSTOM_APP_ERROR_LABEL_RESERVED'],
      ['a reserved label in list form', 'labels:\n  - ci-hub.appurn=other', 'CUSTOM_APP_ERROR_LABEL_RESERVED'],
    ])('refuses %s', (_name, body, rule) => {
      expect(rules(service(body))).toContain(rule);
    });

    it('refuses a Traefik label that reaches past the app', () => {
      expect(rules(service('labels:\n  traefik.http.routers.other.rule: Host(`example.com`)'))).not.toEqual([]);
    });

    it('checks a service the override adds', () => {
      expect(rules('services:\n  sidecar:\n    image: alpine\n    privileged: true\n')).toContain('CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED');
    });

    it('keeps what an official app is granted, and only that', () => {
      expect(check(service('volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"]'), '', OFFICIAL_APP('netdata'))).toEqual([]);
      expect(rules(service('volumes: ["/etc:/config"]'), '', OFFICIAL_APP('netdata'))).toContain('CUSTOM_APP_ERROR_HOST_PATH_DENIED');
      expect(check(service('cap_add: [NET_ADMIN]'), '', OFFICIAL_APP('wireguard'))).toEqual([]);
      expect(check(service('privileged: true\ncap_add: [NET_ADMIN]'), '', OFFICIAL_APP('home-assistant'))).toEqual([]);
    });

    it('does not extend an official app’s grant to a custom app of the same name', () => {
      expect(rules(service('volumes: ["/var/run/docker.sock:/s"]'), '', 'netdata:_user' as never)).toContain('CUSTOM_APP_ERROR_HOST_PATH_DENIED');
    });
  });

  describe('what only an override can say', () => {
    it.each([
      'build',
      'cgroup',
      'cgroup_parent',
      'configs',
      'credential_spec',
      'develop',
      'device_cgroup_rules',
      'env_file',
      'extends',
      'external_links',
      'label_file',
      'models',
      'post_start',
      'pre_stop',
      'provider',
      'secrets',
      'use_api_socket',
      'userns_mode',
      'uts',
    ])('refuses the %s key', (key) => {
      expect(rules(service(`${key}: {}`))).toEqual(['COMPOSE_OVERRIDE_SETTING_NOT_ALLOWED']);
    });

    it.each(['include', 'secrets', 'configs', 'models', 'name'])('refuses the top-level %s key', (key) => {
      expect(rules(`${key}: {}\n`)).toEqual(['COMPOSE_OVERRIDE_SETTING_NOT_ALLOWED']);
    });

    it('refuses a key in another case', () => {
      expect(rules(service('Privileged: true'))).toContain('COMPOSE_OVERRIDE_SETTING_NOT_ALLOWED');
    });

    it.each([
      ['host', 'COMPOSE_OVERRIDE_IPC_NOT_ALLOWED'],
      ['container:other', 'COMPOSE_OVERRIDE_IPC_NOT_ALLOWED'],
      ['${ANYTHING}', 'COMPOSE_OVERRIDE_VARIABLE_NOT_ALLOWED'],
    ])('refuses ipc: %s', (value, rule) => {
      expect(rules(service(`ipc: "${value}"`))).toContain(rule);
    });

    it.each(['none', 'private', 'shareable', 'service:db'])('allows ipc: %s', (value) => {
      expect(check(service(`ipc: "${value}"`))).toEqual([]);
    });

    it.each([
      ['pid', 'pid: ${ANYTHING}'],
      ['security_opt', 'security_opt: ["${ANYTHING}"]'],
    ])('refuses a variable in %s', (_key, body) => {
      expect(rules(service(body))).toContain('COMPOSE_OVERRIDE_VARIABLE_NOT_ALLOWED');
    });

    it.each([
      ['a volume the driver options redirect', 'driver: local\n    driver_opts: {type: none}'],
      ['an external volume', 'external: true'],
      ['a volume with a name of its own', 'name: other'],
    ])('refuses %s', (_name, definition) => {
      expect(rules(`volumes:\n  data:\n    ${definition}\n`)).toEqual(['COMPOSE_OVERRIDE_VOLUME_DEFINITION_NOT_ALLOWED']);
    });

    it('refuses a mount of another container', () => {
      expect(rules(service('volumes_from: ["container:other:ro"]'))).toEqual(['COMPOSE_OVERRIDE_VOLUMES_FROM_NOT_ALLOWED']);
    });

    it('refuses a volume type it does not know', () => {
      expect(rules(service('volumes:\n  - type: image\n    source: alpine\n    target: /x'))).toEqual(['COMPOSE_OVERRIDE_VOLUME_TYPE_NOT_ALLOWED']);
    });

    it('refuses an external network', () => {
      expect(rules('services:\n  web:\n    networks: [outside]\nnetworks:\n  outside:\n    external: true\n')).toContain(
        'COMPOSE_OVERRIDE_NETWORK_NOT_ALLOWED',
      );
    });

    it('refuses declaring a Hub network to join it', () => {
      expect(rules('services:\n  web:\n    networks: [ci-hub_network]\nnetworks:\n  ci-hub_network:\n')).toContain(
        'COMPOSE_OVERRIDE_NETWORK_NOT_ALLOWED',
      );
    });

    it('refuses a network the override does not declare', () => {
      expect(rules(service('networks: [ci-hub_network]'))).toEqual(['COMPOSE_OVERRIDE_NETWORK_NOT_ALLOWED']);
    });

    it('refuses per-network options', () => {
      expect(rules(service('networks:\n  plain-app__user_network:\n    aliases: [other]'))).toEqual(['COMPOSE_OVERRIDE_NETWORK_NOT_ALLOWED']);
    });

    it('allows the app’s own network and one the override declares', () => {
      expect(check('services:\n  web:\n    networks: [plain-app__user_network, default, extra]\nnetworks:\n  extra:\n')).toEqual([]);
    });
  });

  describe('spellings that hide a key', () => {
    it.each([
      ['a merge key', 'x-a: &a {privileged: true}\nservices:\n  web:\n    <<: *a\n'],
      ['a merge list', 'x-a: &a {privileged: true}\nx-b: &b {image: alpine}\nservices:\n  web:\n    <<: [*a, *b]\n'],
      ['a nested merge', 'x-a: &a {privileged: true}\nx-b: &b {<<: *a}\nservices:\n  web:\n    <<: *b\n'],
      ['a merge into services', 'x-w: &w\n  web:\n    privileged: true\nservices:\n  <<: *w\n'],
      ['an aliased service', 'x-s: &s {privileged: true}\nservices:\n  web: *s\n'],
      ['an aliased value', 'x-v: &v true\nservices:\n  web:\n    privileged: *v\n'],
      ['a quoted key', 'services:\n  web:\n    "privileged": true\n'],
      ['an escaped key', 'services:\n  web:\n    "priv\\u0069leged": true\n'],
      ['flow style', 'services: {web: {privileged: true}}\n'],
      ['an explicit key', 'services:\n  web:\n    ? privileged\n    : true\n'],
    ])('sees privileged behind %s', (_name, override) => {
      expect(rules(override)).toContain('CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED');
    });

    it('takes the merged value a local key sets', () => {
      expect(check('x-a: &a {privileged: true}\nservices:\n  web:\n    <<: *a\n    privileged: false\n')).toEqual([]);
    });

    it.each([
      ['U+2028', '\u2028'],
      ['U+2029', '\u2029'],
      ['U+0085', '\u0085'],
      ['a lone CR', '\r'],
    ])('refuses a comment that %s would end for Compose', (_name, lineBreak) => {
      expect(rules(`services:\n  web:\n    image: alpine # note${lineBreak}    privileged: true\n`)).toContain('COMPOSE_OVERRIDE_UNREADABLE');
    });

    it('reads CRLF line endings', () => {
      expect(check('services:\r\n  web:\r\n    image: alpine\r\n')).toEqual([]);
    });

    it.each([
      ['a binary value', 'services:\n  web:\n    command: !!binary aGVsbG8=\n'],
      ['a binary key', 'services:\n  web:\n    !!binary aGVsbG8=: true\n'],
      ['a reset', 'services:\n  web:\n    labels: !reset null\n'],
      ['an override on anything but ports or environment', 'services:\n  web:\n    security_opt: !override []\n'],
    ])('refuses %s', (_name, override) => {
      expect(rules(override).some((rule) => ['COMPOSE_OVERRIDE_TAG_NOT_ALLOWED', 'COMPOSE_OVERRIDE_UNREADABLE'].includes(rule))).toBe(true);
    });

    it('allows !override on ports and environment', () => {
      expect(check(service('ports: !override\n  - "8080:80"\nenvironment: !override\n  FOO: bar'))).toEqual([]);
    });
  });

  describe('an override that cannot be read', () => {
    it.each([
      ['broken YAML', 'services:\n  web: ['],
      ['two documents', 'services:\n  web: {}\n---\nservices:\n  web: {}\n'],
      ['a YAML directive', '%YAML 1.1\n---\nservices:\n  web: {}\n'],
      ['a duplicate key', 'services:\n  web:\n    image: a\n    image: b\n'],
      ['a duplicate merge key', 'x-a: &a {}\nx-b: &b {}\nservices:\n  web:\n    <<: *a\n    <<: *b\n'],
      ['an unknown alias', 'services:\n  web:\n    <<: *missing\n'],
      ['a scalar', 'just text\n'],
      ['a list', '- a\n- b\n'],
      ['services that are not a mapping', 'services: [web]\n'],
      ['a service that is not a mapping', 'services:\n  web: text\n'],
      ['cap_add that is not a list', service('cap_add: SYS_ADMIN')],
      ['a volume that is not a string or mapping', service('volumes: [1]')],
      ['a drive letter volume', service('volumes: ["c:/etc:/x"]')],
      ['a volume with too many colons', service('volumes: ["/a:/b:ro:extra"]')],
    ])('fails closed on %s', (_name, override) => {
      expect(rules(override).length).toBeGreaterThan(0);
    });

    it('accepts an empty override', () => {
      expect(check('')).toEqual([]);
      expect(check('# just a comment\n')).toEqual([]);
    });
  });

  describe('variables', () => {
    it.each([
      ['an environment value', 'environment:\n  FOO: "${HUB_ONLY_VALUE}"'],
      ['a default inside a reference', 'environment:\n  FOO: "${MINE:-${HUB_ONLY_VALUE}}"'],
      ['a bare reference', 'command: ["echo", "$HUB_ONLY_VALUE"]'],
      ['a label value', 'labels:\n  foo: "${HUB_ONLY_VALUE}"'],
    ])('refuses a variable the Hub defines in %s', (_name, body) => {
      expect(rules(service(body))).toContain('COMPOSE_OVERRIDE_VARIABLE_NOT_ALLOWED');
    });

    it('leaves the app’s own variables and escaped dollars alone', () => {
      expect(check(service('environment:\n  FOO: "${MINE:-x}"\n  BAR: "$$HUB_ONLY_VALUE"'))).toEqual([]);
    });

    it.each([
      'APP_DATA_DIR=/elsewhere',
      'export APP_DATA_DIR=/elsewhere',
      '  APP_DATA_DIR = /elsewhere',
      'APP_DATA_DIR: /elsewhere',
      'FOO=1\r\nAPP_DATA_DIR=/elsewhere\r\n',
      '\ufeffAPP_DATA_DIR=/elsewhere',
      '\fAPP_DATA_DIR=/elsewhere',
      'APP_DATA_DIR\v=/elsewhere',
      '\u00a0APP_DATA_DIR=/elsewhere',
      'APP_DATA_DIR\u00a0=/elsewhere',
      '\u0085APP_DATA_DIR=/elsewhere',
      'export\fAPP_DATA_DIR=/elsewhere',
    ])('refuses an env file that sets the app data folder: %j', (appEnv) => {
      expect(rules('', appEnv)).toEqual(['COMPOSE_OVERRIDE_ENV_NAME_RESERVED']);
    });

    it.each(['APP_ID', 'APP_DOMAIN', 'APP_LOCAL_DOMAIN', 'APP_BASE_HOST', 'APP_URN'])('refuses an env file that sets %s', (name) => {
      expect(rules('', `${name}=hub.local\n`)).toEqual(['COMPOSE_OVERRIDE_ENV_NAME_RESERVED']);
    });

    it('leaves a commented-out line in the env file alone', () => {
      expect(check('', '# APP_DATA_DIR=/elsewhere\n# FOO=$HUB_ONLY_VALUE\n')).toEqual([]);
    });

    it.each(['COPY=${HUB_ONLY_VALUE}', 'COPY=$HUB_ONLY_VALUE', 'COPY=${MINE:-${HUB_ONLY_VALUE}}'])(
      'refuses an env file value that uses a variable the Hub defines: %s',
      (appEnv) => {
        expect(rules('', appEnv)).toEqual(['COMPOSE_OVERRIDE_VARIABLE_NOT_ALLOWED']);
      },
    );

    it('leaves the app’s own variables and escaped dollars in the env file alone', () => {
      expect(check('', 'FOO=${MINE}\nBAR=$$HUB_ONLY_VALUE\n')).toEqual([]);
    });

    it.each([
      ['a list', 'environment:\n  - HUB_ONLY_VALUE'],
      ['a mapping', 'environment:\n  HUB_ONLY_VALUE:'],
    ])('refuses a name with no value that the Hub defines, in %s', (_name, body) => {
      expect(rules(service(body))).toEqual(['COMPOSE_OVERRIDE_VARIABLE_NOT_ALLOWED']);
    });

    it('allows a name with no value that the Hub does not define, and an empty value', () => {
      expect(check(service('environment:\n  - MINE\n  - HUB_ONLY_VALUE='))).toEqual([]);
    });

    it('allows a variable every app is handed, though the Hub defines it too', () => {
      const appUrn = CUSTOM_APP;
      const override = service('environment:\n  ZONE: "${TZ}"\n  LOCAL_DOMAIN:');
      expect(collectComposeOverrideViolations(override, 'ZONE=${TZ}\n', { appUrn, hubEnvironment: ['TZ', 'LOCAL_DOMAIN'] })).toEqual([]);
    });

    it('allows other env file names', () => {
      expect(check('', 'APP_DATA_DIR_EXTRA=1\nFOO=bar\n')).toEqual([]);
    });

    it('still allows a mount under the app data folder', () => {
      expect(check(service('volumes: ["${APP_DATA_DIR}/extra:/extra"]'))).toEqual([]);
    });
  });

  it('lets a label pin Traefik to a Hub network and no other', () => {
    expect(check(service('labels:\n  traefik.docker.network: ci-hub_network'))).toEqual([]);
    expect(rules(service('labels:\n  traefik.docker.network: other'))).toEqual(['CUSTOM_APP_ERROR_TRAEFIK_NETWORK_NOT_HUB']);
  });

  describe('normal overrides', () => {
    it.each([
      ['environment', 'environment:\n  FOO: bar'],
      ['environment as a list', 'environment:\n  - FOO=bar'],
      ['ports', 'ports:\n  - "8080:80"\n  - target: 81\n    published: "8081"'],
      ['memory and CPU limits', 'mem_limit: 512m\nmemswap_limit: 1g\ncpus: "0.5"\npids_limit: 200'],
      [
        'deploy limits and GPU reservation',
        'deploy:\n  resources:\n    limits: {memory: 1g}\n    reservations:\n      devices:\n        - capabilities: [gpu]',
      ],
      ['an allowed bind', 'volumes: ["/home/me/media:/media:ro"]'],
      ['a bind of a timezone file', 'volumes: ["/etc/localtime:/etc/localtime:ro"]'],
      ['a mount under the app data folder', 'volumes: ["${APP_DATA_DIR}/extra:/extra"]'],
      ['a named volume', 'volumes: ["data:/data"]'],
      ['a long bind', 'volumes:\n  - type: bind\n    source: /home/me/media\n    target: /media'],
      ['a long volume', 'volumes:\n  - type: volume\n    source: data\n    target: /data'],
      ['a tmpfs', 'tmpfs: [/run]\nvolumes:\n  - type: tmpfs\n    target: /cache'],
      ['an anonymous volume', 'volumes: [/var/cache/app]'],
      ['GPU devices', 'devices: ["/dev/dri:/dev/dri", "/dev/kfd", "/dev/kvm:/dev/kvm"]'],
      ['a CDI device', 'devices: ["nvidia.com/gpu=all"]'],
      ['gpus', 'gpus: all'],
      ['a Kata runtime', 'runtime: kata-qemu'],
      ['a safe capability', 'cap_add: [CHOWN, NET_BIND_SERVICE]\ncap_drop: [ALL]'],
      ['no-new-privileges', 'security_opt: ["no-new-privileges:true"]'],
      ['a restart policy and healthcheck', 'restart: always\nhealthcheck:\n  test: ["CMD", "true"]'],
      ['extension fields', 'x-note: hello'],
      ['an anchored environment', 'environment: &e\n  FOO: bar\nlabels: *e'],
    ])('allows %s', (_name, body) => {
      expect(check(service(body))).toEqual([]);
    });

    it('allows a plain top-level volume and network, and a version line', () => {
      expect(check('version: "3.8"\nservices:\n  web:\n    volumes: ["data:/data"]\nvolumes:\n  data: {}\nnetworks:\n  extra:\n')).toEqual([]);
    });

    it('allows merge keys and anchors that stay inside the rules', () => {
      expect(check('x-env: &e\n  FOO: bar\nservices:\n  web:\n    environment:\n      <<: *e\n      BAZ: "1"\n')).toEqual([]);
    });
  });

  it('names each setting and the rule it broke', () => {
    const text = describeComposeOverrideViolations(check(service('privileged: true\ncap_add: [SYS_ADMIN]')));
    expect(text).toContain('services.web.privileged [CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED]');
    expect(text).toContain('services.web.cap_add.0 (SYS_ADMIN) [CUSTOM_APP_ERROR_CAP_ADD_NOT_ALLOWED]');
  });
});
