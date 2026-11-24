import { describe, expect, it } from 'vitest';
import { CUSTOM_APP_DEFAULT_SHORT_DESC, PORT_EXPOSE_DEFAULT_SHORT_DESC, isLocalAppDefaultShortDesc } from './local-app-defaults.js';

describe('isLocalAppDefaultShortDesc', () => {
  it('recognises the descriptions the Hub writes for a new custom app and port expose', () => {
    expect(isLocalAppDefaultShortDesc(CUSTOM_APP_DEFAULT_SHORT_DESC)).toBe(true);
    expect(isLocalAppDefaultShortDesc(` ${PORT_EXPOSE_DEFAULT_SHORT_DESC} `)).toBe(true);
  });

  it('leaves a description the owner wrote, and an empty one, alone', () => {
    expect(isLocalAppDefaultShortDesc('Recipes for the family')).toBe(false);
    expect(isLocalAppDefaultShortDesc('')).toBe(false);
    expect(isLocalAppDefaultShortDesc(undefined)).toBe(false);
  });
});
