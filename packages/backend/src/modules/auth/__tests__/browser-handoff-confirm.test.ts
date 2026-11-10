import { describe, expect, it } from 'vitest';
import { buildBrowserHandoffConfirmHtml, describeBrowserHandoffTarget } from '../browser-handoff-confirm';

describe('browser-handoff confirmation page', () => {
  it('names a Memory connect in words and anything else by its host, never by its query', () => {
    expect(describeBrowserHandoffTarget('https://hub.example/api/memory-connect/start?app=ci-hermes:store')).toBe('connect an app to CI Memory');
    expect(describeBrowserHandoffTarget('https://ci-hermes-core-2-myorg.example.com/chat?x=<b>')).toBe('open ci-hermes-core-2-myorg.example.com');
    expect(describeBrowserHandoffTarget('not a url')).toBe('continue');
  });

  it('escapes the username and the ticket, and carries no script', () => {
    const html = buildBrowserHandoffConfirmHtml({
      ticket: '"><script>x</script>',
      username: '<img src=x onerror=alert(1)>',
      target: 'open a.example',
    });

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
  });
});
