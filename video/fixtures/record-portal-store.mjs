/**
 * Re-record the Portal store catalog used by the `hub-store` and
 * `store-alternatives` shots.
 *
 *   node video/fixtures/record-portal-store.mjs            # production Portal
 *   PORTAL_URL=http://localhost:8012 node …/record-portal-store.mjs
 *
 * WHY A RECORDING AND NOT A LIVE FETCH
 * The Hub proxies the featured store view straight to the Portal
 * (`GET /api/store/listings` -> portal-client.fetchStoreListings -> Portal
 * `GET /store`). The capture stage runs against the E2E mock portal, which
 * answers every query with the same two stub apps, so `/store` filmed on the
 * stage shows a two-app catalog under captions about breadth. Pointing the
 * stage at the live Portal fixes the content but breaks byte-stability: the
 * catalog gains apps weekly, so `hub-store.png` would churn forever for reasons
 * that are not UI changes. Recording gives both — real catalog, stable bytes.
 *
 * WHAT IS RECORDED
 * The four query strings `FeaturedStoreView` issues, verbatim, plus the
 * unfiltered catalog as a fallback; and `/store/alternatives`, which on the
 * Portal is a static JSON file (`domains/store/handlers/alternatives.json`),
 * so that one is byte-for-byte production.
 *
 * WHAT IS DROPPED
 * Everything the Hub does not read. `mapPortalStoreAppToHub`
 * (packages/frontend/src/lib/portal-store.ts) keeps id, name, short_desc and
 * categories, so the recording keeps those and nothing else — 124 KB instead of
 * 3.4 MB of compose files. `icon` is dropped on purpose: without it AppCard
 * falls back to the Hub's own `/api/marketplace/apps/<urn>/image`, serving the
 * same logo off the CI-Marketplace checkout the stage already needs, instead of
 * 492 image requests to hub.ci.computer mid-capture.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTAL = (process.env.PORTAL_URL ?? 'https://hub.ci.computer').replace(/\/+$/, '');

/** Exactly what FeaturedStoreView asks for, in the order it asks. */
const QUERIES = ['tags=companion-intelligence', 'tags=featured', 'sort=trending', 'sort=newest', ''];

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const apps = {};
const queries = {};

for (const q of QUERIES) {
  const url = `${PORTAL}/api/store${q ? `?${q}` : ''}`;
  const list = await getJson(url);
  if (!Array.isArray(list)) throw new Error(`${url} did not return an array`);
  queries[q] = list.map((a) => a.id);
  for (const a of list) {
    if (apps[a.id]) continue;
    apps[a.id] = {
      name: a.name ?? a.title ?? a.id,
      short_desc: a.short_desc ?? a.shortDescription ?? a.description ?? '',
      categories: a.categories ?? a.tags ?? [],
    };
  }
  // biome-ignore lint/suspicious/noConsole: capture-stage script progress output
  console.log(`recorded ${q || '(unfiltered)'} — ${list.length} apps`);
}

writeFileSync(
  join(HERE, 'portal-store-listings.json'),
  `${JSON.stringify(
    {
      _source: `${PORTAL}/api/store`,
      _capturedAt: new Date().toISOString().slice(0, 10),
      _note:
        'Recorded, then projected onto the four fields the Hub actually reads (see video/capture.config.mjs). icon is intentionally absent so AppCard falls back to the Hub-local /api/marketplace/apps/<urn>/image and serves the same logo off the CI-Marketplace checkout instead of hitting the network mid-capture.',
      queries,
      apps,
    },
    null,
    1,
  )}\n`,
);

const alternatives = await getJson(`${PORTAL}/api/store/alternatives`);
writeFileSync(join(HERE, 'portal-store-alternatives.json'), `${JSON.stringify(alternatives, null, 1)}\n`);
// biome-ignore lint/suspicious/noConsole: capture-stage script progress output
console.log(`recorded alternatives — ${Object.keys(alternatives).length} categories`);
