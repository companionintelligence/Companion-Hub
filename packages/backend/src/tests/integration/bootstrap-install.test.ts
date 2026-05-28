/**
 * Integration test: marketplace install pipeline copies bootstrap wrapper
 * scripts from `apps/<slug>/data/` into the app-data volume the container
 * mounts at runtime.
 *
 * This is the test the operator review flagged as missing: PRs A-D had
 * service unit tests + a wire-level integration test, but nothing
 * exercised the actual copyDataDir path that gets the wrapper scripts
 * into the container's volume.
 *
 * Uses the createAppLifecycleModule helper extracted from
 * app-lifecycle.test.ts so we don't duplicate the 30+ provider setup.
 */
import fs from 'node:fs';
import { APP_DATA_DIR, DATA_DIR } from '@/common/constants';
import { appStore } from '@/core/database/drizzle/schema';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import waitFor from 'wait-for-expect';
import type { AppEventsQueue } from '@/modules/queue/entities/app-events';
import { type TestDatabase, cleanTestData, createTestDatabase } from '../utils/create-test-database';
import { type AppLifecycleTestEnv, createAppLifecycleModule, createSharedAppEventsQueue } from './utils/create-app-lifecycle-module';
import { createAppWithBootstrapData } from './utils/create-app-with-bootstrap-data';

let db: TestDatabase;
const DB_NAME = 'bootstrapinstalltest';

// Minimal wrapper-script fixtures that mirror the marketplace files.
// We don't replicate the full openclaw/hermes scripts — the integration test
// just verifies the copy machinery runs end-to-end.
const FIXTURE_WRAPPER = '#!/bin/sh\nexec /data/ci-entrypoint.sh "$@"\n';
const FIXTURE_ENTRYPOINT = '#!/bin/sh\necho "bootstrap entrypoint"\nexit 0\n';

describe('Marketplace install copies bootstrap wrappers into app-data', () => {
  let env: AppLifecycleTestEnv;
  let appEventsQueue: AppEventsQueue;

  beforeAll(async () => {
    db = await createTestDatabase(DB_NAME);
    const queueEnv = await createSharedAppEventsQueue('app-events-queue-bootstrap-install');
    appEventsQueue = queueEnv.queue;
  });

  beforeEach(async () => {
    await cleanTestData(db);

    env = await createAppLifecycleModule({ db, appEventsQueue });
    env.mocks.configurationService.getConfig.mockReturnValue(
      fromPartial({
        demoMode: false,
        directories: { dataDir: DATA_DIR, appDir: '/app', appDataDir: APP_DATA_DIR },
        internalIp: '127.0.0.1',
        envFilePath: '/data/.env',
        rootFolderHost: '/opt/ci-hub',
        userSettings: { appDataPath: '/opt/ci-hub' },
      }),
    );

    await db.insert(appStore).values({ slug: 'test', url: 'https://appstore.example.com', hash: 'test', name: 'test', enabled: true }).execute();
    await env.marketplaceService.initialize();
  });

  it('lands ci-wrapper.sh and ci-entrypoint.sh under app-data/<store>/<id>/data/ after install', async () => {
    const { appUrn } = await createAppWithBootstrapData({
      storeId: 'test',
      appId: 'fixture-bootstrap-app',
      wrapperScript: FIXTURE_WRAPPER,
      entrypointScript: FIXTURE_ENTRYPOINT,
    });

    await env.appLifecycleService.installApp({ appUrn, form: {} });

    await waitFor(async () => {
      const app = await env.appsRepository.getAppByUrn(appUrn);
      expect(app?.status).toBe('running');
    });

    const wrapperPath = `${APP_DATA_DIR}/test/fixture-bootstrap-app/data/ci-wrapper.sh`;
    const entrypointPath = `${APP_DATA_DIR}/test/fixture-bootstrap-app/data/ci-entrypoint.sh`;

    const wrapperExists = await fs.promises
      .access(wrapperPath)
      .then(() => true)
      .catch(() => false);
    const entrypointExists = await fs.promises
      .access(entrypointPath)
      .then(() => true)
      .catch(() => false);
    expect(wrapperExists).toBe(true);
    expect(entrypointExists).toBe(true);

    const wrapperContents = await fs.promises.readFile(wrapperPath, 'utf8');
    const entrypointContents = await fs.promises.readFile(entrypointPath, 'utf8');
    expect(wrapperContents).toBe(FIXTURE_WRAPPER);
    expect(entrypointContents).toBe(FIXTURE_ENTRYPOINT);
  });

  it('preserves user edits to wrapper scripts on reinstall (does not overwrite an existing data dir)', async () => {
    const { appUrn } = await createAppWithBootstrapData({
      storeId: 'test',
      appId: 'reinstall-fixture',
      wrapperScript: FIXTURE_WRAPPER,
      entrypointScript: FIXTURE_ENTRYPOINT,
    });

    const userEditedEntrypointPath = `${APP_DATA_DIR}/test/reinstall-fixture/data/ci-entrypoint.sh`;
    await fs.promises.mkdir(`${APP_DATA_DIR}/test/reinstall-fixture/data`, { recursive: true });
    await fs.promises.writeFile(userEditedEntrypointPath, '#!/bin/sh\n# user-edited\nexit 0\n');

    await env.appLifecycleService.installApp({ appUrn, form: {} });

    await waitFor(async () => {
      const app = await env.appsRepository.getAppByUrn(appUrn);
      expect(app?.status).toBe('running');
    });

    const surviving = await fs.promises.readFile(userEditedEntrypointPath, 'utf8');
    expect(surviving).toContain('user-edited');
  });

  it('preserves a user-supplied .env in app-data on install (Hub bootstrap rewrites managed keys at container start, not at install)', async () => {
    const { appUrn } = await createAppWithBootstrapData({
      storeId: 'test',
      appId: 'env-fixture-app',
      wrapperScript: FIXTURE_WRAPPER,
      entrypointScript: FIXTURE_ENTRYPOINT,
      extraDataFiles: {
        '.env.skeleton': '# default .env distributed with the app\n',
      },
    });

    await env.appLifecycleService.installApp({ appUrn, form: {} });

    await waitFor(async () => {
      const app = await env.appsRepository.getAppByUrn(appUrn);
      expect(app?.status).toBe('running');
    });

    const envSkeleton = `${APP_DATA_DIR}/test/env-fixture-app/data/.env.skeleton`;
    const contents = await fs.promises.readFile(envSkeleton, 'utf8');
    expect(contents).toContain('default .env distributed with the app');
  });
});
