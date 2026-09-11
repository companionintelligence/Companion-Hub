import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import type { AppInfo } from '@ci-hub/common/schemas';
import { appInfoSchema } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';

/**
 * A port in the app-store range that is a pure function of the id. FNV-1a, because the only
 * requirement is "same id, same port, on every machine and every dependency version" — not
 * distribution quality. Distinct across every id the lifecycle tests and the debug seed use.
 */
function stablePort(id: string): number {
  let hash = 0x811c9dc5;
  for (const char of id) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  return 1000 + (hash % 9000);
}

/** Ids for the callers that pass none. A counter, not a random word, so a snapshot can name them. */
let anonymousApps = 0;

/**
 * Every default is derived from the id, and none comes from faker any more.
 *
 * They used to: each field was a faker draw under `faker.seed(123)`, and faker only promises the
 * same output for the same seed on the same faker VERSION. The 10.2 → 10.6 bump (#1409) turned over
 * every field — name, port, author, version, both URLs, both sentences — and with them the
 * app-lifecycle snapshots that pin the installed tree and the generated `.env`, so the
 * `integration-tests` check went red on every PR after it while `dev` itself, where the workflow
 * never runs, stayed green. A value that is a function of the id cannot drift under a dependency
 * bump, and it reads better in a snapshot than a Latin sentence. `version` also folds in
 * `cihub_app_version`, so a newer store entry for the same app still gets a distinct image tag.
 */
export const createAppInStore = async (storeId: string, app: Partial<AppInfo> = {}): Promise<AppInfo> => {
  const id = app.id ?? `app-${++anonymousApps}`;
  const storeVersion = app.cihub_app_version ?? 1;

  const appInfo = appInfoSchema.parse({
    id,
    urn: `${id}:${storeId}` as AppUrn,
    name: `${id} app`,
    port: stablePort(id),
    https: false,
    author: `${id}-author`,
    no_gui: false,
    available: true,
    exposable: true,
    dynamic_config: true,
    source: `https://github.com/example/${id}`,
    version: `1.${storeVersion}.0`,
    categories: ['utilities'],
    description: `Description of ${id}.`,
    short_desc: `${id} in one line.`,
    website: `https://${id}.example.com`,
    supported_architectures: [],
    created_at: 0,
    updated_at: 0,
    deprecated: false,
    cihub_app_version: 1,
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
