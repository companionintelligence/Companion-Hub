import type { Request, Response } from 'express';
import { HUB_FAVICON_LINK_TAG } from './hub-favicon';

/** Where the confirmation page posts. Same origin as the page, which is what `isSameOriginFormPost` checks. */
export const BROWSER_HANDOFF_CONFIRM_PATH = '/api/auth/browser-handoff/confirm';

/**
 * Whether a form POST came from a page on `hubOrigin` itself. A site that lured someone into
 * opening a handoff link cannot submit the Hub's confirmation form for them: its own POST would
 * arrive `cross-site` (or, without Fetch Metadata, with its own `Origin`).
 */
export function isSameOriginFormPost(req: Request, hubOrigin: string): boolean {
  const site = req.get('sec-fetch-site');
  const origin = req.get('origin');
  if (site !== undefined) {
    return site === 'same-origin' && (origin === undefined || origin === hubOrigin);
  }
  return origin === hubOrigin;
}

/** What a handoff target is, in words, for the confirmation page. Never echoes the query. */
export function describeBrowserHandoffTarget(next: string): string {
  try {
    const url = new URL(next);
    if (url.pathname === '/api/memory-connect/start') {
      return 'connect an app to CI Memory';
    }
    return `open ${url.hostname}`;
  } catch {
    return 'continue';
  }
}

/**
 * The headers for the confirmation page. It must not be framed (a luring site could otherwise
 * overlay it and take the click), runs no script, and posts only to its own origin.
 */
export function setBrowserHandoffConfirmHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The page a handoff link gets when the browser did not mark it a fresh, user-initiated
 * navigation. Chrome on Android marks every link another app opens `cross-site`, so this is the
 * normal path from the Hub's Android app. Nothing is signed in until Continue is pressed.
 *
 * Self-contained like the desktop handoff page: served before any session exists, so no
 * external CSS, fonts or images; palette matches @companionintelligence/tokens.
 */
export function buildBrowserHandoffConfirmHtml(input: { ticket: string; username: string; target: string }): string {
  const ticket = escapeHtml(input.ticket);
  const username = escapeHtml(input.username);
  const target = escapeHtml(input.target);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Continue in this browser — Companion Hub</title>
${HUB_FAVICON_LINK_TAG}
<meta name="color-scheme" content="dark light">
<style>
:root {
  color-scheme: dark light;
  --bg: #041620;
  --card: #0c323c;
  --fg: #e8f2f4;
  --muted: #a3babf;
  --border: #073038;
  --accent: #c5e8dc;
  --accent-fg: #041620;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f3faf7;
    --card: #f0f9f5;
    --fg: #0a222e;
    --muted: #3a524b;
    --border: #dfece6;
    --accent: #0a6358;
    --accent-fg: #f0fdf4;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.5 Manrope, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.card {
  width: 100%;
  max-width: 420px;
  padding: 32px 24px;
  text-align: center;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 9px;
}
h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
p { margin: 0 0 20px; color: var(--muted); font-size: 14px; }
strong { color: var(--fg); font-weight: 600; overflow-wrap: anywhere; }
form { margin: 0; }
.btn {
  display: block;
  width: 100%;
  padding: 12px 16px;
  border: 0;
  border-radius: 9px;
  background: var(--accent);
  color: var(--accent-fg);
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
.btn.secondary {
  margin-top: 10px;
  background: transparent;
  color: var(--fg);
  border: 1px solid var(--border);
}
.hint { margin: 16px 0 0; font-size: 12px; }
</style>
</head>
<body>
<main class="card">
<h1>Continue in this browser?</h1>
<p>The Companion Hub app opened this page to sign this browser in as <strong>${username}</strong> and ${target}.</p>
<form method="post" action="${BROWSER_HANDOFF_CONFIRM_PATH}">
<input type="hidden" name="ticket" value="${ticket}">
<button class="btn" type="submit">Continue</button>
</form>
<a class="btn secondary" href="/">Cancel</a>
<p class="hint">If you didn't just do this in the Hub app, press Cancel.</p>
</main>
</body>
</html>`;
}
