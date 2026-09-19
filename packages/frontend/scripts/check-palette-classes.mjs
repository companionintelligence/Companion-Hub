#!/usr/bin/env node
/**
 * Raw Tailwind palette classes — a ratchet, not a ban.
 *
 * `text-yellow-500`, `bg-gray-800`, `border-red-400` and friends do not follow the theme: they
 * paint the same hex in light and dark and ignore every token in @companionintelligence/tokens.
 * docs/UI-STYLE-GUIDE.md exists to stop that drift, and the 2026-09-17 GUI review counted 149
 * such classes across 23 files anyway. Banning them outright would mean converting all of them
 * in one PR; this instead pins the count per file and fails when a file GROWS. Convert a file,
 * run `--update`, commit the smaller baseline. The number only goes down.
 *
 *   pnpm --filter frontend lint:palette            # check
 *   pnpm --filter frontend lint:palette --update   # rewrite the baseline to the current counts
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const BASELINE = fileURLToPath(new URL('./palette-baseline.json', import.meta.url));

// Utility prefix, palette name, shade. Word-bounded so `text-warning` and `bg-primary` (tokens)
// never match, and neither does a `slate-900` fragment inside a longer identifier.
const PATTERN =
  /(?<![\w-])(?:text|bg|border|ring|outline|divide|from|via|to|fill|stroke|shadow|accent|caret|decoration|placeholder)-(?:red|yellow|green|blue|amber|orange|purple|pink|indigo|teal|cyan|emerald|lime|sky|violet|fuchsia|rose|slate|gray|zinc|neutral|stone)-[0-9]{2,3}(?![\w-])/g;

/** Files where the palette IS the content. */
const ALLOW = new Set([
  // A colour picker shows the palette by design.
  'modules/settings/components/color-selector/color-selector.tsx',
]);

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
};

const counts = {};
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).split(sep).join('/');
  if (ALLOW.has(rel)) continue;
  const n = (readFileSync(file, 'utf8').match(PATTERN) ?? []).length;
  if (n > 0) counts[rel] = n;
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, `${JSON.stringify({ total, files: sorted }, null, 2)}\n`);
  console.log(`palette baseline written: ${total} raw palette classes in ${Object.keys(counts).length} files`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const grew = Object.entries(counts).filter(([file, n]) => n > (baseline.files[file] ?? 0));

if (grew.length > 0) {
  console.error('Raw Tailwind palette classes increased — use the theme tokens (docs/UI-STYLE-GUIDE.md):');
  for (const [file, n] of grew) {
    console.error(`  ${file}: ${n} (baseline ${baseline.files[file] ?? 0})`);
  }
  console.error(`\nTotal ${total}, baseline ${baseline.total}. If a new palette class is genuinely the content, add the file to ALLOW.`);
  process.exit(1);
}

if (total < baseline.total) {
  console.log(`palette: ${total} raw classes, baseline ${baseline.total} — ratchet it down with: pnpm --filter frontend lint:palette --update`);
} else {
  console.log(`palette: ${total} raw classes, at baseline`);
}
