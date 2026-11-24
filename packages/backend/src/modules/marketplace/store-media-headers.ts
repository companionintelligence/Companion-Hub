/**
 * The types the Hub serves a store's logo, screenshots and demo video as. Anything else a store or
 * CI-Portal answers with (`text/html`, `application/xhtml+xml`) is served as bytes to save, never as
 * something the browser renders on the Hub's own address.
 */
const STORE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

/**
 * ⚠ A STORE'S FILES ARE SERVED FROM THE HUB'S OWN ADDRESS. These routes are public, since an `<img>`
 * tag sends no session, and the browser keeps the Hub session in `localStorage`. An SVG can carry
 * script: inside an `<img>` it never runs, but opened at its own URL it runs as the Hub, reads the
 * session and acts as whoever followed the link. So every one of these responses carries:
 *
 * - `Content-Security-Policy: … sandbox`: opened as a page, the file gets a unique opaque origin
 *   with scripts, forms and plugins off, so it can read nothing of the Hub's. An `<img>` or `<video>`
 *   on the Hub's pages ignores the policy and shows it as before.
 * - `X-Content-Type-Options: nosniff`, so a file served as an image is never read as a page.
 * - a `Content-Type` from STORE_MEDIA_TYPES only.
 */
export function storeMediaHeaders(contentType: string | undefined, fallback: string): Record<string, string> {
  const essence = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const type = essence === '' ? fallback : STORE_MEDIA_TYPES.has(essence) ? essence : 'application/octet-stream';
  return {
    'Content-Type': type,
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  };
}
