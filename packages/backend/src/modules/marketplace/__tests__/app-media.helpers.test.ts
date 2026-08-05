import { describe, expect, it } from 'vitest';
import {
  extractScreenshotFilename,
  isSafeMediaFilename,
  marketplaceDemoVideoPath,
  marketplaceScreenshotPath,
  portalScreenshotPath,
} from '../app-media.helpers.js';

describe('app-media.helpers', () => {
  it('accepts safe filenames and rejects traversal', () => {
    expect(isSafeMediaFilename('preview.png')).toBe(true);
    expect(isSafeMediaFilename('../secret.png')).toBe(false);
    expect(isSafeMediaFilename('nested/preview.png')).toBe(false);
  });

  it('extracts screenshot filenames from manifest refs', () => {
    expect(extractScreenshotFilename('screenshots/preview.png')).toBe('preview.png');
    expect(extractScreenshotFilename('./metadata/screenshots/hero.jpg')).toBe('hero.jpg');
    expect(extractScreenshotFilename('https://example.com/a.png')).toBeNull();
  });

  it('builds marketplace and portal screenshot paths', () => {
    expect(marketplaceScreenshotPath('ci-memory:ci-marketplace', 'hero.png')).toBe(
      '/api/marketplace/apps/ci-memory%3Aci-marketplace/screenshots/hero.png',
    );
    expect(marketplaceDemoVideoPath('ci-memory:ci-marketplace')).toBe('/api/marketplace/apps/ci-memory%3Aci-marketplace/demo-video');
    expect(portalScreenshotPath('https://portal.example.com', 'ci-memory', 'hero.png')).toBe(
      'https://portal.example.com/api/store/ci-memory/screenshots/hero.png',
    );
  });
});
