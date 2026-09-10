import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tailwind emits nothing for a colour utility whose token does not exist. No build error,
 * no console warning — the class is simply absent from the stylesheet and the element
 * renders unstyled.
 *
 * `hub-pool-settings.tsx` carried `border-danger/30 bg-danger/10 text-danger` on the Hub
 * Pool error banner and `text-danger` on the routing-failure marker. There is no
 * `--color-danger`: the tokens package defines `--color-destructive` and `--color-ci-danger`
 * (globals.css:61, :109). So the pool's most important error state and its failure marker
 * both rendered with no colour at all, and had done since they were written.
 *
 * This test exists because nothing else can catch it. A snapshot passes — the class string
 * is in the DOM. Only the absence of a matching token gives it away.
 */

const SRC = resolve(__dirname, '..');

/** Colour utilities whose token this design system does not define. */
const UNDEFINED_COLOUR_UTILITIES = [
  // `danger` is not a token. Use `destructive` (shadcn semantic ramp, what this app uses)
  // or `ci-danger` (the CI extension) — both are real.
  /\b(?:text|bg|border|ring|fill|stroke|divide|outline|shadow|accent|caret|decoration)-danger(?:\/\d+)?\b/,
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('colour utilities', () => {
  it('never references a colour token this design system does not define', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      // This file names the offending classes in prose in order to explain them.
      if (file === __filename) continue;
      const text = readFileSync(file, 'utf-8');
      text.split('\n').forEach((line, i) => {
        // `ci-danger` IS defined; only the bare `danger` ramp is missing.
        if (line.includes('ci-danger')) return;
        for (const pattern of UNDEFINED_COLOUR_UTILITIES) {
          if (pattern.test(line)) offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders, `these classes emit no CSS and render unstyled:\n${offenders.join('\n')}`).toEqual([]);
  });
});
