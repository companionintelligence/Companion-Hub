#!/usr/bin/env node
// Sign a desktop release's manifest.json, writing manifest.json.sig beside it.
//
// The desktop app downloads an installer only from a manifest one of its pinned keys signed
// (packages/desktop/src-tauri/src/update_signature.rs). The signature is Ed25519 over
// SIGNED_MESSAGE_PREFIX followed by the manifest's exact bytes, written as 128 hex characters.
//
// Refuses to sign with a key that file does not list for the environment: the binaries of this
// release were built from the same source, so they would refuse the manifest, and every desktop on
// the release would be stuck on it.
//
// Usage: sign-desktop-manifest.mjs <manifest.json> <production|dev> [update_signature.rs]
// Env:   DESKTOP_UPDATE_SIGNING_KEY: the Ed25519 private key, PKCS#8 PEM
//        (`openssl genpkey -algorithm ed25519`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIGNED_MESSAGE_PREFIX = 'companion-hub desktop update manifest v1\n';
const DEFAULT_KEYS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../packages/desktop/src-tauri/src/update_signature.rs');
const KEY_LISTS = { production: 'PRODUCTION_UPDATE_KEYS', dev: 'DEV_UPDATE_KEYS' };

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/** The hex keys `update_signature.rs` lists in `constName`. */
export function listedKeys(source, constName) {
  const match = source.match(new RegExp(`const ${constName}: &\\[&str\\] = &\\[([^\\]]*)\\];`));
  if (!match) throw new Error(`${constName} not found in update_signature.rs`);
  return [...match[1].matchAll(/"([0-9a-fA-F]{64})"/g)].map(([, key]) => key.toLowerCase());
}

/** The signing key's public half, as the 64 hex characters update_signature.rs lists. */
export function publicKeyHex(privateKey) {
  const der = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('hex');
}

export function signManifest(manifest, privateKey) {
  const message = Buffer.concat([Buffer.from(SIGNED_MESSAGE_PREFIX), manifest]);
  return crypto.sign(null, message, privateKey).toString('hex');
}

function main() {
  const [manifestPath, environment, keysFile = DEFAULT_KEYS_FILE] = process.argv.slice(2);
  if (!manifestPath || !KEY_LISTS[environment]) {
    fail('usage: sign-desktop-manifest.mjs <manifest.json> <production|dev> [update_signature.rs]');
  }
  const { DESKTOP_UPDATE_SIGNING_KEY: pem } = process.env;
  if (!pem?.trim()) {
    fail(
      `DESKTOP_UPDATE_SIGNING_KEY is not set on the '${environment}' GitHub Environment. ` +
        'Desktop apps install no update from an unsigned manifest; see docs/DESKTOP-RELEASE-SIGNING.md.',
    );
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(pem);
  } catch (error) {
    fail(`DESKTOP_UPDATE_SIGNING_KEY is not a PEM private key: ${error.message}`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail(`DESKTOP_UPDATE_SIGNING_KEY is an ${privateKey.asymmetricKeyType} key; it must be Ed25519.`);
  }

  const publicHex = publicKeyHex(privateKey);
  const listed = listedKeys(fs.readFileSync(keysFile, 'utf8'), KEY_LISTS[environment]);
  if (!listed.includes(publicHex)) {
    fail(
      `The ${environment} signing key (public key ${publicHex}) is not in ${KEY_LISTS[environment]} in ` +
        "update_signature.rs, so this release's own binaries would refuse its manifest. Add the key there first.",
    );
  }

  const manifest = fs.readFileSync(manifestPath);
  const signature = signManifest(manifest, privateKey);
  // Checked as the app checks it, against the listed public key, before anything is uploaded.
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
  const message = Buffer.concat([Buffer.from(SIGNED_MESSAGE_PREFIX), manifest]);
  if (!crypto.verify(null, message, publicKey, Buffer.from(signature, 'hex'))) {
    fail('The manifest signature did not verify against its own public key.');
  }
  fs.writeFileSync(`${manifestPath}.sig`, `${signature}\n`);
  console.log(`Signed ${manifestPath} with the ${environment} key ${publicHex}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
