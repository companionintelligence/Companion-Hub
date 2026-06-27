import path from 'node:path';
import type { AppUrn } from '@ci-hub/common/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAppDataHostPath, isAbsoluteHostPath, resolveAppDataHostRoot } from '../app-data-path.helper';

describe('app-data-path.helper', () => {
  // The fallbacks read process.env.ROOT_FOLDER_HOST, so isolate it per test.
  let savedRootFolderHost: string | undefined;
  beforeEach(() => {
    savedRootFolderHost = process.env.ROOT_FOLDER_HOST;
    delete process.env.ROOT_FOLDER_HOST;
  });
  afterEach(() => {
    if (savedRootFolderHost === undefined) {
      delete process.env.ROOT_FOLDER_HOST;
    } else {
      process.env.ROOT_FOLDER_HOST = savedRootFolderHost;
    }
  });

  describe('isAbsoluteHostPath', () => {
    it('accepts POSIX and Windows absolute paths, rejects relative', () => {
      expect(isAbsoluteHostPath('/srv/data')).toBe(true);
      expect(isAbsoluteHostPath('C:/Users/dev')).toBe(true);
      expect(isAbsoluteHostPath('relative/dir')).toBe(false);
    });
  });

  describe('resolveAppDataHostRoot', () => {
    it('appends app-data to an absolute base (CI_HUB_APP_DATA_PATH precedence)', () => {
      const root = resolveAppDataHostRoot({
        ciHubAppDataPath: '/srv/hub',
        appDataPath: '/ignored',
        rootFolderHost: '/also-ignored',
      });
      expect(root).toBe(path.join('/srv/hub', 'app-data'));
    });

    it('falls back to appDataPath, then rootFolderHost', () => {
      expect(resolveAppDataHostRoot({ appDataPath: '/srv/hub', rootFolderHost: '/root' })).toBe(path.join('/srv/hub', 'app-data'));
      expect(resolveAppDataHostRoot({ rootFolderHost: '/root' })).toBe(path.join('/root', 'app-data'));
    });

    it('does not double up when the base already ends with app-data', () => {
      expect(resolveAppDataHostRoot({ ciHubAppDataPath: '/srv/hub/app-data', rootFolderHost: '/root' })).toBe(path.join('/srv/hub', 'app-data'));
    });

    it('resolves a relative base against rootFolderHost', () => {
      expect(resolveAppDataHostRoot({ ciHubAppDataPath: 'storage', rootFolderHost: '/srv/hub' })).toBe(path.join('/srv/hub', 'storage', 'app-data'));
    });

    it('resolves a relative base against a Windows host root using win32 semantics', () => {
      // On a POSIX backend, the default path.resolve would corrupt this to /cwd/C:\hub\...;
      // win32 resolution keeps it anchored to the Windows root (not the container CWD).
      const result = resolveAppDataHostRoot({ ciHubAppDataPath: 'storage', rootFolderHost: 'C:\\hub' });
      expect(result.startsWith('C:\\hub')).toBe(true);
      expect(result.startsWith('/')).toBe(false);
      expect(result).toContain('storage');
      expect(result).toContain('app-data');
    });

    it('throws when nothing resolves to an absolute path', () => {
      expect(() => resolveAppDataHostRoot({ ciHubAppDataPath: 'rel', rootFolderHost: 'also-rel' })).toThrow();
    });
  });

  describe('getAppDataHostPath', () => {
    const urn = 'nextcloud:ci-app-store' as AppUrn;

    it('appends {appStoreId}/{appName} to the root', () => {
      const result = getAppDataHostPath(urn, { ciHubAppDataPath: '/srv/hub', rootFolderHost: '/root' });
      // extractAppUrn => appName=nextcloud, appStoreId=ci-app-store
      expect(result).toBe(path.join('/srv/hub', 'app-data', 'ci-app-store', 'nextcloud'));
    });

    it('uses the rootFolderHost fallback when the resolved path is an absolute container path', () => {
      // An absolute /data/* base resolves to a container path → rebuild under the host root.
      const result = getAppDataHostPath(urn, { ciHubAppDataPath: '/data/ci-hub', rootFolderHost: '/srv/hub' });
      expect(result).toBe(path.join('/srv/hub', 'app-data', 'ci-app-store', 'nextcloud'));
      expect(result.startsWith('/data/')).toBe(false);
    });

    it('throws when the base strips to a non-absolute path (matches original APP_DATA_DIR guard)', () => {
      // CI_HUB_APP_DATA_PATH='/app-data' strips its trailing /app-data to '', leaving a
      // relative path that would break Docker mounts — the original code threw here.
      expect(() => getAppDataHostPath(urn, { ciHubAppDataPath: '/app-data', rootFolderHost: '/srv/hub' })).toThrow();
    });
  });
});
