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

  it('lets an app be installed again, and ids that only start alike', () => {
    expect(() => assertAppIdFree(createAppUrn('a', 'b-c'), installed(['a', 'b-c'], ['a', 'b-c-d'], ['a', 'b'], ['x-a', 'b-c']))).not.toThrow();
  });
});
