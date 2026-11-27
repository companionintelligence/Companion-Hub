import { createAppUrn } from '@/common/helpers/app-helpers';
import { TranslatableError } from '@/common/error/translatable-error';
import { describe, expect, it } from 'vitest';
import { assertAppIdFree, assertAppNameNotHubHost } from '../app-id.helpers';

const installed = (...urns: Array<[string, string]>) => urns.map(([appName, appStoreSlug]) => ({ appName, appStoreSlug }));

describe('assertAppIdFree', () => {
  it('refuses an app whose id another installed app already has', () => {
    let error: unknown;
    try {
      assertAppIdFree(createAppUrn('a', 'b-c'), installed(['a-b', 'c']));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TranslatableError);
    expect((error as TranslatableError).getResponse()).toEqual({
      message: 'APP_ERROR_APP_ID_IN_USE',
      intlParams: { id: 'a:b-c', appId: 'a-b-c', other: 'a-b:c' },
    });
    expect((error as TranslatableError).getStatus()).toBe(409);
  });

  it('refuses a custom app with the id of an app from a store', () => {
    expect(() => assertAppIdFree(createAppUrn('a-b', '_user'), installed(['a', 'b-_user']))).toThrow('APP_ERROR_APP_ID_IN_USE');
  });

  // Traefik reads router, service and middleware names without regard to case.
  it('refuses an id another app has spelled in another case', () => {
    expect(() => assertAppIdFree(createAppUrn('a', 'b-c'), installed(['A-b', 'c']))).toThrow('APP_ERROR_APP_ID_IN_USE');
  });

  // App `ci` from a store `hub` would name its main router and service `ci-hub`, as the Hub does.
  it.each([
    ['ci', 'hub'],
    ['CI', 'Hub'],
    ['ci-os', 'hub'],
  ])('refuses %s from store %s, whose id is one of the Hub’s Traefik names', (appName, store) => {
    expect(() => assertAppIdFree(createAppUrn(appName, store), installed())).toThrow('APP_ERROR_APP_ID_RESERVED');
  });

  // An app's hostnames start with its name, and the desktop app keeps every `hub`/`hub-…` host in the
  // Hub's window as the Hub itself. App `hub` from store `service` is refused here too (its id is also a
  // Traefik name of the Hub's).
  it.each([
    ['hub', 'service'],
    ['hub-admin', 'ci-marketplace'],
    ['HUB-x', 'some-store'],
    ['hub', '_user'],
  ])('refuses %s from store %s, named like the Hub’s own host, from any store', (appName, store) => {
    expect(() => assertAppNameNotHubHost(createAppUrn(appName, store))).toThrow('APP_ERROR_APP_NAME_HUB_HOST');
  });

  it.each([['hubitat'], ['github-hub'], ['my-hub']])('installs %s, which only looks like the Hub', (appName) => {
    expect(() => assertAppNameNotHubHost(createAppUrn(appName, 'ci-marketplace'))).not.toThrow();
  });

  // The Hub names an app's other routers `<id>-insecure`, `<id>-tailscale`, `<id>-sw-reset` and
  // `<id>-sw-reset-insecure`, and its public-host middleware `<id>-public-host`. App `x` from store
  // `home` and app `x` from store `home-insecure` would both define the router `x-home-insecure`.
  it.each([
    [
      ['x', 'home-sw-reset'],
      ['x', 'home'],
    ],
    [
      ['x', 'home-sw-reset-insecure'],
      ['x', 'home'],
    ],
    [
      ['x', 'home-insecure'],
      ['x', 'home'],
    ],
    [
      ['x', 'home'],
      ['x', 'home-insecure'],
    ],
    [
      ['x', 'home-tailscale'],
      ['x', 'home'],
    ],
    [
      ['x-home', 'public-host'],
      ['x', 'home'],
    ],
    [
      ['x', 'Home-Insecure'],
      ['x', 'home'],
    ],
  ])('refuses %j next to %j, whose ids differ by a suffix the Hub names routes with', ([appName, store], other) => {
    let error: unknown;
    try {
      assertAppIdFree(createAppUrn(appName, store), installed(other as [string, string]));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TranslatableError);
    expect((error as TranslatableError).getResponse()).toMatchObject({ message: 'APP_ERROR_APP_ID_ROUTE_IN_USE' });
    expect((error as TranslatableError).getStatus()).toBe(409);
  });

  it('names the route both apps would get', () => {
    expect(() => assertAppIdFree(createAppUrn('x', 'home-insecure'), installed(['x', 'home']))).toThrow(
      expect.objectContaining({
        response: {
          message: 'APP_ERROR_APP_ID_ROUTE_IN_USE',
          intlParams: expect.objectContaining({ route: 'x-home-insecure', otherAppId: 'x-home' }),
        },
      }),
    );
  });

  it('lets an app be installed again and ids that only start alike', () => {
    expect(() =>
      assertAppIdFree(
        createAppUrn('a', 'b-c'),
        installed(['a', 'b-c'], ['a', 'b-c-d'], ['a', 'b'], ['x-a', 'b-c'], ['a', 'b-c-lab'], ['a', 'b-c-secure']),
      ),
    ).not.toThrow();
  });
});
