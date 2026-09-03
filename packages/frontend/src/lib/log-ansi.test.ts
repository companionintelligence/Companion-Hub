import { describe, expect, it } from 'vitest';
import { colorizeLogLine } from './log-ansi';

describe('colorizeLogLine', () => {
  it('uses readable default and black tones in light mode', () => {
    const html = colorizeLogLine('\x1b[39mdefault\x1b[0m \x1b[30mblack\x1b[0m', 'light');

    expect(html).toContain('color:#0f172a');
    expect(html).toContain('color:#334155');
    expect(html).not.toContain('color:#FFF');
    expect(html).not.toContain('color:#000');
  });

  it('uses readable default and black tones in dark mode', () => {
    const html = colorizeLogLine('\x1b[39mdefault\x1b[0m \x1b[30mblack\x1b[0m', 'dark');

    expect(html).toContain('color:#d7e6e4');
    expect(html).toContain('color:#94a3b8');
    expect(html).not.toContain('color:#FFF');
    expect(html).not.toContain('color:#000');
  });

  it('escapes HTML in raw log lines', () => {
    const html = colorizeLogLine('<script>alert(1)</script>', 'light');

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
