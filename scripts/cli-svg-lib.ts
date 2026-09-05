/**
 * Pure rendering core for the cihub CLI terminal-screenshot SVGs.
 *
 * Kept free of side effects (no spawn, no fs, no top-level work) so it can be
 * unit-tested and reused by scripts/render-cli-svgs.ts.
 *
 * Every glyph is pinned to a fixed monospace grid via textLength +
 * lengthAdjust="spacingAndGlyphs", so box-drawing borders line up with content
 * regardless of the viewer's font metrics.
 */

// ── grid + palette ────────────────────────────────────────────────────────────

export const FONT = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
export const FONT_SIZE = 15;
export const CELL_W = 9; // monospace advance at 15px
export const LINE_H = 21;
export const PAD_X = 18;
export const TITLEBAR = 36;
export const PAD_TOP = 26; // gap below titlebar to first baseline
export const PAD_BOTTOM = 16;
export const COLS = 86; // captured at COLUMNS=86

const BG = '#0d1117';
const TITLEBAR_BG = '#161b22';

export type ColorKey = 'fg' | 'dim' | 'green' | 'cyan' | 'yellow' | 'red' | 'magenta' | 'prompt' | 'blue';

export const COLORS: Record<ColorKey, string> = {
  fg: '#c9d1d9',
  dim: '#6e7681',
  green: '#3fb950',
  cyan: '#39c5cf',
  yellow: '#d29922',
  red: '#f85149',
  magenta: '#bc8cff',
  prompt: '#56d364',
  blue: '#58a6ff',
};

export type Seg = { t: string; c: ColorKey; b?: boolean };
export type Line = Seg[];

// ── capture noise filter ──────────────────────────────────────────────────────

/**
 * Lines the recording harness emits on stderr that belong to the machine doing the
 * recording, not to the CLI being documented. `capture()` folds stderr into the
 * screenshot so a command's real diagnostics are visible, which also drags these in.
 *
 * The Node prefix is only ever produced by Node's internal process-warning emitter and
 * carries the recording host's PID, so it can never be legitimate cihub output. The pnpm
 * line is the workspace `.npmrc` resolving a publish token that only CI has set.
 */
const CAPTURE_NOISE = [
  /^\(node:\d+\)\s/,
  // pnpm pads the tag to `[ WARN ]` when it is not colouring, and `[WARN]` when it is.
  /^\[ ?WARN ?\] Failed to replace env in config: \$\{[^}]*\}$/,
];

/** Second half of a Node process warning — dropped only when its warning was dropped too. */
const NODE_WARNING_FOOTER = /^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/;

const stripAnsi = (s: string): string => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

/** Remove harness noise from captured output, leaving every other line byte-identical. */
export function stripCaptureNoise(input: string): string {
  const kept: string[] = [];
  let droppedNodeWarning = false;

  for (const raw of input.replace(/\r/g, '').split('\n')) {
    const plain = stripAnsi(raw).trimEnd();
    if (CAPTURE_NOISE.some((pattern) => pattern.test(plain))) {
      droppedNodeWarning = plain.startsWith('(node:');
      continue;
    }
    if (droppedNodeWarning && NODE_WARNING_FOOTER.test(plain)) continue;
    droppedNodeWarning = false;
    kept.push(raw);
  }

  return kept.join('\n');
}

// ── ANSI SGR parser ───────────────────────────────────────────────────────────

export function ansiToLines(input: string): Line[] {
  const ESC = String.fromCharCode(27);
  const lines: Line[] = [];
  let color: ColorKey = 'fg';
  let bold = false;
  let dim = false;

  for (const raw of input.replace(/\r/g, '').split('\n')) {
    const segs: Line = [];
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === ESC && raw[i + 1] === '[') {
        const end = raw.indexOf('m', i);
        if (end !== -1) {
          const codes = raw
            .slice(i + 2, end)
            .split(';')
            .map((n) => Number.parseInt(n || '0', 10));
          for (const code of codes) {
            if (code === 0) {
              color = 'fg';
              bold = false;
              dim = false;
            } else if (code === 1) bold = true;
            else if (code === 2) dim = true;
            else if (code === 31) color = 'red';
            else if (code === 32) color = 'green';
            else if (code === 33) color = 'yellow';
            else if (code === 34) color = 'blue';
            else if (code === 35) color = 'magenta';
            else if (code === 36) color = 'cyan';
            else if (code === 39) color = 'fg';
          }
          i = end + 1;
          continue;
        }
      }
      // accumulate a run of plain text under the current style
      let j = i;
      while (j < raw.length && !(raw[j] === ESC && raw[j + 1] === '[')) j += 1;
      const text = raw.slice(i, j);
      if (text.length > 0) {
        const c: ColorKey = dim ? 'dim' : color;
        const last = segs[segs.length - 1];
        if (last && last.c === c && last.b === bold) last.t += text;
        else segs.push({ t: text, c, b: bold });
      }
      i = j;
    }
    lines.push(segs);
  }
  // drop a single trailing empty line from command output
  while (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

// ── SVG emit ──────────────────────────────────────────────────────────────────

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function lineCols(line: Line): number {
  return line.reduce((n, s) => n + s.t.length, 0);
}

export function renderSvg(label: string, lines: Line[]): string {
  const maxCols = Math.max(COLS, ...lines.map(lineCols));
  const width = PAD_X * 2 + maxCols * CELL_W;
  const height = TITLEBAR + PAD_TOP + lines.length * LINE_H + PAD_BOTTOM;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="cihub ${escapeXml(label)}">`,
  );
  parts.push(`  <rect width="${width}" height="${height}" rx="12" fill="${BG}"/>`);
  parts.push(`  <rect x="0" y="0" width="${width}" height="${TITLEBAR}" rx="12" fill="${TITLEBAR_BG}"/>`);
  parts.push(`  <rect x="0" y="${TITLEBAR - 12}" width="${width}" height="12" fill="${TITLEBAR_BG}"/>`);
  parts.push(`  <circle cx="20" cy="18" r="6" fill="#ff5f57"/>`);
  parts.push(`  <circle cx="40" cy="18" r="6" fill="#febc2e"/>`);
  parts.push(`  <circle cx="60" cy="18" r="6" fill="#28c840"/>`);
  parts.push(`  <text x="${width / 2}" y="23" text-anchor="middle" fill="#8b949e" font-size="12" font-family='${FONT}'>${escapeXml(label)}</text>`);
  parts.push(`  <g font-family='${FONT}' font-size="${FONT_SIZE}" xml:space="preserve">`);

  lines.forEach((line, row) => {
    const y = TITLEBAR + PAD_TOP + row * LINE_H;
    let col = 0;
    for (const seg of line) {
      // Tokenize into maximal non-space runs; spaces are pure grid gaps so they
      // never sit inside a textLength run (which would collapse/stretch them).
      const chars = [...seg.t];
      let k = 0;
      while (k < chars.length) {
        if (chars[k] === ' ') {
          col += 1;
          k += 1;
          continue;
        }
        let run = '';
        while (k < chars.length && chars[k] !== ' ') {
          run += chars[k];
          k += 1;
        }
        const x = PAD_X + col * CELL_W;
        const tl = [...run].length * CELL_W;
        const weight = seg.b ? ' font-weight="bold"' : '';
        parts.push(
          `    <text x="${x}" y="${y}" textLength="${tl}" lengthAdjust="spacingAndGlyphs" fill="${COLORS[seg.c]}"${weight}>${escapeXml(run)}</text>`,
        );
        col += [...run].length;
      }
    }
  });

  parts.push('  </g>');
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

// ── authored-line helpers ───────────────────────────────────────────────────────

export const T = (t: string, c: ColorKey = 'fg', b = false): Seg => ({ t, c, b });
export const EMPTY: Line = [];

export function promptLine(cmd: string): Line {
  return [
    { t: '$ ', c: 'prompt' },
    { t: cmd, c: 'fg' },
  ];
}

/** A bordered box with the CLI's open-right style: top rule, indented body, bottom rule. */
export function box(title: string, body: Line[], tone: ColorKey, width = 84): Line[] {
  const titleLen = title.length;
  const fill = Math.max(width - titleLen - 5, 1);
  const top: Line = [T(`┌─ ${title} ${'─'.repeat(fill)}┐`, tone)];
  const bottom: Line = [T(`└${'─'.repeat(width - 2)}┘`, tone)];
  const indented = body.map((l) => [T('  ', 'fg'), ...l]);
  return [top, ...indented, bottom];
}

export function bannerLines(): Line[] {
  return [[T('COMPANION HUB', 'green', true)], [T('ci.computer', 'green')]];
}
