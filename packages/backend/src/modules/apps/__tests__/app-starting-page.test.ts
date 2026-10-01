import { describe, expect, it } from 'vitest';
import type { AppStatus } from '@/core/database/drizzle/types';
import {
  APP_STARTING_RELOAD_SECONDS,
  type AppStartingPage,
  RECENTLY_STARTED_MS,
  appStartingPageHeaders,
  appStartingPageStatus,
  classifyApp,
  renderAppStartingPage,
} from '../app-starting-page';

const NOW = Date.parse('2026-10-01T12:00:00Z');
/** A Hub that has been up for a day, so only the app's own row can make it "recent". */
const HUB_STARTED_LONG_AGO = NOW - 24 * 60 * 60_000;

const classify = (status: AppStatus, overrides: Partial<Parameters<typeof classifyApp>[0]> = {}) =>
  classifyApp({ status, changedAtMs: NOW - 60 * 60_000, hubStartedAtMs: HUB_STARTED_LONG_AGO, nowMs: NOW, hubStartsIt: true, ...overrides });

describe('classifyApp', () => {
  it.each<AppStatus>(['installing', 'starting', 'restarting', 'updating', 'resetting', 'backing_up', 'restoring'])(
    'reads %s as starting: the app comes back without anyone pressing Start',
    (status) => {
      expect(classify(status)).toBe('starting');
    },
  );

  it.each<AppStatus>(['stopped', 'stopping'])('reads %s as stopped', (status) => {
    expect(classify(status)).toBe('stopped');
  });

  it.each<AppStatus>(['install_failed', 'missing', 'uninstalling'])('reads %s as not responding', (status) => {
    expect(classify(status)).toBe('not_responding');
  });

  it('reads a running app that started a moment ago as starting: up is not the same as listening', () => {
    expect(classify('running', { changedAtMs: NOW - 30_000 })).toBe('starting');
    expect(classify('running', { changedAtMs: NOW - RECENTLY_STARTED_MS + 1 })).toBe('starting');
  });

  it('reads a running app that started longer ago as not responding', () => {
    expect(classify('running', { changedAtMs: NOW - RECENTLY_STARTED_MS })).toBe('not_responding');
    expect(classify('running', { changedAtMs: NOW - 60 * 60_000 })).toBe('not_responding');
  });

  it('reads every running app as starting while the Hub itself has only just started, as after a reboot', () => {
    expect(classify('running', { hubStartedAtMs: NOW - 45_000 })).toBe('starting');
    expect(classify('running', { hubStartedAtMs: NOW - RECENTLY_STARTED_MS })).toBe('not_responding');
  });

  it('never guesses "starting" for a port-expose app, which the Hub does not start', () => {
    expect(classify('running', { changedAtMs: NOW - 5_000, hubStartsIt: false })).toBe('not_responding');
    expect(classify('running', { hubStartedAtMs: NOW - 5_000, hubStartsIt: false })).toBe('not_responding');
  });

  it('does not let a timestamp from the future or an unreadable one keep an app "starting"', () => {
    expect(classify('running', { changedAtMs: NOW + 60 * 60_000 })).toBe('not_responding');
    expect(classify('running', { changedAtMs: Number.NaN })).toBe('not_responding');
    expect(classify('running', { changedAtMs: null })).toBe('not_responding');
  });
});

describe('appStartingPageStatus', () => {
  it.each(['502', '503', '504'])('keeps %s, the status Traefik caught', (status) => {
    expect(appStartingPageStatus(status)).toBe(Number(status));
  });

  it.each([undefined, '', '200', '500', '404', '5020', '502abc', ' 502', 502, {}])('answers 503 for %j', (status) => {
    expect(appStartingPageStatus(status)).toBe(503);
  });

  it('takes the first of a repeated parameter', () => {
    expect(appStartingPageStatus(['504', '502'])).toBe(504);
  });
});

describe('appStartingPageHeaders', () => {
  it('keeps every page out of caches: it stands at the app’s own URL', () => {
    for (const state of ['starting', 'stopped', 'not_responding', 'unknown'] as const) {
      expect(appStartingPageHeaders({ state })['Cache-Control']).toBe('no-store');
    }
  });

  it('allows the inline styles and nothing else, so no script can run on the app’s origin', () => {
    const csp = appStartingPageHeaders({ state: 'stopped' })['Content-Security-Policy'];

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toContain('script-src');
  });

  it('tells clients when to try again only while the app is starting', () => {
    expect(appStartingPageHeaders({ state: 'starting' })['Retry-After']).toBe(String(APP_STARTING_RELOAD_SECONDS));
    expect(appStartingPageHeaders({ state: 'stopped' })).not.toHaveProperty('Retry-After');
    expect(appStartingPageHeaders({ state: 'not_responding' })).not.toHaveProperty('Retry-After');
    expect(appStartingPageHeaders({ state: 'unknown' })).not.toHaveProperty('Retry-After');
  });
});

describe('renderAppStartingPage', () => {
  const HUB_APP_URL = 'https://hub1-acme.ci0.pw/apps/ci-marketplace/ci-hermes';

  it('says the app is starting and reloads itself', () => {
    const html = renderAppStartingPage({ state: 'starting', appName: 'Hermes', hubUrl: HUB_APP_URL });

    expect(html).toContain('<title>Hermes is starting…</title>');
    expect(html).toContain('<h1>Hermes is starting…</h1>');
    expect(html).toContain(`<meta http-equiv="refresh" content="${APP_STARTING_RELOAD_SECONDS}">`);
    expect(html).toContain('reloads by itself');
    expect(html).toContain('class="spinner"');
    // Nothing to do while it starts, so no button pulling the visitor away.
    expect(html).not.toContain('class="btn"');
  });

  it('says a stopped app is stopped and links to it in the Hub, without reloading', () => {
    const html = renderAppStartingPage({ state: 'stopped', appName: 'Hermes', hubUrl: HUB_APP_URL });

    expect(html).toContain('<h1>Hermes is stopped</h1>');
    expect(html).toContain(`<a class="btn" href="${HUB_APP_URL}">Open Companion Hub</a>`);
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("says an app that should be up isn't responding and links to its page in the Hub", () => {
    const html = renderAppStartingPage({ state: 'not_responding', appName: 'Hermes', hubUrl: HUB_APP_URL });

    expect(html).toContain('<h1>Hermes isn&#39;t responding</h1>');
    expect(html).toContain(`<a class="btn" href="${HUB_APP_URL}">Open Hermes in Companion Hub</a>`);
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it('says something generic for a host that matched no app', () => {
    const html = renderAppStartingPage({ state: 'unknown', hubUrl: 'https://hub1-acme.ci0.pw' });

    expect(html).toContain('<h1>This app isn&#39;t responding</h1>');
    expect(html).toContain('<a class="btn" href="https://hub1-acme.ci0.pw/">Open Companion Hub</a>');
  });

  it('drops the button when the Hub has no address to link to', () => {
    for (const page of [
      { state: 'stopped', appName: 'Hermes', hubUrl: null },
      { state: 'not_responding', appName: 'Hermes' },
      { state: 'unknown', hubUrl: null },
    ] satisfies AppStartingPage[]) {
      expect(renderAppStartingPage(page)).not.toContain('<a ');
    }
  });

  it('escapes a hostile app name everywhere it appears', () => {
    const hostile = `<script>alert(1)</script>"'&<img src=x onerror=alert(2)>`;
    const escaped = '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;&lt;img src=x onerror=alert(2)&gt;';

    for (const state of ['starting', 'stopped', 'not_responding'] as const) {
      const html = renderAppStartingPage({ state, appName: hostile, hubUrl: HUB_APP_URL });

      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      expect(html).toContain(`<title>${escaped}`);
      expect(html).toContain(`<h1>${escaped}`);
    }
    // The name also sits inside the starting text and the not-responding button.
    expect(renderAppStartingPage({ state: 'starting', appName: hostile })).toContain(`opens ${escaped} as soon`);
    expect(renderAppStartingPage({ state: 'not_responding', appName: hostile, hubUrl: HUB_APP_URL })).toContain(
      `>Open ${escaped} in Companion Hub</a>`,
    );
  });

  it('keeps a multi-line name on one line, and names an app without one generically', () => {
    expect(renderAppStartingPage({ state: 'stopped', appName: '  My\n\tApp  ' })).toContain('<h1>My App is stopped</h1>');
    expect(renderAppStartingPage({ state: 'stopped', appName: '   ' })).toContain('<h1>This app is stopped</h1>');
  });

  it('links nowhere but an http(s) address', () => {
    const html = renderAppStartingPage({ state: 'stopped', appName: 'Hermes', hubUrl: 'javascript:alert(1)' });

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
  });

  it('escapes the link it does make', () => {
    const html = renderAppStartingPage({ state: 'stopped', appName: 'Hermes', hubUrl: 'https://hub.example/apps/a"b' });

    expect(html).toContain('href="https://hub.example/apps/a%22b"');
  });

  it('loads nothing and runs nothing: no scripts, no external assets', () => {
    for (const state of ['starting', 'stopped', 'not_responding', 'unknown'] as const) {
      const html = renderAppStartingPage({ state, appName: 'Hermes', hubUrl: HUB_APP_URL });

      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/\bsrc=/i);
      expect(html).not.toMatch(/@import|url\(/i);
      // The only href besides the Hub link: an empty icon, so the browser does not ask the failing
      // app for /favicon.ico.
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
      expect(hrefs.filter((href) => href !== HUB_APP_URL)).toEqual(['data:,']);
    }
  });

  it('has a light and a dark look, and a still spinner for reduced motion', () => {
    const html = renderAppStartingPage({ state: 'starting', appName: 'Hermes' });

    expect(html).toContain('<meta name="color-scheme" content="dark light">');
    expect(html).toContain('@media (prefers-color-scheme: light)');
    expect(html).toContain('@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }');
  });
});
