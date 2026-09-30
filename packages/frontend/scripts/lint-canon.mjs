#!/usr/bin/env node
// vendored-from: @companionintelligence/config@1.1.0 packages/config/bin/lint-canon.mjs
// CI design-canon lint gate (v6). Usage: npx ci-lint-canon [targetDir] [--tokens <tokens.json>]
//  FAIL: any `--primary` custom property that is not the canon primary (any notation) — in
//        CSS/markup AND inside JS/TS template literals (CSS-in-JS, generated stylesheets);
//        any JS/TS brand-primary property (`primary`, `brandTeal`, `brandPrimary`, ...) whose
//        literal colour is not canon; scanning a directory target and finding ZERO scannable
//        files (see the v5 note below).
//  WARN (non-blocking): CI-token `var(--X)` used but never defined (partial-swap bug);
//        enriched token used as a Tailwind utility but not mapped in `@theme` (v4 fallback-to-default bug);
//        hardcoded hex in component source.
//
//  v6: THE CANON IS READ FROM tokens.json, NOT HARDCODED HERE. Eleven repos carried copy-pasted
//  forks of this script in four variants, three of which still hardcoded the RETIRED teal as canon
//  and would have failed a correct repaint. The script is now consumed as the `ci-lint-canon` bin of
//  @companionintelligence/config and takes its canon primary + retired list from
//  @companionintelligence/tokens/tokens.json, resolved in this order:
//    1. `--tokens <file>` on the command line
//    2. `tokens` in a `lint-canon.config.json` found in the target directory (or cwd)
//    3. the installed @companionintelligence/tokens package (config depends on it)
//    4. this repo's own styles/tokens/src/tokens.json (when run from a CI-Common checkout)
//  `lint-canon.config.json` may also add `ignore` (extra directory names to skip) and `retired`
//  (extra {hex, name, replacedBy, since} entries) — the two things the forks had extended.
//
//  v4 exists because v3 scanned ZERO files in packages/video-kit and exited 0 reporting "canon OK".
//  Every source file there is `.mjs`, which was in neither CSS_EXT nor COMP_EXT, so the product-video
//  kit sat on the retired #0f717a teal and Montserrat for months with a green gate over it. Two
//  changes closed that: `.mjs`/`.cjs`/`.mts`/`.cts` are now component extensions, and a brand primary
//  declared as a JS object property is a FAIL rather than an anonymous "hardcoded hex" warning.
//
//  v5 closes the SAME failure mode one level up: v4 fixed the extension gap, but nothing stopped a
//  future gap (a new file type, a wrong TARGET path, an IGNORE entry that's too broad) from silently
//  reproducing it — `scanned: 0 css/markup, 0 component file(s)` printed as a harmless line, then
//  `✔ lint-canon: canon OK` because zero non-canon values were found in zero files. A gate that can
//  pass by finding nothing to check is not a gate. When TARGET is a directory, scanning zero files is
//  now a FAIL, not a silent green light — see lint-canon.test.mjs for the fixture regression test.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const tokensFlagIdx = argv.indexOf('--tokens');
const TOKENS_FLAG = tokensFlagIdx !== -1 ? argv[tokensFlagIdx + 1] : null;
const TARGET = argv.find((a, i) => !a.startsWith('--') && !(tokensFlagIdx !== -1 && i === tokensFlagIdx + 1)) || '.';

// ---- per-repo config (optional) ------------------------------------------------------------
function loadConfig() {
  for (const dir of [statSync(TARGET).isDirectory() ? TARGET : dirname(TARGET), process.cwd()]) {
    const f = join(dir, 'lint-canon.config.json');
    if (existsSync(f)) { try { return { dir, ...JSON.parse(readFileSync(f, 'utf8')) }; } catch (e) { console.error(`lint-canon: cannot parse ${f}: ${e.message}`); process.exit(2); } }
  }
  return {};
}
const CONFIG = loadConfig();

// ---- canon source -----------------------------------------------------------------------------
function locateTokens() {
  if (TOKENS_FLAG) return resolve(TOKENS_FLAG);
  if (CONFIG.tokens) return resolve(CONFIG.dir, CONFIG.tokens);
  try { return createRequire(import.meta.url).resolve('@companionintelligence/tokens/tokens.json'); } catch {}
  const inRepo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../styles/tokens/src/tokens.json');
  if (existsSync(inRepo)) return inRepo;
  console.error('lint-canon: cannot locate the canon tokens.json. Install @companionintelligence/tokens, pass --tokens <file>, or set "tokens" in lint-canon.config.json.');
  process.exit(2);
}
const TOKENS_PATH = locateTokens();
const TOKENS = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
const hexRgb = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; };
const CANON = [TOKENS.light.primary.hex, TOKENS.dark.primary.hex].map((hex) => ({ hex, rgb: hexRgb(hex) }));
const CANON_LABEL = `${CANON[0].hex} / ${CANON[1].hex}`;
// Retired brand values. lint-canon still FAILs on these (they are not canon), but names the
// replacement instead of just reporting "not canon" — the whole point is telling a drifted value
// apart from a typo. The list lives in tokens.json (`retired`); a repo may extend it in its config.
const RETIRED = [...(TOKENS.retired ?? []), ...(CONFIG.retired ?? [])]
  .filter((r) => r.hex)
  .map((r) => ({ rgb: hexRgb(r.hex), hex: r.hex, name: `${r.name}${r.token ? ` (${r.token} pre-${r.since})` : ''}`, replacedBy: r.replacedBy, since: r.since?.startsWith('v') ? `@companionintelligence/tokens ${r.since}` : r.since }));
const TOL = 14;
// __fixtures__ deliberately included: lint-canon.test.mjs's fixtures contain intentional
// non-canon values (that's the point of the retired-primary fixture), and would otherwise
// fail a whole-repo scan of the very repo that authors this script.
const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'coverage', 'vendor', '.cache', 'target', '.output', '.vercel', '__fixtures__',
  // the deck reaches assets/graphics/* through symlinks of these names; the origin is scanned once
  'common-svg-graphic-assets', ...(CONFIG.ignore ?? [])]);
// CI design-token namespace the transition manages — undefined uses of these are real bugs.
const CI_TOKENS = /^--(primary|secondary|muted|accent|destructive|success|warning|info|border|input|ring|card|popover|background|foreground|sidebar|chart-\d|teal-\d{2,3}|aqua|aqua-light|teal-accent|teal-mid|gradient-\w+|shadow-(sm|md|lg)|radius-\w+)(-foreground)?$/;
// standard/framework vars that are legitimately defined elsewhere (never flag as undefined)
const FRAMEWORK_VAR = /^--(tw-|radix-|swiper-|leaflet-|vp-|shiki|nextra|fd-|chakra-|mantine-|ck-)/;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const srgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function oklch(L, C, H) { const h = H * Math.PI / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((v) => Math.round(clamp(srgb(v), 0, 1) * 255)); }
function hsl(H, S, L) { H = ((H % 360) + 360) % 360; S /= 100; L /= 100; const c = (1 - Math.abs(2 * L - 1)) * S, x = c * (1 - Math.abs((H / 60) % 2 - 1)), m = L - c / 2; let r, g, b; if (H < 60)[r, g, b] = [c, x, 0]; else if (H < 120)[r, g, b] = [x, c, 0]; else if (H < 180)[r, g, b] = [0, c, x]; else if (H < 240)[r, g, b] = [0, x, c]; else if (H < 300)[r, g, b] = [x, 0, c]; else[r, g, b] = [c, 0, x]; return [r, g, b].map((v) => Math.round((v + m) * 255)); }
const num = (s) => parseFloat(s);
const lFrac = (s) => { s = s.trim(); const n = num(s); return (s.endsWith('%') ? n : (n <= 1 ? n * 100 : n)) / 100; };
function parseColor(raw) { let v = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/!important/i, '').trim(); if (/var\(/i.test(v)) return null; let m;
  if ((m = v.match(/^#([0-9a-f]{3,8})$/i))) { let h = m[1]; if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  if ((m = v.match(/^rgba?\(([^)]+)\)$/i))) { const p = m[1].split(/[,\s/]+/).filter(Boolean); return [num(p[0]), num(p[1]), num(p[2])].map(Math.round); }
  if ((m = v.match(/^hsla?\(([^)]+)\)$/i))) { const p = m[1].split(/[,\s/]+/).filter(Boolean); return hsl(num(p[0]), num(p[1]), num(p[2])); }
  if ((m = v.match(/^oklch\(([^)]+)\)$/i))) { const p = m[1].split(/[\s/]+/).filter(Boolean); return oklch(lFrac(p[0]), num(p[1]), num(p[2])); }
  if ((m = v.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)%\s+(-?\d*\.?\d+)%$/))) return hsl(num(m[1]), num(m[2]), num(m[3])); return null; }
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const isTeal = (rgb) => CANON.some((c) => dist(rgb, c.rgb) <= TOL);
const retiredMatch = (rgb) => RETIRED.find((r) => dist(rgb, r.rgb) <= TOL);

function walk(d, o = []) { let e; try { e = readdirSync(d); } catch { return o; } for (const n of e) { const p = join(d, n); let st; try { st = statSync(p); } catch { continue; } if (st.isDirectory()) { if (!IGNORE.has(n)) walk(p, o); } else o.push(p); } return o; }
const CSS_EXT = new Set(['.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte', '.astro']);
// .mjs/.cjs/.mts/.cts are here deliberately — see the v4 note at the top of this file.
const COMP_EXT = new Set(['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro', '.html', '.htm']);
const cssText = (f, x) => { const raw = readFileSync(f, 'utf8'); return ['.html', '.htm', '.vue', '.svelte', '.astro'].includes(x) ? [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n') : raw; };
const lineOf = (t, i) => t.slice(0, i).split('\n').length;

const files = statSync(TARGET).isDirectory() ? walk(TARGET) : [TARGET];
const fails = [], warns = [];
const defined = new Set(); const themeMapped = new Set(); const uses = []; // {name,rel,line}
const utilUse = new Map(); // enriched utility token -> [rel:line]
let cssN = 0, compN = 0;

const PRIMARY = /(?:^|[^\w-])--primary\s*:\s*([^;}\n]+)/g;
const DEFRE = /(?:^|[^\w-])(--[a-z0-9-]+)\s*:/gi;
const VARRE = /var\(\s*(--[a-z0-9-]+)/gi;
const THEME = /@theme[^{]*\{([\s\S]*?)\}/gi;
const HEX = /(?:bg-\[|text-\[|border-\[|from-\[|to-\[|fill=["']?|stroke=["']?|(?:background|color|fill|stroke)\s*[:=]\s*["']?)#([0-9a-fA-F]{3,8})\b/g;
// enriched Tailwind utilities whose token must be in @theme (else v4 falls back to default)
const UTIL = /\b(?:bg|text|border|ring|from|to|fill|stroke)-(teal-(?:50|100|200|300|400|500|600|700|800|900|950)|success|warning|info|aqua)\b|\b(shadow-(?:sm|md|lg))\b/g;
// A brand primary declared as a JS/TS object property — a `brandTeal` key holding the retired
// #0F717A, say — is the same canon violation as the equivalent `--primary` declaration, and is
// exactly how the video kit drifted. The leading character class excludes `.primary` (member
// access) and `--primary` (already handled by PRIMARY above).
// Deliberately no literal `<key>: "<hex>"` example in this comment: v4 scans .mjs, so the gate
// would flag its own documentation.
//
// GENERIC vs BRANDED keys (v5): `primary`/`primaryColor`/`primaryColour` are common third-party
// config keys with nothing to do with CI's brand — Mermaid.js's own `themeVariables.primaryColor`
// and a legitimate user-selectable alternate app theme both use exactly this shape with an
// unrelated color, and both false-failed a real fleet-wide run before this split existed. Only
// `brand*`-prefixed keys (a name nobody else's config happens to use) FAIL on ANY non-canon color;
// the generic keys FAIL only when the color actually resembles a RETIRED CI value — that keeps
// catching the exact video-kit scenario (retired teal renamed to `primaryColor`) while not
// flagging every third-party or user-preference theme that happens to use the word "primary".
const JS_PRIMARY_BRANDED = /(?:^|[^\w$.-])(brand|brandTeal|brandColor|brandPrimary)\s*:\s*(['"`])(#[0-9a-fA-F]{3,8}|rgba?\([^)'"`]*\)|hsla?\([^)'"`]*\)|oklch\([^)'"`]*\))\2/g;
const JS_PRIMARY_GENERIC = /(?:^|[^\w$.-])(primary|primaryColor|primaryColour)\s*:\s*(['"`])(#[0-9a-fA-F]{3,8}|rgba?\([^)'"`]*\)|hsla?\([^)'"`]*\)|oklch\([^)'"`]*\))\2/g;

for (const f of files) {
  const x = extname(f).toLowerCase(); const rel = relative(process.cwd(), f) || f;
  if (CSS_EXT.has(x)) { cssN++; const t = cssText(f, x);
    for (const m of t.matchAll(PRIMARY)) { const rgb = parseColor(m[1].trim()); if (rgb && !isTeal(rgb)) fails.push({ rel, line: lineOf(t, m.index), val: m[1].trim(), rgb, what: '--primary' }); }
    for (const m of t.matchAll(DEFRE)) defined.add(m[1].toLowerCase());
    for (const m of t.matchAll(VARRE)) uses.push({ name: m[1].toLowerCase(), rel, line: lineOf(t, m.index) });
    for (const th of t.matchAll(THEME)) for (const dm of th[1].matchAll(DEFRE)) themeMapped.add(dm[1].toLowerCase());
  }
  if (COMP_EXT.has(x)) { compN++; const raw = readFileSync(f, 'utf8');
    // JS/TS carries CSS too — template-literal stylesheets, CSS-in-JS, a generated <style> block.
    // Run the same --primary rule over it rather than trusting that CSS only ever lives in .css.
    if (!CSS_EXT.has(x)) for (const m of raw.matchAll(PRIMARY)) { const rgb = parseColor(m[1].trim()); if (rgb && !isTeal(rgb)) fails.push({ rel, line: lineOf(raw, m.index), val: m[1].trim(), rgb, what: '--primary' }); }
    for (const m of raw.matchAll(JS_PRIMARY_BRANDED)) { const rgb = parseColor(m[3]); if (rgb && !isTeal(rgb)) fails.push({ rel, line: lineOf(raw, m.index), val: m[3], rgb, what: m[1] }); }
    for (const m of raw.matchAll(JS_PRIMARY_GENERIC)) { const rgb = parseColor(m[3]); if (rgb && !isTeal(rgb) && retiredMatch(rgb)) fails.push({ rel, line: lineOf(raw, m.index), val: m[3], rgb, what: m[1] }); }
    for (const m of raw.matchAll(HEX)) warns.push({ type: 'hex', rel, line: lineOf(raw, m.index), msg: '#' + m[1] });
    for (const m of raw.matchAll(UTIL)) { const tok = (m[1] || m[2]); if (!utilUse.has(tok)) utilUse.set(tok, `${rel}:${lineOf(raw, m.index)}`); }
  }
}

// undefined CI-token var uses (partial-swap bug)
const seenUndef = new Set();
for (const u of uses) { if (!CI_TOKENS.test(u.name) || defined.has(u.name) || FRAMEWORK_VAR.test(u.name)) continue; if (seenUndef.has(u.name)) continue; seenUndef.add(u.name);
  warns.push({ type: 'undef', rel: u.rel, line: u.line, msg: `var(${u.name}) used but --${u.name.slice(2)} is never defined` }); }

// @theme completeness (v4 fallback-to-default bug) — only if the repo uses @theme
const hasTheme = themeMapped.size > 0;
if (hasTheme) for (const [tok, at] of utilUse) {
  const cssName = '--' + tok; const colorName = '--color-' + tok; const isShadow = tok.startsWith('shadow-');
  const defd = defined.has(cssName); const mapped = isShadow ? themeMapped.has(cssName) : (themeMapped.has(colorName) || themeMapped.has(cssName));
  if (defd && !mapped) warns.push({ type: 'theme', rel: at.split(':')[0], line: Number(at.split(':')[1]), msg: `utility uses ${tok} but ${isShadow ? cssName : colorName} is not in @theme (Tailwind v4 will use its default, not the CI token)` });
}

// A directory target that scans zero files means the scan is broken, not clean — see the v5 note
// at the top of this file. A file target (single-file invocations, e.g. from an editor) is exempt:
// scanning "zero files" there just means the one file's extension isn't recognized, which is a
// caller error, not a gate hole.
const isDirTarget = statSync(TARGET).isDirectory();
if (isDirTarget && cssN === 0 && compN === 0) {
  console.log('CI design-canon lint (v6)');
  console.log(`  target: ${TARGET}\n  canon: ${CANON_LABEL} (${relative(process.cwd(), TOKENS_PATH)})\n  scanned: 0 css/markup, 0 component file(s)\n`);
  console.log(`✖ scanned 0 files under ${TARGET} — that is a broken gate, not a clean one.`);
  console.log('  Check TARGET is correct and that CSS_EXT/COMP_EXT cover the file types in this repo.');
  console.log('lint-canon: FAILED');
  process.exit(1);
}

// report
console.log('CI design-canon lint (v6)');
console.log(`  target: ${TARGET}\n  canon: ${CANON_LABEL} (${relative(process.cwd(), TOKENS_PATH) || TOKENS_PATH})\n  scanned: ${cssN} css/markup, ${compN} component file(s)\n`);
const grp = (t) => warns.filter((w) => w.type === t);
for (const [t, label] of [['undef', 'undefined CI-token var (likely a partial token swap)'], ['theme', 'missing @theme mapping (Tailwind v4 falls back to its default)'], ['hex', 'hardcoded hex in component source']]) {
  const g = grp(t); if (!g.length) continue;
  console.log(`⚠ ${g.length} ${label}:`);
  for (const w of g.slice(0, 30)) console.log(`  warn ${w.rel}:${w.line}  ${w.msg}`);
  if (g.length > 30) console.log(`  … and ${g.length - 30} more`); console.log('');
}
if (fails.length) { console.log(`✖ ${fails.length} non-canon brand-primary value(s):`);
  for (const x of fails) {
    const retired = retiredMatch(x.rgb);
    const note = retired ? `  — this is ${retired.name}, replaced by ${retired.replacedBy} in ${retired.since}` : '';
    console.log(`  FAIL ${x.rel}:${x.line}  ${x.what}: ${x.val} -> rgb(${x.rgb.join(',')})${note}`);
  }
  console.log(`\n  The brand primary must be the canon ${CANON_LABEL} (any notation).\nlint-canon: FAILED`); process.exit(1); }
console.log('✔ lint-canon: canon OK (every brand primary is the canon ' + CANON_LABEL + ')' + (warns.length ? ` — ${warns.length} non-blocking warning(s) above` : ''));
process.exit(0);
