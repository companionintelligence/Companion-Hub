import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import type { AppInfo } from '@ci-hub/common/schemas';
import { appInfoSchema } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';

// Every generated field below is a pure function of the app id (or a constant), never
// random. The lifecycle integration tests snapshot the whole fake filesystem — config.json,
// app.env, compose output — so anything non-deterministic here lands in the snapshot. The
// previous faker-based fixture was seeded, but a seeded sequence is only stable within one
// faker version: bumping 10.2 → 10.6 (#1409) changed the word lists and broke three
// snapshots without any product change. Do not reintroduce faker (or any RNG) here.
let generatedAppCount = 0;

/** Stable port in [1000, 9999] derived from the id, so distinct apps get distinct ports and re-creating an id keeps its port. */
const portForId = (id: string): number => {
  let hash = 7;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 1000 + (hash % 9000);
};

export const createAppInStore = async (storeId: string, app: Partial<AppInfo> = {}): Promise<AppInfo> => {
  const id = app.id ?? `generated-app-${++generatedAppCount}`;
  const cihubAppVersion = app.cihub_app_version ?? 1;

  const appInfo = appInfoSchema.parse({
    id,
    urn: `${id}:${storeId}` as AppUrn,
    name: `${id} app`,
    port: portForId(id),
    https: false,
    author: 'test-author',
    no_gui: false,
    available: true,
    exposable: true,
    dynamic_config: true,
    source: `https://example.com/${id}`,
    version: `${cihubAppVersion}.0.0`,
    categories: ['utilities'],
    description: `Description for ${id}`,
    short_desc: `Short description for ${id}`,
    website: `https://${id}.example.com`,
    supported_architectures: [],
    created_at: 0,
    updated_at: 0,
    deprecated: false,
    cihub_app_version: cihubAppVersion,
    force_expose: false,
    generate_vapid_keys: false,
    form_fields: [],
    ...app,
  });

  const composeJson = {
    schemaVersion: 2,
    services: [
      {
        name: appInfo.id,
        image: 'nginx:latest',
        isMain: true,
        internalPort: 80,
        environment: [{ key: 'TEST', value: 'test' }],
      },
    ],
  };

  const appStorePath = `${DATA_DIR}/repos/${storeId}/apps/${appInfo.id}`;

  await fs.promises.mkdir(`${DATA_DIR}/repos/${storeId}/apps/${appInfo.id}/data`, { recursive: true });
  await fs.promises.mkdir(`${DATA_DIR}/repos/${storeId}/apps/${appInfo.id}/metadata`, { recursive: true });

  await fs.promises.writeFile(path.join(appStorePath, 'config.json'), JSON.stringify(appInfo, null, 2));
  await fs.promises.writeFile(path.join(appStorePath, 'docker-compose.json'), JSON.stringify(composeJson, null, 2));
  await fs.promises.writeFile(path.join(appStorePath, 'metadata', 'description.md'), 'test');

  return appInfo;
};
