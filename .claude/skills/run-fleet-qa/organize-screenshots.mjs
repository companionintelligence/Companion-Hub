#!/usr/bin/env node
/**
 * organize-screenshots.mjs — sort the flat fleet-QA screenshot dump into a
 * per-app archive with app+time filenames.
 *
 * The fleet server scps each node's capture to a flat file named
 * `<node>_<appId>.png` in `~/qa-results/fleet-screenshots/`, OVERWRITING the
 * prior run's same-named file. That's why the dashboard shows stale thumbnails
 * (the browser caches the unchanged URL) and why there's no history.
 *
 * This makes one folder per app and copies each screenshot in under a name that
 * carries the app id and the time it was taken:
 *
 *   ~/qa-results/fleet-screenshots/by-app/<appId>/<appId>_<YYYYMMDD-HHMMSS>[_<node>].png
 *   ~/qa-results/fleet-screenshots/by-app/<appId>/latest.png   (stable, newest)
 *
 * "Time taken" comes from the matching row's `timestamp` in results.json when
 * available, else the PNG's mtime. Idempotent: a destination that already exists
 * is skipped, so it's safe to re-run (e.g. on a cron during a live run).
 *
 * Usage:
 *   node organize-screenshots.mjs                 # default ~/qa-results/fleet-screenshots
 *   node organize-screenshots.mjs <dir> [results.json]
 */
import { readdirSync, mkdirSync, copyFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const SRC = process.argv[2] || join(homedir(), 'qa-results', 'fleet-screenshots');
const RESULTS = process.argv[3] || join(homedir(), 'qa-results', 'fleet-rerun2-results.json');
const OUT = join(SRC, 'by-app');

// appId -> ISO timestamp from results.json (the authoritative "time taken")
const tsByApp = new Map();
for (const p of [RESULTS, join(homedir(), 'qa-results', 'fleet-rerun-results.json')]) {
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    const rows = Array.isArray(raw) ? raw : (raw.results ?? []);
    for (const r of rows) if (r.appId && r.timestamp && !tsByApp.has(r.appId)) tsByApp.set(r.appId, r.timestamp);
  } catch {
    /* optional */
  }
}

const stamp = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-` +
  `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

if (!existsSync(SRC)) {
  console.error(`No screenshot dir at ${SRC}`);
  process.exit(1);
}

const files = readdirSync(SRC).filter((f) => f.endsWith('.png'));
let organized = 0;
let skipped = 0;
const perApp = new Map();

for (const f of files) {
  // flat name is `<node>_<appId>.png`; node names are core-*/beta-* (may contain '-').
  const name = basename(f, '.png');
  const m = name.match(/^((?:core|beta)[a-z0-9-]*?)_(.+)$/i);
  const node = m ? m[1] : '';
  const appId = m ? m[2] : name;
  const src = join(SRC, f);
  const st = statSync(src);
  const taken = tsByApp.has(appId) ? new Date(tsByApp.get(appId)) : st.mtime;
  const destDir = join(OUT, appId);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, `${appId}_${stamp(taken)}${node ? `_${node}` : ''}.png`);
  if (existsSync(dest)) {
    skipped++;
  } else {
    copyFileSync(src, dest);
    organized++;
  }
  // refresh latest.png for the app (newest mtime wins)
  const latest = join(destDir, 'latest.png');
  if (!existsSync(latest) || statSync(latest).mtimeMs < st.mtimeMs) copyFileSync(src, latest);
  perApp.set(appId, (perApp.get(appId) ?? 0) + 1);
}

console.error(`\n  organized ${organized} new, ${skipped} already-present, into ${perApp.size} app folders under ${OUT}\n`);
const sorted = [...perApp.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [app, n] of sorted) console.error(`  ${app.padEnd(28)} ${n} shot(s)`);
console.error('');
