import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HUB_FAVICON_LINK_TAG, HUB_FAVICON_PATH, HUB_FAVICON_PNG } from '../hub-favicon';

// The shared test setup mocks `fs`; these assertions are ABOUT the real files on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

const BRAND_PNG = path.join(__dirname, '../../../../../frontend/brand/icons/png/favicon-96.png');

describe('hub favicon', () => {
  it('is the brand icon, byte for byte, so the tab matches the app', () => {
    expect(HUB_FAVICON_PNG.equals(readFileSync(BRAND_PNG))).toBe(true);
  });

  it('links a real URL, not a data URI, because WebKit ignores data: favicons', () => {
    expect(HUB_FAVICON_LINK_TAG).toBe(`<link rel="icon" type="image/png" sizes="96x96" href="${HUB_FAVICON_PATH}">`);
    expect(HUB_FAVICON_PATH).toBe('/api/auth/favicon.png');
  });
});
