import { describe, expect, it } from 'vitest';
import { ansiToLines, bannerLines, box, escapeXml, lineCols, promptLine, renderSvg, stripCaptureNoise, T } from '../cli-svg-lib';

const ESC = '';
const g = (code: number) => `${ESC}[${code}m`;
const RESET = g(0);

// ─── ANSI parser ────────────────────────────────────────────────────────────────

describe('ansiToLines', () => {
  it('parses plain text into a single fg segment', () => {
    const lines = ansiToLines('hello world');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([{ t: 'hello world', c: 'fg', b: false }]);
  });

  it('maps SGR colour codes to colour keys', () => {
    const lines = ansiToLines(`${g(32)}green${RESET} ${g(36)}cyan${RESET}`);
    const flat = lines[0];
    expect(flat.find((s) => s.t === 'green')?.c).toBe('green');
    expect(flat.find((s) => s.t === 'cyan')?.c).toBe('cyan');
  });

  it('tracks bold and dim as style flags', () => {
    const bold = ansiToLines(`${g(1)}B${RESET}`)[0][0];
    expect(bold.b).toBe(true);
    const dim = ansiToLines(`${g(2)}D${RESET}`)[0][0];
    expect(dim.c).toBe('dim');
  });

  it('resets colour and style on code 0', () => {
    const segs = ansiToLines(`${g(31)}red${RESET}plain`)[0];
    expect(segs[0]).toMatchObject({ t: 'red', c: 'red' });
    expect(segs[1]).toMatchObject({ t: 'plain', c: 'fg', b: false });
  });

  it('handles combined codes like bold+green in one escape', () => {
    const seg = ansiToLines(`${ESC}[1;32mX${RESET}`)[0][0];
    expect(seg.c).toBe('green');
    expect(seg.b).toBe(true);
  });

  it('splits on newlines and drops a single trailing blank line', () => {
    const lines = ansiToLines('a\nb\n');
    expect(lines).toHaveLength(2);
    expect(lines[0][0].t).toBe('a');
    expect(lines[1][0].t).toBe('b');
  });

  it('merges adjacent runs of the same style', () => {
    const segs = ansiToLines(`${g(32)}foo${g(32)}bar${RESET}`)[0];
    expect(segs).toHaveLength(1);
    expect(segs[0].t).toBe('foobar');
  });
});

// ─── capture noise filter ──────────────────────────────────────────────────────

describe('stripCaptureNoise', () => {
  const NODE_WARNING = "(node:92948) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.";
  const NODE_FOOTER = '(Use `node --trace-warnings ...` to show where the warning was created)';
  const PNPM_WARNING = '[WARN] Failed to replace env in config: ${NODE_AUTH_TOKEN}';

  it('drops the FORCE_COLOR warning the renderer induces, along with its trace-warnings footer', () => {
    expect(stripCaptureNoise(`${NODE_WARNING}\n${NODE_FOOTER}\nUsage: cihub <command>`)).toBe('Usage: cihub <command>');
  });

  it('never leaks the recording host PID into the rendered art', () => {
    expect(stripCaptureNoise(`${NODE_WARNING}\nreal output`)).not.toMatch(/node:\d+/);
  });

  it("drops pnpm's .npmrc token complaint", () => {
    expect(stripCaptureNoise(`${PNPM_WARNING}\nreal output`)).toBe('real output');
  });

  // pnpm pads the tag when it is not colouring and does not when it is, so the renderer sees
  // both spellings depending on whether FORCE_COLOR reached the inner process.
  it('drops the padded spelling of the same pnpm warning', () => {
    expect(stripCaptureNoise('[ WARN ] Failed to replace env in config: ${NODE_AUTH_TOKEN}\nreal output')).toBe('real output');
  });

  it('matches noise that arrived wrapped in ANSI colour codes', () => {
    expect(
      stripCaptureNoise(
        `${g(43)}${g(33)}[${RESET}${g(30)}WARN${RESET}${g(33)}]${RESET} Failed to replace env in config: \${NODE_AUTH_TOKEN}\nreal output`,
      ),
    ).toBe('real output');
  });

  it('keeps a trace-warnings footer whose own warning was kept', () => {
    const kept = '(node) some other shape of warning';
    expect(stripCaptureNoise(`${kept}\n${NODE_FOOTER}`)).toBe(`${kept}\n${NODE_FOOTER}`);
  });

  it('leaves legitimate command output byte-identical, blank lines included', () => {
    const real = 'Commands:\n\n  wizard   Guided setup\n  status   Show hub status\n';
    expect(stripCaptureNoise(real)).toBe(real);
  });

  it('does not swallow a genuine warning that merely starts with a bracket tag', () => {
    const real = '[ WARN ] Docker daemon is not running';
    expect(stripCaptureNoise(real)).toBe(real);
  });
});

// ─── XML escaping ─────────────────────────────────────────────────────────────

describe('escapeXml', () => {
  it('escapes &, <, and >', () => {
    expect(escapeXml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes ampersand before angle brackets to avoid double-encoding', () => {
    expect(escapeXml('<name>')).toBe('&lt;name&gt;');
  });
});

// ─── line measurement ──────────────────────────────────────────────────────────

describe('lineCols', () => {
  it('sums the character length across segments', () => {
    expect(lineCols([T('abc'), T('de', 'green')])).toBe(5);
  });

  it('is zero for an empty line', () => {
    expect(lineCols([])).toBe(0);
  });
});

// ─── SVG output ─────────────────────────────────────────────────────────────────

describe('renderSvg', () => {
  const svg = renderSvg('cihub --help', [promptLine('cihub --help'), ...bannerLines()]);

  it('produces a well-formed root svg element with a viewBox', () => {
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('viewBox="0 0 ');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('draws the three traffic-light circles', () => {
    expect(svg).toContain('fill="#ff5f57"');
    expect(svg).toContain('fill="#febc2e"');
    expect(svg).toContain('fill="#28c840"');
  });

  it('pins every glyph run with textLength + spacingAndGlyphs', () => {
    const texts = svg.match(/<text [^>]*textLength=/g) ?? [];
    expect(texts.length).toBeGreaterThan(0);
    expect(svg).toContain('lengthAdjust="spacingAndGlyphs"');
  });

  it('never emits a space character inside a pinned run', () => {
    // grid alignment depends on spaces being gaps, not glyphs
    const runs = [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    const gridRuns = runs.filter((_r, i) => i > 0); // skip the title-bar label
    for (const r of gridRuns) {
      expect(r).not.toMatch(/ /);
    }
  });

  it('escapes XML metacharacters in content', () => {
    const withAngles = renderSvg('x', [[T('app add <name> <image>')]]);
    expect(withAngles).toContain('&lt;name&gt;');
    expect(withAngles).not.toContain('<name>');
  });

  it('renders the COMPANION HUB banner text in green', () => {
    expect(svg).toContain('>COMPANION</text>');
    expect(svg).toContain('fill="#3fb950"');
  });
});

// ─── box helper (authored scenes) ───────────────────────────────────────────────

describe('box', () => {
  it('produces aligned top and bottom rules of equal width', () => {
    const lines = box('Title', [[T('content')]], 'cyan', 40);
    const top = lines[0][0].t;
    const bottom = lines[lines.length - 1][0].t;
    expect(top.length).toBe(bottom.length);
    expect(top).toContain('┌─ Title');
    expect(bottom.startsWith('└')).toBe(true);
    expect(bottom.endsWith('┘')).toBe(true);
  });

  it('indents body lines by two columns', () => {
    const lines = box('T', [[T('hi')]], 'green', 30);
    expect(lines[1][0].t).toBe('  ');
    expect(lines[1][1].t).toBe('hi');
  });

  it('colours the border with the requested tone', () => {
    const lines = box('T', [[T('x')]], 'yellow', 20);
    expect(lines[0][0].c).toBe('yellow');
    expect(lines[lines.length - 1][0].c).toBe('yellow');
  });
});

// ─── prompt + banner helpers ─────────────────────────────────────────────────────

describe('promptLine & bannerLines', () => {
  it('renders a green $ prompt followed by the command', () => {
    const line = promptLine('cihub status');
    expect(line[0]).toEqual({ t: '$ ', c: 'prompt' });
    expect(line[1]).toEqual({ t: 'cihub status', c: 'fg' });
  });

  it('renders COMPANION HUB over ci.computer in green', () => {
    const lines = bannerLines();
    expect(lines[0][0]).toMatchObject({ t: 'COMPANION HUB', c: 'green', b: true });
    expect(lines[1][0]).toMatchObject({ t: 'ci.computer', c: 'green' });
  });
});
