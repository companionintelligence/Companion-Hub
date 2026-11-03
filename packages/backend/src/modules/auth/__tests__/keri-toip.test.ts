import { computeCesrDigest, decodeCesrPublicKey, decodeCesrSignature, encodeCesrPublicKey, encodeCesrSignature } from '@ci-hub/common/keri/cesr';
import { computeSaid, verifySaid } from '@ci-hub/common/keri/said';
import {
  computePreRotationCommitment,
  createInceptionEvent,
  createInteractionEvent,
  createRotationEvent,
  generateEd25519Keypair,
  verifyKeyEventLog,
} from '@ci-hub/common/keri/aid';
import { createTelIssuance, createTelRevocation, evaluateTelStatus } from '@ci-hub/common/keri/tel';
import { evaluateAcdcGrant, issueAskGrantAcdc, type AskGrantAttributes } from '@ci-hub/common/keri/acdc';
import { buildOobiUrl, createOobiDiscoveryResponse, parseOobiUrl } from '@ci-hub/common/keri/oobi';
import { signHttpRequest, verifyHttpRequestWithKeri } from '@ci-hub/common/keri/http-sig';
import { describe, expect, it } from 'vitest';
import {
  FORWARD_AUTH_HUB_AID_HEADER,
  FORWARD_AUTH_USER_AID_HEADER,
  buildSignedForwardAuthHeaders,
  verifyForwardAuthHeaders,
} from '../utils/forward-auth-signing';

// These cases check the in-tree module against ITSELF: what it encodes, it decodes; what it signs, it verifies.
// They say nothing about interoperability, which the module does not have (packages/common/src/keri/FROZEN.md).
describe('In-tree KERI-style module (frozen, not interoperable): internal round trips', () => {
  describe('CESR Encodings', () => {
    it('encodes and decodes Ed25519 public keys with CESR "B" prefix', () => {
      const raw = Buffer.alloc(32, 0x42);
      const encoded = encodeCesrPublicKey(raw);
      expect(encoded.startsWith('B')).toBe(true);
      expect(encoded.length).toBe(44);

      const decoded = decodeCesrPublicKey(encoded);
      expect(decoded.equals(raw)).toBe(true);
    });

    it('refuses invalid public key lengths', () => {
      expect(() => encodeCesrPublicKey(Buffer.alloc(31))).toThrow('Invalid Ed25519 public key length');
    });

    it('encodes and decodes Ed25519 signatures with CESR "0A" prefix', () => {
      const rawSig = Buffer.alloc(64, 0x99);
      const encoded = encodeCesrSignature(rawSig);
      expect(encoded.startsWith('0A')).toBe(true);
      expect(encoded.length).toBe(88);

      const decoded = decodeCesrSignature(encoded);
      expect(decoded.equals(rawSig)).toBe(true);
    });

    it('computes SHA-256 digest with CESR "E" prefix', () => {
      const digest = computeCesrDigest(Buffer.from('hello companion', 'utf8'));
      expect(digest.startsWith('E')).toBe(true);
      expect(digest.length).toBe(44);
    });
  });

  describe('Self-Addressing Identifiers (SAID)', () => {
    it('computes self-addressing identifier and verifies canonical digest', () => {
      const doc = {
        title: 'Companion Architecture',
        version: '1.0',
        author: 'Liam',
      };

      const withSaid = computeSaid(doc);
      expect(withSaid.d).toBeDefined();
      expect(withSaid.d.startsWith('E')).toBe(true);
      expect(verifySaid(withSaid)).toBe(true);
    });

    it('detects tampering when any field is altered', () => {
      const doc = { item: 'notebook', count: 5 };
      const withSaid = computeSaid(doc);
      expect(verifySaid(withSaid)).toBe(true);

      const tampered = { ...withSaid, count: 6 };
      expect(verifySaid(tampered)).toBe(false);
    });
  });

  describe('Autonomic Identifiers (AIDs) & Key Event Logs (KEL)', () => {
    it('creates an inception event with pre-rotation commitment and verifies KEL', () => {
      const key0 = generateEd25519Keypair();
      const key1 = generateEd25519Keypair();

      const signedIcp = createInceptionEvent({
        currentCesrPublicKey: key0.cesrPublicKey,
        nextCesrPublicKey: key1.cesrPublicKey,
        privateKey: key0.privateKey,
      });

      expect(signedIcp.event.t).toBe('icp');
      expect(signedIcp.event.s).toBe('0');
      expect(signedIcp.event.k[0]).toBe(key0.cesrPublicKey);
      expect(signedIcp.event.n[0]).toBe(computePreRotationCommitment(key1.cesrPublicKey));

      const verification = verifyKeyEventLog([signedIcp]);
      expect(verification.valid).toBe(true);
      expect(verification.keyState?.aid).toBe(signedIcp.event.i);
      expect(verification.keyState?.currentPublicKey).toBe(key0.cesrPublicKey);
    });

    it('rotates keys by fulfilling the pre-rotation commitment', () => {
      const key0 = generateEd25519Keypair();
      const key1 = generateEd25519Keypair();
      const key2 = generateEd25519Keypair();

      const signedIcp = createInceptionEvent({
        currentCesrPublicKey: key0.cesrPublicKey,
        nextCesrPublicKey: key1.cesrPublicKey,
        privateKey: key0.privateKey,
      });

      const signedRot = createRotationEvent({
        priorEvent: signedIcp.event,
        newCesrPublicKey: key1.cesrPublicKey,
        nextNextCesrPublicKey: key2.cesrPublicKey,
        newPrivateKey: key1.privateKey,
      });

      expect(signedRot.event.t).toBe('rot');
      expect(signedRot.event.s).toBe('1');
      expect(signedRot.event.p).toBe(signedIcp.event.d);

      const verification = verifyKeyEventLog([signedIcp, signedRot]);
      expect(verification.valid).toBe(true);
      expect(verification.keyState?.sequenceNumber).toBe(1);
      expect(verification.keyState?.currentPublicKey).toBe(key1.cesrPublicKey);
    });

    it('rejects rotation if the revealed key does not match prior pre-rotation commitment', () => {
      const key0 = generateEd25519Keypair();
      const key1 = generateEd25519Keypair();
      const attackerKey = generateEd25519Keypair();
      const key2 = generateEd25519Keypair();

      const signedIcp = createInceptionEvent({
        currentCesrPublicKey: key0.cesrPublicKey,
        nextCesrPublicKey: key1.cesrPublicKey,
        privateKey: key0.privateKey,
      });

      // Attacker tries to rotate to their key instead of key1
      const forgedRot = createRotationEvent({
        priorEvent: signedIcp.event,
        newCesrPublicKey: attackerKey.cesrPublicKey,
        nextNextCesrPublicKey: key2.cesrPublicKey,
        newPrivateKey: attackerKey.privateKey,
      });

      const verification = verifyKeyEventLog([signedIcp, forgedRot]);
      expect(verification.valid).toBe(false);
      expect(verification.error).toContain('Pre-rotation commitment violation');
    });

    it('anchors an interaction event (ixn) into the KEL', () => {
      const key0 = generateEd25519Keypair();
      const key1 = generateEd25519Keypair();

      const signedIcp = createInceptionEvent({
        currentCesrPublicKey: key0.cesrPublicKey,
        nextCesrPublicKey: key1.cesrPublicKey,
        privateKey: key0.privateKey,
      });

      const signedIxn = createInteractionEvent({
        priorEvent: signedIcp.event,
        currentCesrPublicKey: key0.cesrPublicKey,
        privateKey: key0.privateKey,
        seals: [{ type: 'username_anchor', username: 'liam_updated' }],
      });

      const verification = verifyKeyEventLog([signedIcp, signedIxn]);
      expect(verification.valid).toBe(true);
      expect(verification.keyState?.sequenceNumber).toBe(1);
    });
  });

  describe('ACDC Verifiable Credentials & TEL Revocation', () => {
    it('issues an Ask Grant ACDC with embedded SAID and valid signature', () => {
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

      expect(verifySaid(signedGrant.credential as unknown as Record<string, unknown>)).toBe(true);

      const evaluation = evaluateAcdcGrant({
        query: {
          queryType: 'availability',
          dataClass: 'calendar',
          askerAid,
        },
        grant: signedGrant,
        issuerPublicKey: responder.cesrPublicKey,
      });

      expect(evaluation.decision).toBe('auto');
      if (evaluation.decision === 'auto') {
        expect(evaluation.maxDisclosure).toBe('boolean');
      }
    });

    it('revokes an ACDC grant via TEL and ensures immediate refusal (fixing ADR-0002 bug)', () => {
      const responder = generateEd25519Keypair();
      const askerAid = 'did:keri:EAskerSovereignAID_000000000000000000000';

      const signedGrant = issueAskGrantAcdc({
        issuerAid: `did:keri:${responder.cesrPublicKey}`,
        attributes: {
          grantee: askerAid,
          queryType: 'content',
          dataClass: 'photos',
          mode: 'auto',
          disclosureCeiling: 'summary',
          validUntil: '2028-01-01T00:00:00Z',
        },
        privateKey: responder.privateKey,
      });

      const grantSaid = signedGrant.credential.d;

      // 1. Issuance in TEL
      const telIss = createTelIssuance({
        issuerAid: `did:keri:${responder.cesrPublicKey}`,
        registryId: 'registry-001',
        credentialSaid: grantSaid,
        privateKey: responder.privateKey,
      });

      // 2. Revocation in TEL
      const telRev = createTelRevocation({
        priorTelEvent: telIss.event,
        credentialSaid: grantSaid,
        privateKey: responder.privateKey,
      });

      // Status check
      const telCheck = evaluateTelStatus(grantSaid, [telIss, telRev], responder.cesrPublicKey);
      expect(telCheck.status).toBe('revoked');

      // Evaluating grant against revoked TEL must DENY
      const evaluation = evaluateAcdcGrant({
        query: {
          queryType: 'content',
          dataClass: 'photos',
          askerAid,
        },
        grant: signedGrant,
        issuerPublicKey: responder.cesrPublicKey,
        telEvents: [telIss, telRev],
      });

      expect(evaluation.decision).toBe('deny');
      if (evaluation.decision === 'deny') {
        expect(evaluation.reason).toContain('revoked in TEL');
      }
    });

    it('enforces ADR-0005: null dataClass is wildcard for block, but not for auto', () => {
      const responder = generateEd25519Keypair();
      const askerAid = 'did:keri:EAsker_0000000000000000000000000000000';

      // Block grant with dataClass: null
      const blockGrant = issueAskGrantAcdc({
        issuerAid: `did:keri:${responder.cesrPublicKey}`,
        attributes: {
          grantee: askerAid,
          queryType: 'content',
          dataClass: null, // Wildcard block
          mode: 'block',
          disclosureCeiling: 'none',
          validUntil: '2028-01-01T00:00:00Z',
        },
        privateKey: responder.privateKey,
      });

      const blockEval = evaluateAcdcGrant({
        query: {
          queryType: 'content',
          dataClass: 'finance', // Any data class
          askerAid,
        },
        grant: blockGrant,
        issuerPublicKey: responder.cesrPublicKey,
      });

      expect(blockEval.decision).toBe('deny');

      // Auto grant with dataClass: null (must NOT act as wildcard)
      const autoGrant = issueAskGrantAcdc({
        issuerAid: `did:keri:${responder.cesrPublicKey}`,
        attributes: {
          grantee: askerAid,
          queryType: 'content',
          dataClass: null,
          mode: 'auto',
          disclosureCeiling: 'summary',
          validUntil: '2028-01-01T00:00:00Z',
        },
        privateKey: responder.privateKey,
      });

      const autoEval = evaluateAcdcGrant({
        query: {
          queryType: 'content',
          dataClass: 'finance',
          askerAid,
        },
        grant: autoGrant,
        issuerPublicKey: responder.cesrPublicKey,
      });

      // Must fall back to review, NOT auto
      expect(autoEval.decision).toBe('review');
    });
  });

  describe('OOBI (Out-Of-Band Introduction)', () => {
    it('constructs and parses OOBI URLs', () => {
      const aid = 'did:keri:EHubAppliance_00000000000000000000000000';
      const oobiUrl = buildOobiUrl({
        endpoint: 'https://hub.myhome.ts.net:8443',
        aid,
        role: 'hub',
        name: 'LivingRoomHub',
      });

      expect(oobiUrl).toBe(
        'https://hub.myhome.ts.net:8443/.well-known/keri/oobi/did%3Akeri%3AEHubAppliance_00000000000000000000000000?role=hub&name=LivingRoomHub',
      );

      const parsed = parseOobiUrl(oobiUrl);
      expect(parsed.aid).toBe(aid);
      expect(parsed.role).toBe('hub');
      expect(parsed.name).toBe('LivingRoomHub');
      expect(parsed.endpoints[0]).toBe('https://hub.myhome.ts.net:8443');
    });

    it('creates standard OOBI discovery responses', () => {
      const response = createOobiDiscoveryResponse({
        aid: 'did:keri:E123',
        role: 'hub',
        urls: ['https://hub.example.com'],
        currentPublicKey: 'BPub123',
        latestKelDigest: 'EDigest123',
      });

      expect(response.aid).toBe('did:keri:E123');
      expect(response.role).toBe('hub');
      expect(response.currentKey).toBe('BPub123');
    });
  });

  describe('RFC 9421 HTTP Message Signatures with KERI AIDs', () => {
    it('signs and verifies an HTTP ask request against the sender KEL', () => {
      const sender0 = generateEd25519Keypair();
      const sender1 = generateEd25519Keypair();

      const signedIcp = createInceptionEvent({
        currentCesrPublicKey: sender0.cesrPublicKey,
        nextCesrPublicKey: sender1.cesrPublicKey,
        privateKey: sender0.privateKey,
      });

      const senderAid = signedIcp.event.i;
      const body = JSON.stringify({ query: 'Free for lunch Friday?', queryType: 'availability' });
      const targetUri = 'https://responder.example/agent/v1/ask';

      const headers = signHttpRequest({
        method: 'POST',
        targetUri,
        body,
        aid: senderAid,
        privateKey: sender0.privateKey,
      });

      expect(headers['signature-input']).toContain('keyid="did:keri:');
      expect(headers.signature.startsWith('ci=:0A')).toBe(true);
      expect(headers['content-digest']).toBeDefined();

      const verifyResult = verifyHttpRequestWithKeri({
        method: 'POST',
        targetUri,
        headers,
        rawBody: body,
        senderKel: [signedIcp],
      });

      expect(verifyResult.ok).toBe(true);
      if (verifyResult.ok) {
        expect(verifyResult.senderAid).toBe(senderAid);
      }
    });

    it('refuses HTTP request if body is tampered', () => {
      const sender0 = generateEd25519Keypair();
      const sender1 = generateEd25519Keypair();

      const signedIcp = createInceptionEvent({
        currentCesrPublicKey: sender0.cesrPublicKey,
        nextCesrPublicKey: sender1.cesrPublicKey,
        privateKey: sender0.privateKey,
      });

      const senderAid = signedIcp.event.i;
      const targetUri = 'https://responder.example/agent/v1/ask';

      const headers = signHttpRequest({
        method: 'POST',
        targetUri,
        body: JSON.stringify({ prompt: 'legitimate prompt' }),
        aid: senderAid,
        privateKey: sender0.privateKey,
      });

      const verifyResult = verifyHttpRequestWithKeri({
        method: 'POST',
        targetUri,
        headers,
        rawBody: JSON.stringify({ prompt: 'tampered prompt' }), // Altered body
        senderKel: [signedIcp],
      });

      expect(verifyResult.ok).toBe(false);
      if (!verifyResult.ok) {
        expect(verifyResult.reason).toContain('Content-digest mismatch');
      }
    });
  });

  // The Hub itself never supplies these values (the names are reserved); this checks the helpers pass a caller's values through.
  describe('Reserved AID headers in the forward-auth signing helpers', () => {
    it('carries caller-supplied AID values through signing and verification unchanged', () => {
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

      const signed = buildSignedForwardAuthHeaders(secret, username, now, stableId);

      expect(signed[FORWARD_AUTH_USER_AID_HEADER]).toBe(stableId.userAid);
      expect(signed[FORWARD_AUTH_HUB_AID_HEADER]).toBe(stableId.hubAid);

      const verification = verifyForwardAuthHeaders(
        secret,
        {
          user: signed['X-CI-Hub-User'],
          timestamp: signed['X-CI-Hub-User-Timestamp'],
          signature: signed['X-CI-Hub-User-Signature'],
          issuer: signed['X-CI-Hub-User-Issuer'],
          userId: signed['X-CI-Hub-User-Id'],
          userIdSignature: signed['X-CI-Hub-User-Id-Signature'],
          userAid: signed[FORWARD_AUTH_USER_AID_HEADER],
          hubAid: signed[FORWARD_AUTH_HUB_AID_HEADER],
        },
        { now },
      );

      expect(verification.ok).toBe(true);
      if (verification.ok) {
        expect(verification.stableId?.userAid).toBe(stableId.userAid);
        expect(verification.stableId?.hubAid).toBe(stableId.hubAid);
      }
    });
  });
});
