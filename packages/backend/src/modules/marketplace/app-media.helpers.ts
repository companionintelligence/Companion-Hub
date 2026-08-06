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

/** True when a media ref is already a fully-qualified http(s) URL we can hand straight to the browser. */
export function isAbsoluteMediaUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref.trim());
}

export type ByteRange = { start: number; end: number };

/**
 * Parse a single-range `Range: bytes=...` header against a known file size.
 *
 * Returns `null` when the whole entity should be served (no header, malformed header, or a
 * multi-range request we deliberately do not support), `'unsatisfiable'` when the caller must
 * answer 416, and a clamped `{ start, end }` byte range otherwise.
 */
export function parseByteRange(header: string | string[] | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (typeof header !== 'string' || size <= 0) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) {
    return null;
  }

  const [, rawStart = '', rawEnd = ''] = match;
  if (!rawStart && !rawEnd) {
    return null;
  }

  if (!rawStart) {
    // Suffix range: the last N bytes. `bytes=-0` is unsatisfiable per RFC 9110.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return 'unsatisfiable';
    }
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) {
    return 'unsatisfiable';
  }

  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isSafeInteger(requestedEnd)) {
    return 'unsatisfiable';
  }

  const end = Math.min(requestedEnd, size - 1);
  if (end < start) {
    return 'unsatisfiable';
  }

  return { start, end };
}
