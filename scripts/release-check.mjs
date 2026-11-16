#!/usr/bin/env node
/**
 * `release-check`: asks every place a Hub release ships to which version it has and prints one table.
 * A row that is BEHIND or MISSING is a place the release hasn't reached.
 *
 *   node scripts/release-check.mjs                     # the GitHub Release marked Latest
 *   node scripts/release-check.mjs --version 0.3.13
 *   node scripts/release-check.mjs --format markdown   # for a job summary, PR or issue
 *   node scripts/release-check.mjs --format json
 *
 * Desktop Release runs it as its last job on production releases. Needs `gh` signed in. The Google Play
 * rows need a Play service-account key, either as JSON text in PLAY_KEY_JSON or as a file in PLAY_KEY_FILE;
 * without one they show SKIP. Nothing here writes anywhere: the Play lookup opens an edit, reads the tracks
 * and deletes the edit.
 *
 * Exit code 0 when every row is OK, INFO or SKIP; 1 when any row is BEHIND, MISSING or ERROR; 2 on a usage
 * error; 3 when the script itself crashed, so a crash never reads as "behind".
 * scripts/__tests__/release-check.test.ts covers the parsing and comparison helpers.
 */

import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ORG = 'companionintelligence';
const HUB_REPO = `${ORG}/Companion-Hub`;
const CI_OS_REPO = `${ORG}/CI-OS`;
const TAP_REPO = `${ORG}/homebrew-tap`;
const BUCKET_REPO = `${ORG}/scoop-bucket`;
const PLAY_PACKAGE = 'com.companionintelligence.hub';
const IOS_BUNDLE = 'computer.ci.app.hub';

// One row per platform. A release that lacks any file in a row has not shipped that platform.
// `{v}` is replaced with the release version, so a leftover file from an older build doesn't count.
export const INSTALLERS = [
  ['macOS Apple Silicon', ['_{v}_aarch64.dmg']],
  ['macOS Intel', ['_{v}_x64.dmg']],
  ['Windows x64', ['_{v}_x64_en-US.msi', '_{v}_x64-setup.exe']],
  ['Windows ARM64', ['_{v}_arm64_en-US.msi', '_{v}_arm64-setup.exe']],
  ['Linux x64', ['_{v}_amd64.deb', '-{v}-1.x86_64.rpm']],
  ['Linux ARM64', ['_{v}_arm64.deb', '-{v}-1.aarch64.rpm']],
  ['cihub CLI', ['cihub-linux-x64', 'cihub-linux-arm64', 'cihub-macos-x64', 'cihub-macos-arm64', 'cihub-windows-x64.exe', 'cihub-windows-arm64.exe']],
];

// ---------------------------------------------------------------------------------------------
// Pure helpers

export function normalizeVersion(value) {
  if (value == null) return null;
  return String(value).trim().replace(/^v/, '');
}

// Dotted numbers compare as numbers: 0.3.13 > 0.3.9. A pre-release sorts before the release it leads up
// to (0.3.14-rc1 < 0.3.14). A part that isn't a number sorts as text. Build metadata (+...) is ignored.
export function compareVersions(a, b) {
  const [coreA, preA = ''] = normalizeVersion(a).split('+')[0].split(/-(.*)/s);
  const [coreB, preB = ''] = normalizeVersion(b).split('+')[0].split(/-(.*)/s);
  const pa = coreA.split('.');
  const pb = coreB.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (preA === preB) return 0;
  if (!preA || !preB) return preA ? -1 : 1;
  return preA < preB ? -1 : 1;
}

// The release each Play track serves: the newest one that is completed, or inProgress (a staged rollout).
// Drafts serve nobody, so they don't count.
export function livePlayReleases(releases) {
  const live = [];
  for (const track of ['production', 'beta', 'alpha', 'internal']) {
    const serving = releases.filter((r) => r.track === track && ['completed', 'inProgress'].includes(r.status));
    if (serving.length) {
      live.push(serving.reduce((a, b) => (Math.max(...a.codes.map(Number)) >= Math.max(...b.codes.map(Number)) ? a : b)));
    }
  }
  return live;
}

export function versionStatus(expected, found) {
  if (found == null || found === '') return 'MISSING';
  const cmp = compareVersions(found, expected);
  if (cmp === 0) return 'OK';
  return cmp < 0 ? 'BEHIND' : 'AHEAD';
}

export function isReleaseVersion(value) {
  return /^\d+(\.\d+)+$/.test(normalizeVersion(value) ?? '');
}

export function maxVersion(values) {
  return values.filter(isReleaseVersion).reduce((best, v) => (best == null || compareVersions(v, best) > 0 ? v : best), null);
}

// Tauri's Android build number is major * 1,000,000 + minor * 1,000 + patch.
export function tauriVersionFromCode(code) {
  const n = Number(code);
  if (!Number.isInteger(n) || n <= 0) return null;
  return `${Math.floor(n / 1_000_000)}.${Math.floor(n / 1000) % 1000}.${n % 1000}`;
}

export function missingFiles(assetNames, patterns, version) {
  return patterns.map((p) => p.replaceAll('{v}', version)).filter((suffix) => !assetNames.some((name) => name.endsWith(suffix)));
}

export function parseCaskVersion(rubyText) {
  return rubyText.match(/^\s*version\s+"([^"]+)"/m)?.[1] ?? null;
}

export function parseCiOsHubPin(envText) {
  return envText.match(/^LAUNCHER_URL=\S*\/v(\d+(?:\.\d+)+)\//m)?.[1] ?? null;
}

export function hubVersionOnDownloadPage(html) {
  return maxVersion([...html.matchAll(/dl\.ci\.computer\/v(\d+(?:\.\d+)+)\//g)].map((m) => m[1]));
}

// ---------------------------------------------------------------------------------------------
// Lookups

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function ghJson(path) {
  return JSON.parse(gh(['api', path]));
}

function ghFileText(repo, path, ref) {
  return gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${path}?ref=${ref}`]);
}

async function fetchText(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function fetchJson(url, init) {
  return JSON.parse(await fetchText(url, init));
}

const INDEX_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

// One anonymous pull token per repository, reused for every manifest request.
const ghcrTokens = new Map();
function ghcrToken(repository) {
  if (!ghcrTokens.has(repository)) {
    ghcrTokens.set(
      repository,
      fetchJson(`https://ghcr.io/token?scope=repository:${repository}:pull`).then((r) => r.token),
    );
  }
  return ghcrTokens.get(repository);
}

// Public GHCR images only (anonymous pull token). Returns null when the tag doesn't exist.
async function ghcrImage(repository, tag) {
  const res = await fetch(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
    headers: { Authorization: `Bearer ${await ghcrToken(repository)}`, Accept: INDEX_ACCEPT },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ghcr.io/${repository}:${tag}: HTTP ${res.status}`);
  const body = await res.json();
  const platforms = (body.manifests ?? [])
    .map((m) => m.platform)
    .filter((p) => p && p.os !== 'unknown')
    .map((p) => `${p.os}/${p.architecture}`);
  return { digest: res.headers.get('docker-content-digest'), platforms };
}

function readPlayKey() {
  if (process.env.PLAY_KEY_JSON) return JSON.parse(process.env.PLAY_KEY_JSON);
  if (process.env.PLAY_KEY_FILE) return JSON.parse(readFileSync(process.env.PLAY_KEY_FILE, 'utf8'));
  return null;
}

async function playTracks(key, packageName) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: key.token_uri,
    iat: now,
    exp: now + 600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const { access_token: accessToken } = await fetchJson(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/edits`;
  const call = async (method, url) => {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Play ${method} ${packageName}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  };
  const { id } = await call('POST', base);
  try {
    const { tracks = [] } = await call('GET', `${base}/${id}/tracks`);
    return tracks.flatMap((t) =>
      (t.releases ?? []).map((r) => ({ track: t.track, status: r.status, name: r.name ?? null, codes: r.versionCodes ?? [] })),
    );
  } finally {
    await call('DELETE', `${base}/${id}`).catch(() => {
      // A failed cleanup mustn't replace the tracks just read (or the error that stopped the read). An
      // edit nobody commits expires by itself.
    });
  }
}

async function appStoreListing(bundleId) {
  const data = await fetchJson(`https://itunes.apple.com/lookup?bundleId=${bundleId}&country=us`);
  const app = data.results?.[0];
  return app ? { version: app.version, released: app.currentVersionReleaseDate } : null;
}

// ---------------------------------------------------------------------------------------------
// Rows. A lookup that throws becomes an ERROR row instead of stopping the run.

class Rows {
  constructor() {
    this.list = [];
  }
  add(where, expected, found, status, note = '') {
    this.list.push({ where, expected: expected ?? '', found: found ?? '', status, note });
  }
  version(where, expected, found, note = '') {
    this.add(where, expected, found, versionStatus(expected, found), note);
  }
  // `privateRepo` marks a row that reads another private repository, which a workflow's own token can't.
  async try(where, fn, { privateRepo = false } = {}) {
    try {
      await fn();
    } catch (err) {
      const message = String(err.stderr || err.message || err)
        .trim()
        .split('\n')[0]
        .slice(0, 200);
      if (privateRepo && process.env.GITHUB_ACTIONS === 'true' && /HTTP 40[34]/.test(message)) {
        this.add(where, '', '', 'SKIP', 'not readable with this workflow token; run the script locally for this row');
      } else {
        this.add(where, '', '', 'ERROR', message);
      }
    }
  }
}

async function checkHub(requested) {
  const rows = new Rows();
  let version = normalizeVersion(requested);
  await rows.try('GitHub Release', async () => {
    let release;
    try {
      release = ghJson(version ? `repos/${HUB_REPO}/releases/tags/v${version}` : `repos/${HUB_REPO}/releases/latest`);
    } catch (err) {
      if (!version || !/HTTP 404/.test(String(err.stderr))) throw err;
      return rows.add('GitHub Release', version, '', 'MISSING', `no GitHub Release for v${version}`);
    }
    version = normalizeVersion(release.tag_name);
    // Only needed when checking a release other than Latest. Its own lookup, so a failure here costs one
    // note instead of the installer rows below.
    let latest = version;
    if (requested) {
      try {
        latest = normalizeVersion(ghJson(`repos/${HUB_REPO}/releases/latest`).tag_name);
      } catch {
        latest = null;
      }
    }
    const latestNote = latest === version ? ', marked Latest' : latest ? `; Latest is ${latest}` : "; couldn't read which release is Latest";
    rows.add(
      'GitHub Release',
      version,
      version,
      latest === version ? 'OK' : latest ? 'BEHIND' : 'ERROR',
      `published ${release.published_at.slice(0, 10)}${latestNote}`,
    );
    const names = release.assets.map((a) => a.name);
    for (const [label, patterns] of INSTALLERS) {
      const missing = missingFiles(names, patterns, version);
      rows.add(
        `Installer: ${label}`,
        version,
        missing.length ? '' : version,
        missing.length ? 'MISSING' : 'OK',
        missing.length ? `missing ${missing.join(', ')}` : '',
      );
    }
  });
  if (!version) return rows.list;

  await rows.try('Docker image ci-hub', async () => {
    const image = await ghcrImage(`${ORG}/ci-hub`, version);
    if (!image) return rows.add('Docker image ci-hub', version, '', 'MISSING', `no ci-hub:${version}`);
    const latest = await ghcrImage(`${ORG}/ci-hub`, 'latest');
    const arches = ['linux/amd64', 'linux/arm64'].filter((p) => !image.platforms.includes(p));
    const latestOk = latest?.digest === image.digest;
    const notes = [arches.length ? `no ${arches.join(', ')}` : 'amd64 + arm64', latestOk ? ':latest is this build' : ':latest is another build'];
    rows.add('Docker image ci-hub', version, version, arches.length ? 'MISSING' : latestOk ? 'OK' : 'BEHIND', notes.join('; '));
  });

  await rows.try('Auto-update feed (production)', async () => {
    const feed = await fetchJson('https://dl.ci.computer/latest.json');
    rows.version('Auto-update feed (production)', version, normalizeVersion(feed.version), 'dl.ci.computer/latest.json');
  });
  await rows.try('Auto-update feed (dev)', async () => {
    const feed = await fetchJson('https://dl-dev.ci.computer/latest.json');
    rows.add(
      'Auto-update feed (dev)',
      '',
      normalizeVersion(feed.version),
      'INFO',
      `dl-dev.ci.computer, set ${feed.date?.slice(0, 10)}; moves only on environment=dev runs`,
    );
  });
  await rows.try('Homebrew', async () => {
    rows.version('Homebrew', version, parseCaskVersion(ghFileText(TAP_REPO, 'Casks/companion-hub.rb', 'HEAD')), 'homebrew-tap companion-hub');
  });
  await rows.try('Scoop', async () => {
    rows.version('Scoop', version, JSON.parse(ghFileText(BUCKET_REPO, 'companion-hub.json', 'HEAD')).version, 'scoop-bucket companion-hub');
  });
  await rows.try('ci.computer/download', async () => {
    rows.version(
      'ci.computer/download',
      version,
      hubVersionOnDownloadPage(await fetchText('https://ci.computer/download')),
      'site is deployed by hand',
    );
  });
  await rows.try(
    'CI-OS USB image pin',
    async () => {
      const pin = parseCiOsHubPin(ghFileText(CI_OS_REPO, 'core/manifest/tier-b-pins.env', 'HEAD'));
      rows.version('CI-OS USB image pin', version, pin, 'core/manifest/tier-b-pins.env');
    },
    { privateRepo: true },
  );

  if (process.env.PLAY_KEY_JSON || process.env.PLAY_KEY_FILE) {
    await rows.try('Android (Google Play)', async () => {
      const releases = await playTracks(readPlayKey(), PLAY_PACKAGE);
      const live = livePlayReleases(releases);
      if (!live.length) {
        const drafts = releases.filter((r) => r.status === 'draft').length;
        const note = `nothing live on production, beta, alpha or internal${drafts ? `; ${drafts} draft(s) waiting` : ''}`;
        return rows.add('Android (Google Play)', version, '', 'MISSING', note);
      }
      for (const release of live) {
        // Play's release name is free text ("Companion Hub" on the first upload), so fall back to the
        // version Tauri encodes in the build number.
        const built = isReleaseVersion(release.name) ? normalizeVersion(release.name) : tauriVersionFromCode(Math.max(...release.codes.map(Number)));
        const rollout = release.status === 'inProgress' ? 'staged rollout; ' : '';
        rows.version(`Android (Google Play), ${release.track}`, version, built, `${rollout}build ${release.codes.join(',')}`);
      }
    });
  } else {
    rows.add('Android (Google Play)', version, '', 'SKIP', 'set PLAY_KEY_JSON or PLAY_KEY_FILE to a Play service-account key');
  }
  await rows.try('iPhone (App Store)', async () => {
    const listing = await appStoreListing(IOS_BUNDLE);
    if (!listing) return rows.add('iPhone (App Store)', version, '', 'MISSING', `${IOS_BUNDLE} isn't on the App Store`);
    rows.version('iPhone (App Store)', version, listing.version, `released ${listing.released?.slice(0, 10)}`);
  });
  return rows.list;
}

// ---------------------------------------------------------------------------------------------
// Output

const COLUMNS = [
  ['where', 'Where'],
  ['expected', 'Should have'],
  ['found', 'Has'],
  ['status', 'Status'],
  ['note', 'Note'],
];
const FAILING = new Set(['BEHIND', 'MISSING', 'ERROR']);

export function formatTable(rows) {
  const widths = COLUMNS.map(([key, title]) => Math.max(title.length, ...rows.map((r) => String(r[key]).length)));
  const line = (cells) =>
    cells
      .map((c, i) => String(c).padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(COLUMNS.map(([, t]) => t)), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(COLUMNS.map(([k]) => r[k])))].join('\n');
}

export function formatMarkdown(rows) {
  const esc = (v) => String(v).replaceAll('|', '\\|');
  return [
    `| ${COLUMNS.map(([, t]) => t).join(' | ')} |`,
    `|${COLUMNS.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${COLUMNS.map(([k]) => (k === 'status' && FAILING.has(r[k]) ? `**${r[k]}**` : esc(r[k]))).join(' | ')} |`),
  ].join('\n');
}

const USAGE = 'usage: release-check.mjs [--version <hub version>] [--format table|markdown|json]';

async function main(argv) {
  const args = argv.slice(2);
  let format = 'table';
  let version = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format') format = args[++i];
    else if (args[i] === '--version') version = args[++i];
    else if (args[i] === '-h' || args[i] === '--help') {
      console.log(USAGE);
      return 0;
    } else {
      console.error(USAGE);
      return 2;
    }
  }
  if (!['table', 'markdown', 'json'].includes(format) || (version != null && !isReleaseVersion(version))) {
    console.error(USAGE);
    return 2;
  }
  const rows = await checkHub(version);
  if (format === 'json') console.log(JSON.stringify(rows, null, 2));
  else console.log(format === 'markdown' ? formatMarkdown(rows) : formatTable(rows));
  const failing = rows.filter((r) => FAILING.has(r.status)).length;
  if (format !== 'json') console.log(`\n${failing ? `${failing} row(s) behind, missing or failed.` : 'Every checked place has this release.'}`);
  return failing ? 1 : 0;
}

// process.argv[1] is empty when another script imports this one through `node -e`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`release-check crashed: ${err?.stack ?? err}`);
      process.exitCode = 3;
    },
  );
}
