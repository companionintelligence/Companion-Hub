import assert from 'node:assert';
import {
  computeCesrDigest,
  decodeCesrPublicKey,
  decodeCesrSignature,
  encodeCesrPublicKey,
  encodeCesrSignature,
} from '../packages/common/src/keri/cesr';
import { computeSaid, verifySaid } from '../packages/common/src/keri/said';
import {
  computePreRotationCommitment,
  createInceptionEvent,
  createInteractionEvent,
  createRotationEvent,
  generateEd25519Keypair,
  verifyKeyEventLog,
} from '../packages/common/src/keri/aid';
import { createTelIssuance, createTelRevocation, evaluateTelStatus } from '../packages/common/src/keri/tel';
import { evaluateAcdcGrant, issueAskGrantAcdc, type AskGrantAttributes } from '../packages/common/src/keri/acdc';
import { buildOobiUrl, createOobiDiscoveryResponse, parseOobiUrl } from '../packages/common/src/keri/oobi';
import { signHttpRequest, verifyHttpRequestWithKeri } from '../packages/common/src/keri/http-sig';

import {
  FORWARD_AUTH_HUB_AID_HEADER,
  FORWARD_AUTH_USER_AID_HEADER,
  buildSignedForwardAuthHeaders,
  verifyForwardAuthHeaders,
} from '../packages/backend/src/modules/auth/utils/forward-auth-signing';

// A round-trip check of the in-tree module against ITSELF. It says nothing about interoperability, which the
// module does not have: see packages/common/src/keri/FROZEN.md.
console.log('--- RUNNING IN-TREE KERI-STYLE MODULE ROUND TRIPS (frozen, not interoperable: see packages/common/src/keri/FROZEN.md) ---');

// 1. CESR Encodings
console.log('1. Testing CESR Encodings...');
const rawPub = Buffer.alloc(32, 0x42);
const cesrPub = encodeCesrPublicKey(rawPub);
assert.strictEqual(cesrPub.startsWith('B'), true, 'CESR public key must start with B');
assert.strictEqual(cesrPub.length, 44, 'CESR public key must be 44 chars');
assert.deepStrictEqual(decodeCesrPublicKey(cesrPub), rawPub, 'CESR public key decode mismatch');

const rawSig = Buffer.alloc(64, 0x99);
const cesrSig = encodeCesrSignature(rawSig);
assert.strictEqual(cesrSig.startsWith('0A'), true, 'CESR signature must start with 0A');
assert.strictEqual(cesrSig.length, 88, 'CESR signature must be 88 chars');
assert.deepStrictEqual(decodeCesrSignature(cesrSig), rawSig, 'CESR signature decode mismatch');

const digest = computeCesrDigest(Buffer.from('hello companion', 'utf8'));
assert.strictEqual(digest.startsWith('E'), true, 'CESR digest must start with E');
assert.strictEqual(digest.length, 44, 'CESR digest must be 44 chars');
console.log('   ✓ CESR encodings passed');

// 2. Self-Addressing Identifiers (SAID)
console.log('2. Testing SAID computation and verification...');
const doc = { title: 'Companion Architecture', version: '1.0', author: 'Liam' };
const withSaid = computeSaid(doc);
assert.strictEqual(typeof withSaid.d, 'string');
assert.strictEqual(withSaid.d.startsWith('E'), true);
assert.strictEqual(verifySaid(withSaid), true, 'SAID verification failed');

const tampered = { ...withSaid, author: 'Attacker' };
assert.strictEqual(verifySaid(tampered), false, 'Tampered SAID must fail verification');
console.log('   ✓ SAID integrity and tamper-detection passed');

// 3. Autonomic Identifiers (AID) & Key Event Logs (KEL)
console.log('3. Testing AID inception, pre-rotation, and rotation...');
const key0 = generateEd25519Keypair();
const key1 = generateEd25519Keypair();
const key2 = generateEd25519Keypair();

const signedIcp = createInceptionEvent({
  currentCesrPublicKey: key0.cesrPublicKey,
  nextCesrPublicKey: key1.cesrPublicKey,
  privateKey: key0.privateKey,
});
assert.strictEqual(signedIcp.event.t, 'icp');
assert.strictEqual(signedIcp.event.s, '0');
assert.strictEqual(signedIcp.event.n[0], computePreRotationCommitment(key1.cesrPublicKey));

const v1 = verifyKeyEventLog([signedIcp]);
assert.strictEqual(v1.valid, true, `Inception verification failed: ${v1.error}`);
assert.strictEqual(v1.keyState?.currentPublicKey, key0.cesrPublicKey);

// Rotation event fulfilling pre-rotation commitment
const signedRot = createRotationEvent({
  priorEvent: signedIcp.event,
  newCesrPublicKey: key1.cesrPublicKey,
  nextNextCesrPublicKey: key2.cesrPublicKey,
  newPrivateKey: key1.privateKey,
});
assert.strictEqual(signedRot.event.t, 'rot');
assert.strictEqual(signedRot.event.s, '1');
assert.strictEqual(signedRot.event.p, signedIcp.event.d);

const v2 = verifyKeyEventLog([signedIcp, signedRot]);
assert.strictEqual(v2.valid, true, `Rotation verification failed: ${v2.error}`);
assert.strictEqual(v2.keyState?.currentPublicKey, key1.cesrPublicKey);
assert.strictEqual(v2.keyState?.sequenceNumber, 1);

// Attacker tries to rotate to forged key violating pre-rotation commitment
const attackerKey = generateEd25519Keypair();
const forgedRot = createRotationEvent({
  priorEvent: signedIcp.event,
  newCesrPublicKey: attackerKey.cesrPublicKey,
  nextNextCesrPublicKey: key2.cesrPublicKey,
  newPrivateKey: attackerKey.privateKey,
});
const vForged = verifyKeyEventLog([signedIcp, forgedRot]);
assert.strictEqual(vForged.valid, false, 'Pre-rotation violation must be rejected');
assert.strictEqual(vForged.error?.includes('Pre-rotation commitment violation'), true);

// Interaction event (e.g. metadata / username anchor)
const signedIxn = createInteractionEvent({
  priorEvent: signedIcp.event,
  currentCesrPublicKey: key0.cesrPublicKey,
  privateKey: key0.privateKey,
  seals: [{ type: 'username_anchor', username: 'liam_updated' }],
});
const vIxn = verifyKeyEventLog([signedIcp, signedIxn]);
assert.strictEqual(vIxn.valid, true, `Interaction verification failed: ${vIxn.error}`);
console.log('   ✓ AID lifecycle and pre-rotation security passed');

// 4. ACDC Grants & TEL Revocation
console.log('4. Testing ACDC Verifiable Credentials and TEL revocation...');
const responder = generateEd25519Keypair();
const askerAid = 'did:keri:EAskerSovereignAID_000000000000000000000';

const grantAttrs: AskGrantAttributes = {
  grantee: askerAid,
  queryType: 'availability',
  dataClass: 'calendar',
  mode: 'auto',
  disclosureCeiling: 'boolean',
  validUntil: '2028-01-01T00:00:00Z',
};

const signedGrant = issueAskGrantAcdc({
  issuerAid: `did:keri:${responder.cesrPublicKey}`,
  attributes: grantAttrs,
  privateKey: responder.privateKey,
});
assert.strictEqual(verifySaid(signedGrant.credential as unknown as Record<string, unknown>), true);

const evalActive = evaluateAcdcGrant({
  query: { queryType: 'availability', dataClass: 'calendar', askerAid },
  grant: signedGrant,
  issuerPublicKey: responder.cesrPublicKey,
});
if (evalActive.decision !== 'auto') {
  throw new Error(`Expected the active grant to be automatic, got ${evalActive.decision}`);
}
assert.strictEqual(evalActive.maxDisclosure, 'boolean');

// Revoke via TEL
const grantSaid = signedGrant.credential.d;
const telIss = createTelIssuance({
  issuerAid: `did:keri:${responder.cesrPublicKey}`,
  registryId: 'registry-001',
  credentialSaid: grantSaid,
  privateKey: responder.privateKey,
});
const telRev = createTelRevocation({
  priorTelEvent: telIss.event,
  credentialSaid: grantSaid,
  privateKey: responder.privateKey,
});
const telStatus = evaluateTelStatus(grantSaid, [telIss, telRev], responder.cesrPublicKey);
assert.strictEqual(telStatus.status, 'revoked');

const evalRevoked = evaluateAcdcGrant({
  query: { queryType: 'availability', dataClass: 'calendar', askerAid },
  grant: signedGrant,
  issuerPublicKey: responder.cesrPublicKey,
  telEvents: [telIss, telRev],
});
if (evalRevoked.decision !== 'deny') {
  throw new Error(`Expected the revoked grant to be denied, got ${evalRevoked.decision}`);
}
assert.match(evalRevoked.reason, /revoked in TEL/);
console.log('   ✓ ACDC grant issuance and TEL revocation passed');

// 5. OOBI (Out-Of-Band Introduction)
console.log('5. Testing OOBI generation and parsing...');
const oobiUrl = buildOobiUrl({
  endpoint: 'https://hub.myhome.ts.net:8443',
  aid: 'did:keri:EHubAppliance_00000000000000000000000000',
  role: 'hub',
  name: 'LivingRoomHub',
});
const parsedOobi = parseOobiUrl(oobiUrl);
assert.strictEqual(parsedOobi.aid, 'did:keri:EHubAppliance_00000000000000000000000000');
assert.strictEqual(parsedOobi.role, 'hub');
assert.strictEqual(parsedOobi.endpoints[0], 'https://hub.myhome.ts.net:8443');

const oobiResp = createOobiDiscoveryResponse({
  aid: 'did:keri:E123',
  role: 'hub',
  urls: ['https://hub.example.com'],
  currentPublicKey: 'BPub123',
  latestKelDigest: 'EDigest123',
});
assert.strictEqual(oobiResp.aid, 'did:keri:E123');
console.log('   ✓ OOBI discovery passed');

// 6. RFC 9421 HTTP Signatures with KERI AIDs
console.log('6. Testing RFC 9421 HTTP Signatures over KERI AIDs...');
const sender0 = generateEd25519Keypair();
const sender1 = generateEd25519Keypair();
const senderIcp = createInceptionEvent({
  currentCesrPublicKey: sender0.cesrPublicKey,
  nextCesrPublicKey: sender1.cesrPublicKey,
  privateKey: sender0.privateKey,
});
const senderAid = senderIcp.event.i;
const body = JSON.stringify({ query: 'Free for lunch Friday?', queryType: 'availability' });
const targetUri = 'https://responder.example/agent/v1/ask';

const httpHeaders = signHttpRequest({
  method: 'POST',
  targetUri,
  body,
  aid: senderAid,
  privateKey: sender0.privateKey,
});
assert.strictEqual(httpHeaders['signature-input'].includes('keyid="did:keri:'), true);
assert.strictEqual(httpHeaders.signature.startsWith('ci=:0A'), true);

const verifyHttp = verifyHttpRequestWithKeri({
  method: 'POST',
  targetUri,
  headers: httpHeaders,
  rawBody: body,
  senderKel: [senderIcp],
});
if (!verifyHttp.ok) {
  throw new Error(`HTTP signature verification failed: ${verifyHttp.reason}`);
}
assert.strictEqual(verifyHttp.senderAid, senderAid);

// Tampered body must fail
const verifyTampered = verifyHttpRequestWithKeri({
  method: 'POST',
  targetUri,
  headers: httpHeaders,
  rawBody: JSON.stringify({ query: 'Tampered prompt', queryType: 'availability' }),
  senderKel: [senderIcp],
});
if (verifyTampered.ok) {
  throw new Error('Tampered HTTP body unexpectedly passed signature verification');
}
assert.match(verifyTampered.reason, /Content-digest mismatch/);
console.log('   ✓ RFC 9421 HTTP Signatures with KERI AIDs passed');

// 7. Hub Forward-Auth with KERI Headers
console.log('7. Testing that the forward-auth signing helpers carry caller-supplied AID values (the Hub itself sets none)...');
const secret = 'test-hub-secret';
const username = 'liam';
const now = 1_700_000_000_000;
const stableId = {
  issuer: 'urn:ci-hub:11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  userAid: 'did:keri:EUserAID_0000000000000000000000000000000',
  hubAid: 'did:keri:EHubAID_00000000000000000000000000000000',
  kelDigest: 'ELatestDigest_000000000000000000000000000000',
};

const signedFwd = buildSignedForwardAuthHeaders(secret, username, now, stableId);
assert.strictEqual(signedFwd[FORWARD_AUTH_USER_AID_HEADER], stableId.userAid);
assert.strictEqual(signedFwd[FORWARD_AUTH_HUB_AID_HEADER], stableId.hubAid);

const fwdVerify = verifyForwardAuthHeaders(
  secret,
  {
    user: signedFwd['X-CI-Hub-User'],
    timestamp: signedFwd['X-CI-Hub-User-Timestamp'],
    signature: signedFwd['X-CI-Hub-User-Signature'],
    issuer: signedFwd['X-CI-Hub-User-Issuer'],
    userId: signedFwd['X-CI-Hub-User-Id'],
    userIdSignature: signedFwd['X-CI-Hub-User-Id-Signature'],
    userAid: signedFwd[FORWARD_AUTH_USER_AID_HEADER],
    hubAid: signedFwd[FORWARD_AUTH_HUB_AID_HEADER],
  },
  { now },
);

if (!fwdVerify.ok) {
  throw new Error(`Forward-auth signature verification failed: ${fwdVerify.reason}`);
}
assert.strictEqual(fwdVerify.stableId?.userAid, stableId.userAid);
assert.strictEqual(fwdVerify.stableId?.hubAid, stableId.hubAid);
console.log('   ✓ forward-auth signing helpers carry caller-supplied AID values passed');

console.log('\n======================================================');
console.log('ALL IN-TREE KERI-STYLE ROUND TRIPS PASSED (internal consistency only, not interoperability)');
console.log('======================================================');
