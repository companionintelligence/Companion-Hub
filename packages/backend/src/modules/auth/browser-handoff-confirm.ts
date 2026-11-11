import crypto from 'node:crypto';
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
    // `null` is what Chrome sends as the Origin of a same-origin form post from a page whose
    // referrer policy hides its origin; the Fetch Metadata already says it came from this Hub.
    return site === 'same-origin' && (origin === undefined || origin === 'null' || origin === hubOrigin);
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

/** What Continue says while its submit is under way: a Memory connect, or opening an app. */
export function browserHandoffBusyLabel(next: string): string {
  try {
    return new URL(next).pathname === '/api/memory-connect/start' ? 'Connecting…' : 'Opening…';
  } catch {
    return 'Continuing…';
  }
}

/**
 * The page's one script. Continue's submit takes a few seconds (the Hub starts the connect, then
 * hands over to CI Memory), so the button turns into a disabled "Connecting…" with a spinner: the
 * page no longer looks dead, and a second tap can't arrive to find the single-use ticket spent.
 * A page restored from the back/forward cache gets its button back.
 *
 * Static on purpose: the label comes from the button's `data-busy`, so this text never varies and
 * the CSP pins it by hash instead of opening `script-src` up.
 */
export const BROWSER_HANDOFF_CONFIRM_SCRIPT = `(function () {
  var form = document.getElementById('handoff-confirm');
  var button = form && form.querySelector('button');
  if (!button) return;
  var label = button.querySelector('.label');
  var idle = label.textContent;
  form.addEventListener('submit', function () {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.classList.add('busy');
    label.textContent = button.getAttribute('data-busy') || idle;
  });
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.classList.remove('busy');
    label.textContent = idle;
  });
})();`;

const BROWSER_HANDOFF_CONFIRM_SCRIPT_HASH = `'sha256-${crypto.createHash('sha256').update(BROWSER_HANDOFF_CONFIRM_SCRIPT).digest('base64')}'`;

/**
 * The headers for the confirmation page. It must not be framed (a luring site could otherwise
 * overlay it and take the click), and runs no script but its own, pinned by hash.
 *
 * NO `form-action`. Chrome enforces it on every redirect after the submit, not just the POST, and
 * Continue's chain ends on another host: confirm → Hub `/api/memory-connect/start` → CI Memory's
 * consent page (or an app host, for Open). `form-action 'self'` silently stopped that last hop, so
 * Continue spent the ticket and then left the page sitting there. The page has one form, written
 * by the server, so there is no injected form for the directive to guard against.
 */
export function setBrowserHandoffConfirmHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // `no-transform`: the Hub's public origin sits behind Cloudflare, whose Email Address
  // Obfuscation rewrites the username (an email) into a "[email protected]" link that needs a
  // Cloudflare script this CSP blocks; the link then lands on Cloudflare's own block page.
  // Cloudflare skips that rewrite for no-transform responses (the body also marks it email_off).
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Frame-Options', 'DENY');
  // `same-origin`, not `no-referrer`: the latter makes Chrome send `Origin: null` on the Continue POST.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src ${BROWSER_HANDOFF_CONFIRM_SCRIPT_HASH}; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
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
export function buildBrowserHandoffConfirmHtml(input: { ticket: string; username: string; target: string; busyLabel: string }): string {
  const ticket = escapeHtml(input.ticket);
  const username = escapeHtml(input.username);
  const target = escapeHtml(input.target);
  const busyLabel = escapeHtml(input.busyLabel);

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
.btn:disabled { cursor: progress; opacity: 0.85; }
.btn .spin {
  display: none;
  width: 14px;
  height: 14px;
  margin-right: 8px;
  vertical-align: -2px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 800ms linear infinite;
}
.btn.busy .spin { display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .btn .spin { animation: none; } }
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
<p>The Companion Hub app opened this page to sign this browser in as <strong><!--email_off-->${username}<!--/email_off--></strong> and ${target}.</p>
<form id="handoff-confirm" method="post" action="${BROWSER_HANDOFF_CONFIRM_PATH}">
<input type="hidden" name="ticket" value="${ticket}">
<button class="btn" type="submit" data-busy="${busyLabel}"><span class="spin" aria-hidden="true"></span><span class="label">Continue</span></button>
</form>
<a class="btn secondary" href="/">Cancel</a>
<p class="hint">If you didn't just do this in the Hub app, press Cancel.</p>
</main>
<script>${BROWSER_HANDOFF_CONFIRM_SCRIPT}</script>
</body>
</html>`;
}
