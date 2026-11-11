import crypto from 'node:crypto';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_HANDOFF_CONFIRM_SCRIPT,
  browserHandoffBusyLabel,
  buildBrowserHandoffConfirmHtml,
  describeBrowserHandoffTarget,
  setBrowserHandoffConfirmHeaders,
} from '../browser-handoff-confirm';

const page = (overrides: Partial<Parameters<typeof buildBrowserHandoffConfirmHtml>[0]> = {}) =>
  buildBrowserHandoffConfirmHtml({
    ticket: 't-1',
    username: 'op@example.com',
    target: 'connect an app to CI Memory',
    busyLabel: 'Connecting…',
    ...overrides,
  });

describe('browser-handoff confirmation page', () => {
  it('names a Memory connect in words and anything else by its host, never by its query', () => {
    expect(describeBrowserHandoffTarget('https://hub.example/api/memory-connect/start?app=ci-hermes:store')).toBe('connect an app to CI Memory');
    expect(describeBrowserHandoffTarget('https://ci-hermes-core-2-myorg.example.com/chat?x=<b>')).toBe('open ci-hermes-core-2-myorg.example.com');
    expect(describeBrowserHandoffTarget('not a url')).toBe('continue');
  });

  it('says Connecting for a Memory connect and Opening for anything else while Continue is under way', () => {
    expect(browserHandoffBusyLabel('https://hub.example/api/memory-connect/start?app=ci-hermes:store')).toBe('Connecting…');
    expect(browserHandoffBusyLabel('https://ci-hermes-core-2-myorg.example.com/')).toBe('Opening…');
    expect(browserHandoffBusyLabel('not a url')).toBe('Continuing…');
  });

  it('gives Continue its busy label and a spinner to show once it is pressed', () => {
    const html = page();

    expect(html).toContain('data-busy="Connecting…"><span class="spin" aria-hidden="true"></span><span class="label">Continue</span></button>');
    expect(html).toContain('<form id="handoff-confirm"');
  });

  it('carries exactly its own script, and the CSP allows that script by hash and nothing else', () => {
    const html = page();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toEqual([BROWSER_HANDOFF_CONFIRM_SCRIPT]);

    const res = { setHeader: vi.fn() } as unknown as Response;
    setBrowserHandoffConfirmHeaders(res);
    const csp = vi.mocked(res.setHeader).mock.calls.find(([name]) => name === 'Content-Security-Policy')?.[1] as string;
    const hash = crypto
      .createHash('sha256')
      .update(scripts[0] ?? '')
      .digest('base64');
    expect(csp).toContain(`script-src 'sha256-${hash}';`);
    // Styles may be inline; scripts may not.
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('escapes the username, the ticket and the busy label, so none can add markup or script', () => {
    const html = page({
      ticket: '"><script>x</script>',
      username: '<img src=x onerror=alert(1)>',
      busyLabel: '"><script>y</script>',
    });

    // Only the page's own script tag survives.
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
    expect(html).toContain('data-busy="&quot;&gt;&lt;script&gt;y&lt;/script&gt;"');
  });
});
