import { describe, expect, it } from 'vitest';
import { appInfoSchema } from '../app-info.js';

const baseApp = {
  id: 'nextcloud',
  urn: 'nextcloud:ci-marketplace',
  available: true,
  name: 'Nextcloud',
  short_desc: 'A safe home for all your data.',
  author: 'nextcloud',
  source: 'https://github.com/nextcloud/server',
  categories: ['data'],
};

describe('app replaces metadata', () => {
  it('defaults to an empty list when the marketplace app has not declared any', () => {
    const parsed = appInfoSchema.parse(baseApp);
    expect(parsed.replaces).toEqual([]);
  });

  it('treats null replaces as empty so late-added metadata cannot hide an app', () => {
    const parsed = appInfoSchema.safeParse({ ...baseApp, replaces: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.replaces).toEqual([]);
    }
  });

  it('keeps the app visible when replaces is malformed', () => {
    const parsed = appInfoSchema.safeParse({ ...baseApp, replaces: 'Google Drive' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.replaces).toEqual([]);
    }
  });

  it('keeps proprietary platforms on the app so store search can index them', () => {
    const parsed = appInfoSchema.parse({
      ...baseApp,
      replaces: ['Google Drive', 'Dropbox'],
    });
    expect(parsed.replaces).toEqual(['Google Drive', 'Dropbox']);
  });

  it('drops blank replace names without failing the app', () => {
    const parsed = appInfoSchema.safeParse({ ...baseApp, replaces: ['', 'Google Drive'] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.replaces).toEqual(['Google Drive']);
    }
  });
});
