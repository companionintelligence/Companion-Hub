import path from 'node:path';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { AuthController } from '@/modules/auth/auth.controller';
import { SW_RESET_MIDDLEWARE } from '@/modules/docker/builders/traefik-labels.builder';

// The shared test setup mocks `fs`; these assertions are ABOUT the real files on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

/**
 * Lock-step guard for the `ci-hub-sw-reset` errors middleware (#2324), which every app router for
 * `/sw.js` behind the sign-in names. Traefik disables a router whose middleware is missing, and a
 * query the Hub doesn't serve would hand the browser a 200 it can't use as a worker.
 */
const REPO_ROOT = path.join(__dirname, '../../../..');
const DYNAMIC_YML = 'packages/backend/assets/traefik/dynamic/dynamic.yml';
const read = (relativePath: string) => readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');

describe('traefik ci-hub-sw-reset middleware config', () => {
  const dynamic = YAML.parse(read(DYNAMIC_YML));
  const [name, provider] = SW_RESET_MIDDLEWARE.split('@');
  const errors = () => dynamic.http.middlewares[name as string].errors;

  it('is the file-provider middleware the routers name', () => {
    expect(provider).toBe('file');
    expect(errors()).toBeDefined();
  });

  // The forward auth answers a signed-out worker script fetch with a 401. An app's own redirect or
  // 403 for its `/sw.js` must reach the browser as the app sent it.
  it('catches only the 401 and sends the worker as a 200', () => {
    expect(errors().status).toEqual(['401']);
    expect(errors().statusRewrites).toEqual({ '401': 200 });
  });

  it('asks the Hub for the worker at the path its controller serves', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, AuthController) as string;
    const methodPath = Reflect.getMetadata(PATH_METADATA, AuthController.prototype.serviceWorkerReset) as string;

    expect(errors().query).toBe(`/api/${controllerPath}${methodPath}`);
    expect(dynamic.http.services[errors().service].loadBalancer.servers).toEqual([{ url: 'http://ci-hub:5002' }]);
  });

  it("stays off the Hub's own routes", () => {
    for (const compose of ['docker-compose.prod.yml', 'packages/desktop/src-tauri/resources/docker-compose.prod.yml']) {
      expect(read(compose), compose).not.toContain(name as string);
    }
  });
});
