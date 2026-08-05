import path from 'node:path';

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

export function isSafeMediaFilename(filename: string): boolean {
  if (!filename || filename.includes('..')) {
    return false;
  }

  const base = path.basename(filename);
  return base === filename && SAFE_FILENAME.test(base);
}

export function extractScreenshotFilename(ref: string): string | null {
  const normalized = ref.trim().replace(/^\.\//, '');
  if (!normalized) {
    return null;
  }

  if (/^https?:\/\//i.test(normalized)) {
    return null;
  }

  const metadataMatch = normalized.match(/^metadata\/screenshots\/(.+)$/i);
  if (metadataMatch?.[1]) {
    const base = path.basename(metadataMatch[1]);
    return isSafeMediaFilename(base) ? base : null;
  }

  const screenshotsMatch = normalized.match(/^screenshots\/(.+)$/i);
  if (screenshotsMatch?.[1]) {
    const base = path.basename(screenshotsMatch[1]);
    return isSafeMediaFilename(base) ? base : null;
  }

  const base = path.basename(normalized);
  return isSafeMediaFilename(base) ? base : null;
}

export function resolveRelativeMediaPath(ref: string): string | null {
  const normalized = ref.trim().replace(/^\.\//, '');
  if (!normalized || /^https?:\/\//i.test(normalized)) {
    return null;
  }

  if (normalized.includes('..')) {
    return null;
  }

  return normalized;
}

export function contentTypeForImageFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/jpeg';
}

export function contentTypeForVideoFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  return 'video/mp4';
}

export function marketplaceScreenshotPath(appUrn: string, filename: string): string {
  return `/api/marketplace/apps/${encodeURIComponent(appUrn)}/screenshots/${encodeURIComponent(filename)}`;
}

export function marketplaceDemoVideoPath(appUrn: string): string {
  return `/api/marketplace/apps/${encodeURIComponent(appUrn)}/demo-video`;
}

export function portalScreenshotPath(publicPortalUrl: string, slug: string, filename: string): string {
  const base = publicPortalUrl.replace(/\/+$/, '');
  return `${base}/api/store/${encodeURIComponent(slug)}/screenshots/${encodeURIComponent(filename)}`;
}
