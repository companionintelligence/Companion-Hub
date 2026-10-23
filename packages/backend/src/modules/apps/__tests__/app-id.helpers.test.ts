import { createAppUrn } from '@/common/helpers/app-helpers';
import { TranslatableError } from '@/common/error/translatable-error';
import { describe, expect, it } from 'vitest';
import { assertAppIdFree } from '../app-id.helpers';

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
    ['hub', 'service'],
  ])('refuses %s from store %s, whose id is one of the Hub’s Traefik names', (appName, store) => {
    expect(() => assertAppIdFree(createAppUrn(appName, store), installed())).toThrow('APP_ERROR_APP_ID_RESERVED');
  });

  it('lets an app be installed again and ids that only start alike', () => {
    expect(() => assertAppIdFree(createAppUrn('a', 'b-c'), installed(['a', 'b-c'], ['a', 'b-c-d'], ['a', 'b'], ['x-a', 'b-c']))).not.toThrow();
  });
});
