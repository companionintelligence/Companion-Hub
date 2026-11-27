import { describe, expect, it } from 'vitest';
import { MAX_GATEWAY_HOST_NAMES } from '@ci-hub/common/schemas';
import { appFormSchema } from '../app-lifecycle.dto';

describe('appFormSchema gatewayHostNames', () => {
  it('stores host names and suffixes lower case', () => {
    expect(appFormSchema.parse({ gatewayHostNames: [' Kyle-PC.fritz.box ', '.Fritz.Box', '.lan'] }).gatewayHostNames).toEqual([
      'kyle-pc.fritz.box',
      '.fritz.box',
      '.lan',
    ]);
  });

  it.each([['http://memory.lan'], ['memory.lan:8642'], ['.corp'], ['.com'], ['.co.uk']])('refuses %s', (name) => {
    expect(appFormSchema.safeParse({ gatewayHostNames: [name] }).success).toBe(false);
  });

  it(`takes at most ${MAX_GATEWAY_HOST_NAMES}`, () => {
    const names = Array.from({ length: MAX_GATEWAY_HOST_NAMES + 1 }, (_, i) => `host-${i}.lan`);
    expect(appFormSchema.safeParse({ gatewayHostNames: names.slice(0, MAX_GATEWAY_HOST_NAMES) }).success).toBe(true);
    expect(appFormSchema.safeParse({ gatewayHostNames: names }).success).toBe(false);
  });
});
