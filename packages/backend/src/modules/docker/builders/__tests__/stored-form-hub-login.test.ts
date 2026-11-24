import { createAppUrn } from '@/common/helpers/app-helpers';
import { appEventSchema } from '@/modules/queue/entities/app-events';
import { servedOpenPort, STORED_FORM_OPEN_PORT_DEFAULT } from '@ci-hub/common/schemas';
import { describe, expect, it } from 'vitest';
import yaml from 'yaml';
import { DockerComposeBuilder } from '../compose.builder';

/*
 * What the Hub serves for a STORED install form, end to end: the form goes through the queue schema
 * (every start, restart and update replays `app.config` that way), then the route builder. The
 * settings dialog (`install-form.test.tsx`, "an edit shows and submits what the Hub serves") pins
 * the same table by hand on its side, so a change to either end fails one of the two.
 *
 * The case that mattered: a form with NO `openPort` key (an API, MCP or onboarding install). The
 * queue schema gives it `openPort: true`, so the route carries the Hub login unless something
 * decided otherwise, and a dialog that read the missing key as closed showed the switch OFF.
 */
const urn = createAppUrn('openclaw', 'store-id');
const subnet = '10.128.1.0/24';
const REQUEST_ID = '0b3e6b1a-3c49-4f3a-9a53-5c1c2b6c8f10';

type Tri = boolean | undefined;
const tri: Tri[] = [true, false, undefined];

/** The expectation, written out by hand and not derived from the code under test. */
const loginExpected = (openPort: Tri, enableAuth: Tri, edgeDefault: Tri, exposable: boolean) =>
  enableAuth ?? ((exposable && edgeDefault === true) || (openPort ?? true));

const storedForm = (openPort: Tri, enableAuth: Tri) => ({
  exposureMode: 'cloudflare',
  ...(openPort === undefined ? {} : { openPort }),
  ...(enableAuth === undefined ? {} : { enableAuth }),
});

const routeMiddlewares = async (storedConfig: Record<string, unknown>, manifest: { exposable: boolean; edgeDefault: Tri }) => {
  // The queue consumer's own parse, as `start` replays the stored config.
  const event = appEventSchema.parse({ command: 'start', appUrn: urn, requestId: REQUEST_ID, form: storedConfig });
  const builder = new DockerComposeBuilder('ci.computer', 'ci.lan', true, {
    manifest: {
      exposable: manifest.exposable,
      ...(manifest.edgeDefault === undefined ? {} : { hub_integration: { edge_auth: { default: manifest.edgeDefault } } }),
    } as never,
  });
  const result = await builder.getDockerCompose(
    [{ name: 'openclaw', image: 'openclaw:latest', internalPort: 18789, isMain: true }],
    event.form,
    urn,
    subnet,
    'ci.computer',
    'ci.lan',
    undefined,
    'openclaw-core-2-acme.ci.lan',
    'openclaw-core-2-acme.ci.computer',
  );
  const labels: Record<string, string> = yaml.parse(result).services.openclaw.labels;
  return [labels['traefik.http.routers.openclaw-store-id.middlewares'], labels['traefik.http.routers.openclaw-store-id-insecure.middlewares']];
};

describe('the Hub login on the public route of a stored install form', () => {
  it('has the queue schema and the settings dialog read a missing openPort the same way', () => {
    const parsed = appEventSchema.parse({ command: 'start', appUrn: urn, requestId: REQUEST_ID, form: { exposureMode: 'cloudflare' } });

    expect(parsed.form.openPort).toBe(STORED_FORM_OPEN_PORT_DEFAULT);
    expect(servedOpenPort({ exposureMode: 'cloudflare' })).toBe(parsed.form.openPort);
    expect(servedOpenPort({ openPort: false })).toBe(false);
    expect(servedOpenPort({ openPort: true })).toBe(true);
  });

  const exposableCases = tri.flatMap((openPort) => tri.flatMap((enableAuth) => tri.map((edgeDefault) => ({ openPort, enableAuth, edgeDefault }))));

  it.each(exposableCases)(
    'exposable app, openPort $openPort, enableAuth $enableAuth, manifest edge default $edgeDefault',
    async ({ openPort, enableAuth, edgeDefault }) => {
      const middlewares = await routeMiddlewares(storedForm(openPort, enableAuth), { exposable: true, edgeDefault });
      const withLogin = loginExpected(openPort, enableAuth, edgeDefault, true);

      for (const chain of middlewares) {
        expect(chain.split(',').includes('ci-hub@file')).toBe(withLogin);
      }
    },
  );

  it.each(tri.map((openPort) => ({ openPort })))(
    'app that is not exposable, openPort $openPort: the manifest edge default never turns a login on',
    async ({ openPort }) => {
      const middlewares = await routeMiddlewares(storedForm(openPort, undefined), { exposable: false, edgeDefault: true });
      const withLogin = loginExpected(openPort, undefined, true, false);

      for (const chain of middlewares) {
        expect(chain.split(',').includes('ci-hub@file')).toBe(withLogin);
      }
    },
  );
});
