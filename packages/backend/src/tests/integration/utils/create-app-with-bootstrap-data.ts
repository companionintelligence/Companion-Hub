/**
 * Test fixture: create an app entry in the test store that includes
 * bootstrap wrapper scripts under `data/`. Mirrors what CI-Marketplace
 * apps (openclaw, hermes-agent) bundle so we can exercise the
 * copyDataDir path end-to-end.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import type { AppUrn } from '@ci-hub/common/types';

export interface AppWithBootstrapDataOpts {
  storeId: string;
  appId: string;
  wrapperScript: string;
  entrypointScript: string;
  /** Additional fixture files placed under data/ alongside the wrappers. */
  extraDataFiles?: Record<string, string>;
}

export async function createAppWithBootstrapData(opts: AppWithBootstrapDataOpts) {
  const { storeId, appId, wrapperScript, entrypointScript, extraDataFiles = {} } = opts;

  const appUrn = `${appId}:${storeId}` as AppUrn;
  const appStorePath = `${DATA_DIR}/repos/${storeId}/apps/${appId}`;

  await fs.promises.mkdir(`${appStorePath}/data`, { recursive: true });
  await fs.promises.mkdir(`${appStorePath}/metadata`, { recursive: true });

  const appInfo = {
    id: appId,
    urn: appUrn,
    name: appId,
    port: 18789,
    https: false,
    author: 'CI Hub Integration Tests',
    no_gui: false,
    available: true,
    exposable: true,
    dynamic_config: true,
    source: 'https://example.com',
    version: '0.0.1',
    categories: ['ai' as const],
    description: 'integration-test app',
    short_desc: 'integration-test app',
    website: 'https://example.com',
    supported_architectures: [],
    created_at: 0,
    updated_at: 0,
    deprecated: false,
    tipi_version: 1,
    force_expose: false,
    generate_vapid_keys: false,
    form_fields: [],
  };
  await fs.promises.writeFile(path.join(appStorePath, 'config.json'), JSON.stringify(appInfo, null, 2));

  const composeJson = {
    services: [
      {
        name: appId,
        image: 'nginx:latest',
        isMain: true,
        internalPort: 18789,
        environment: { TEST: 'test' },
      },
    ],
  };
  await fs.promises.writeFile(path.join(appStorePath, 'docker-compose.json'), JSON.stringify(composeJson, null, 2));
  await fs.promises.writeFile(path.join(appStorePath, 'metadata', 'description.md'), 'integration test fixture');

  // Bootstrap wrapper scripts — the marketplace pattern.
  await fs.promises.writeFile(path.join(appStorePath, 'data', 'ci-wrapper.sh'), wrapperScript);
  await fs.promises.writeFile(path.join(appStorePath, 'data', 'ci-entrypoint.sh'), entrypointScript);
  for (const [name, contents] of Object.entries(extraDataFiles)) {
    await fs.promises.writeFile(path.join(appStorePath, 'data', name), contents);
  }

  return { appUrn, appInfo };
}
