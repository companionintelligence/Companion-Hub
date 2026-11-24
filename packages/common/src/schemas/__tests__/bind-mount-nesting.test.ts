/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose expansions, written as a manifest writes them */
import { describe, expect, it } from 'vitest';
import { bindSourceKey, describeNestedBindMounts, findNestedBindMounts, type BindMountRef } from '../bind-mount-nesting';
import { customAppComposeSchema } from '../dynamic-compose';

const rw = (service: string, source: string): BindMountRef => ({ service, source, readOnly: false });
const ro = (service: string, source: string): BindMountRef => ({ service, source, readOnly: true });

const pairs = (mounts: BindMountRef[], grantedHostPaths?: string[]) =>
  findNestedBindMounts(mounts, { grantedHostPaths }).map(({ outer, inner }) => [outer.source, inner.source]);

describe('findNestedBindMounts', () => {
  it('refuses a folder inside one another service can write to (the database-inside-data shape)', () => {
    expect(pairs([rw('app', '${APP_DATA_DIR}/data'), rw('db', '${APP_DATA_DIR}/data/postgres')])).toEqual([
      ['${APP_DATA_DIR}/data', '${APP_DATA_DIR}/data/postgres'],
    ]);
  });

  it('refuses it within one service too, and for a single file mounted from inside', () => {
    expect(pairs([rw('app', '${APP_DATA_DIR}/data'), ro('app', '${APP_DATA_DIR}/data/config.yml')])).toEqual([
      ['${APP_DATA_DIR}/data', '${APP_DATA_DIR}/data/config.yml'],
    ]);
  });

  it('refuses a source several folders down', () => {
    expect(pairs([rw('app', '/srv/media'), rw('app', '/srv/media/tv/archive')])).toHaveLength(1);
  });

  it('allows sibling folders and the same folder in two services', () => {
    expect(
      pairs([
        rw('app', '${APP_DATA_DIR}/data/app'),
        rw('db', '${APP_DATA_DIR}/data/db'),
        rw('worker', '${APP_DATA_DIR}/data/app'),
        // A name that only starts like the folder is not inside it.
        rw('cache', '${APP_DATA_DIR}/data/app-cache'),
      ]),
    ).toEqual([]);
  });

  it('allows a folder inside one that every service mounts read-only', () => {
    expect(
      pairs([ro('nats', '${APP_DATA_DIR}/data/config'), ro('web', '${APP_DATA_DIR}/data/config'), rw('app', '${APP_DATA_DIR}/data/config/state')]),
    ).toEqual([]);
  });

  it('refuses when one service mounts the outer folder read-only and another writable', () => {
    expect(pairs([ro('web', '${APP_DATA_DIR}/data'), rw('app', '${APP_DATA_DIR}/data'), ro('web', '${APP_DATA_DIR}/data/static')])).toEqual([
      ['${APP_DATA_DIR}/data', '${APP_DATA_DIR}/data/static'],
    ]);
  });

  it('ignores slashes, a trailing slash and case, as a Mac or Windows disk does', () => {
    expect(pairs([rw('app', '${APP_DATA_DIR}//Data/'), rw('db', '${APP_DATA_DIR}\\data\\DB')])).toHaveLength(1);
  });

  it('does not refuse a granted host path as the outer folder', () => {
    expect(pairs([rw('files', '/'), rw('files', '${APP_DATA_DIR}/data')], ['/'])).toEqual([]);
    // Without the grant, `/` holds every other source.
    expect(pairs([rw('files', '/'), rw('files', '/app-data/x/data')])).toHaveLength(1);
  });

  it('names both mounts and who can write', () => {
    const nested = findNestedBindMounts([rw('app', '/a/data'), rw('db', '/a/data/db')]);
    expect(describeNestedBindMounts(nested)).toBe('"/a/data/db" (db) is inside "/a/data", which app can write to');
  });
});

describe('bindSourceKey', () => {
  it('keeps the root as the root', () => {
    expect(bindSourceKey('/')).toBe('/');
    expect(bindSourceKey('//')).toBe('/');
  });
});

describe('saving a custom app', () => {
  const service = (name: string, volumes: { hostPath: string; containerPath: string; readOnly?: boolean }[], isMain = false) => ({
    name,
    image: 'nginx:1.27-alpine',
    ...(isMain ? { isMain: true, internalPort: 80 } : {}),
    volumes,
  });
  const issues = (compose: unknown) => {
    const result = customAppComposeSchema.safeParse(compose);
    return result.success
      ? []
      : result.error.issues.filter((issue) => issue.message === 'CUSTOM_APP_ERROR_HOST_PATH_NESTED').map((issue) => issue.path.join('.'));
  };

  it('refuses the inner mount of a nested pair, at its own field', () => {
    expect(
      issues({
        schemaVersion: 2,
        services: [
          service('web', [{ hostPath: '${APP_DATA_DIR}/data', containerPath: '/data' }], true),
          service('db', [{ hostPath: '${APP_DATA_DIR}/data/db', containerPath: '/var/lib/db' }]),
        ],
      }),
    ).toEqual(['services.1.volumes.0.hostPath']);
  });

  it('refuses one an architecture override adds', () => {
    expect(
      issues({
        schemaVersion: 2,
        services: [service('web', [{ hostPath: '${APP_DATA_DIR}/data', containerPath: '/data' }], true)],
        overrides: [
          { architecture: 'arm64', services: [{ name: 'web', volumes: [{ hostPath: '${APP_DATA_DIR}/data/arm', containerPath: '/arm' }] }] },
        ],
      }),
    ).toEqual(['overrides.0.services.0.volumes.0.hostPath']);
  });

  it('saves sibling folders', () => {
    expect(
      issues({
        schemaVersion: 2,
        services: [
          service('web', [{ hostPath: '${APP_DATA_DIR}/data/app', containerPath: '/data' }], true),
          service('db', [{ hostPath: '${APP_DATA_DIR}/data/db', containerPath: '/var/lib/db' }]),
        ],
      }),
    ).toEqual([]);
  });
});
