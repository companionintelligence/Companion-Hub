#!/usr/bin/env node
// Copy the CI Common files listed in packages/frontend/ci-common.vendor.json.
//
//   node scripts/vendor-ci-common.mjs --check
//   node scripts/vendor-ci-common.mjs --from ../ci-common --ref <tag>
//
// --check confirms every dest is still the copy the manifest records.
// --from reads that checkout at --ref (default HEAD), stamps text files with
// `vendored-from:`, and rewrites the manifest versions and hashes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(repoRoot, 'packages/frontend/ci-common.vendor.json');

function parseArgs(argv) {
  const out = { check: false, from: null, ref: 'HEAD' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') out.check = true;
    else if (arg === '--from') {
      out.from = argv[i + 1];
      i += 1;
    } else if (arg === '--ref') {
      out.ref = argv[i + 1];
      i += 1;
    } else {
      console.error(`vendor-ci-common: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  if ((out.check && out.from) || (!out.check && !out.from)) {
    console.error('vendor-ci-common: pass --check, or --from <ci-common-checkout> [--ref <tag>]');
    process.exit(2);
  }
  return out;
}

function markOf(entry) {
  return `vendored-from: ${entry.package}@${entry.version} ${entry.source}`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitShow(from, ref, source) {
  return execFileSync('git', ['-C', from, 'show', `${ref}:${source}`], { maxBuffer: 20 * 1024 * 1024 });
}

function stamp(entry, raw) {
  const mark = markOf(entry);
  if (entry.stamp === 'css') {
    const body = raw.toString('utf8').replace(/^\/\* vendored-from:.*\*\/\n+/, '');
    return Buffer.from(`/* ${mark} */\n\n${body}`);
  }
  if (entry.stamp === 'js') {
    let text = raw.toString('utf8');
    let shebang = '';
    if (text.startsWith('#!')) {
      const nl = text.indexOf('\n');
      shebang = text.slice(0, nl + 1);
      text = text.slice(nl + 1);
    }
    text = text.replace(/^\/\/ vendored-from:.*\n+/, '');
    return Buffer.from(`${shebang}// ${mark}\n${text}`);
  }
  return raw;
}

function check(manifest) {
  const problems = [];
  for (const entry of manifest.files) {
    const dest = resolve(repoRoot, entry.dest);
    if (!existsSync(dest)) {
      problems.push(`${entry.dest}: missing`);
      continue;
    }
    const bytes = readFileSync(dest);
    if (sha256(bytes) !== entry.sha256) problems.push(`${entry.dest}: bytes differ from ci-common.vendor.json`);
    if (entry.stamp && !bytes.toString('utf8').includes(markOf(entry))) problems.push(`${entry.dest}: missing ${markOf(entry)}`);
  }
  if (problems.length) {
    console.error(`vendor-ci-common:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`✔ ${manifest.files.length} vendored CI Common file(s) match packages/frontend/ci-common.vendor.json`);
}

function sync(manifest, from, ref) {
  const versions = new Map();
  for (const entry of manifest.files) {
    if (!versions.has(entry.packageJson)) {
      versions.set(entry.packageJson, JSON.parse(gitShow(from, ref, entry.packageJson).toString('utf8')).version);
    }
    entry.version = versions.get(entry.packageJson);
    const stamped = stamp(entry, gitShow(from, ref, entry.source));
    writeFileSync(resolve(repoRoot, entry.dest), stamped);
    entry.sha256 = sha256(stamped);
    entry.mark = markOf(entry);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`vendored ${manifest.files.length} file(s) from ${from} @ ${ref}`);
}

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (args.from) sync(manifest, resolve(args.from), args.ref);
else check(manifest);
