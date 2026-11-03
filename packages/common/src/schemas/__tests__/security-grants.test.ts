import { describe, expect, it } from 'vitest';

import { dynamicComposeUnion, dynamicComposeUnionFor, TRUSTED_APP_SECURITY_ALLOWLIST } from '../dynamic-compose.js';
import { parseComposeJson, parseInstalledComposeJson } from '../utils/convert-legacy-schema.js';

/** A minimal schemaVersion 2 compose whose main service carries the given fields. */
const compose = (service: Record<string, unknown> = {}, overrides?: unknown) => ({
  schemaVersion: 2,
  services: [{ name: 'main', image: 'example/app:1.0.0', isMain: true, ...service }],
  ...(overrides ? { overrides } : {}),
});

const dockerSock = { hostPath: '/var/run/docker.sock', containerPath: '/var/run/docker.sock' };

describe.each([
  { name: 'parseComposeJson', parse: parseComposeJson },
  { name: 'parseInstalledComposeJson', parse: parseInstalledComposeJson },
])('$name with sandbox grants', ({ parse }) => {
  it('lets an allowlisted host bind through with its grant', () => {
    expect(() => parse(compose({ volumes: [dockerSock] }), TRUSTED_APP_SECURITY_ALLOWLIST.coder)).not.toThrow();
  });

  it('refuses the same host bind without a grant', () => {
    expect(() => parse(compose({ volumes: [dockerSock] }))).toThrow(/CUSTOM_APP_ERROR_HOST_PATH_DENIED/);
  });

  it('lets a privileged service through with the privileged grant', () => {
    expect(() => parse(compose({ privileged: true }), TRUSTED_APP_SECURITY_ALLOWLIST['duix-avatar'])).not.toThrow();
  });

  it('refuses a privileged service without the privileged grant', () => {
    expect(() => parse(compose({ privileged: true }))).toThrow(/CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED/);
  });

  it('keeps refusing privileged when the grant only covers host paths', () => {
    expect(() => parse(compose({ privileged: true }), TRUSTED_APP_SECURITY_ALLOWLIST.coder)).toThrow(/CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED/);
  });

  it('keeps refusing a host path the grant does not name', () => {
    const root = { hostPath: '/', containerPath: '/host' };
    expect(() => parse(compose({ volumes: [root] }), TRUSTED_APP_SECURITY_ALLOWLIST.coder)).toThrow(/CUSTOM_APP_ERROR_HOST_PATH_DENIED/);
  });

  it('matches a granted host path that carries a compose expansion, as written', () => {
    const navidrome = { hostPath: '${NAVIDROME_MUSIC_FOLDER:-${APP_DATA_DIR}/music}', containerPath: '/music' };
    expect(() => parse(compose({ volumes: [navidrome] }), TRUSTED_APP_SECURITY_ALLOWLIST.navidrome)).not.toThrow();
    expect(() => parse(compose({ volumes: [navidrome] }))).toThrow(/CUSTOM_APP_ERROR_HOST_PATH_DENIED/);
  });

  it('applies the grant to override services as well', () => {
    const data = compose({}, [{ services: [{ privileged: true }] }]);
    expect(() => parse(data, TRUSTED_APP_SECURITY_ALLOWLIST['duix-avatar'])).not.toThrow();
    expect(() => parse(data)).toThrow(/CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED/);
  });
});

describe('the strict default', () => {
  it('is the strict union when no grants are passed', () => {
    expect(dynamicComposeUnionFor()).toBe(dynamicComposeUnion);
    expect(dynamicComposeUnionFor(undefined)).toBe(dynamicComposeUnion);
  });

  it('builds a granted union once per grant object', () => {
    const grants = TRUSTED_APP_SECURITY_ALLOWLIST.refly;
    expect(dynamicComposeUnionFor(grants)).not.toBe(dynamicComposeUnion);
    expect(dynamicComposeUnionFor(grants)).toBe(dynamicComposeUnionFor(grants));
  });
});
