import { describe, expect, it } from 'vitest';
import {
  extractScreenshotFilename,
  isAbsoluteMediaUrl,
  isSafeMediaFilename,
  marketplaceDemoVideoPath,
  marketplaceScreenshotPath,
  parseByteRange,
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

  it('distinguishes absolute media URLs from manifest-relative refs', () => {
    expect(isAbsoluteMediaUrl('https://cdn.example.com/a.mp4')).toBe(true);
    expect(isAbsoluteMediaUrl('  HTTP://cdn.example.com/a.mp4 ')).toBe(true);
    expect(isAbsoluteMediaUrl('./metadata/media/a-landscape.mp4')).toBe(false);
    expect(isAbsoluteMediaUrl('')).toBe(false);
  });

  describe('parseByteRange', () => {
    it('serves the whole entity when there is no usable range header', () => {
      expect(parseByteRange(undefined, 100)).toBeNull();
      expect(parseByteRange('', 100)).toBeNull();
      expect(parseByteRange('bytes=-', 100)).toBeNull();
      expect(parseByteRange('items=0-10', 100)).toBeNull();
      // Multi-range is deliberately unsupported; fall back to a 200 with the full body.
      expect(parseByteRange('bytes=0-9,20-29', 100)).toBeNull();
      expect(parseByteRange(['bytes=0-9'], 100)).toBeNull();
      expect(parseByteRange('bytes=0-9', 0)).toBeNull();
    });

    it('parses explicit, open-ended and suffix ranges', () => {
      expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
      expect(parseByteRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 });
      expect(parseByteRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 });
      // A suffix longer than the file clamps to the whole file.
      expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    });

    it('clamps an over-long end and rejects out-of-bounds starts', () => {
      expect(parseByteRange('bytes=90-9999', 100)).toEqual({ start: 90, end: 99 });
      expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
      expect(parseByteRange('bytes=50-40', 100)).toBe('unsatisfiable');
      expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable');
    });
  });
});
