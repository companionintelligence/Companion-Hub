import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { type SignedKeyEvent, verifyKeyEventLog } from './aid';
import { decodeCesrPublicKey, decodeCesrSignature, encodeCesrSignature } from './cesr';

export interface HttpSignatureHeaders {
  'signature-input': string;
  signature: string;
  'content-digest'?: string;
}

export interface SignHttpRequestParams {
  method: string;
  targetUri: string;
  body?: string;
  aid: string;
  privateKey: KeyObject;
  now?: number; // Unix seconds
  validitySeconds?: number;
  nonce?: string;
}

/** Computes RFC 9530 Content-Digest header value for SHA-256. */
export function computeContentDigest(body: string): string {
  const digest = createHash('sha256').update(body, 'utf8').digest('base64');
  return `sha-256=:${digest}:`;
}

/** Builds the canonical RFC 9421 signature base. */
export function buildHttpSignatureBase(params: { method: string; targetUri: string; contentDigest?: string; signatureParamsString: string }): string {
  const lines: string[] = [];
  lines.push(`"@method": ${params.method.toUpperCase()}`);
  lines.push(`"@target-uri": ${params.targetUri}`);
  if (params.contentDigest) {
    lines.push(`"content-digest": ${params.contentDigest}`);
  }
  lines.push(`"@signature-params": ${params.signatureParamsString}`);
  return lines.join('\n');
}

/** Signs an HTTP request using an AID's private key following RFC 9421. */
export function signHttpRequest(params: SignHttpRequestParams): HttpSignatureHeaders {
  const created = params.now ?? Math.floor(Date.now() / 1000);
  const expires = created + (params.validitySeconds ?? 60);
  const nonce = params.nonce ?? Math.random().toString(36).substring(2, 18);
  const keyid = params.aid.startsWith('did:keri:') ? params.aid : `did:keri:${params.aid}`;

  const hasBody = Boolean(params.body);
  const contentDigestHeader = hasBody && params.body ? computeContentDigest(params.body) : undefined;

  const components = hasBody ? '("@method" "@target-uri" "content-digest")' : '("@method" "@target-uri")';
  const sigParamsString = `${components};created=${created};expires=${expires};keyid="${keyid}";alg="ed25519";nonce="${nonce}"`;

  const signatureBase = buildHttpSignatureBase({
    method: params.method,
    targetUri: params.targetUri,
    contentDigest: contentDigestHeader,
    signatureParamsString: sigParamsString,
  });

  const sigBytes = cryptoSign(null, Buffer.from(signatureBase, 'utf8'), params.privateKey);
  const cesrSig = encodeCesrSignature(sigBytes);

  return {
    'signature-input': `ci=${sigParamsString}`,
    signature: `ci=:${cesrSig}:`,
    ...(contentDigestHeader ? { 'content-digest': contentDigestHeader } : {}),
  };
}

export interface VerifyHttpSignatureParams {
  method: string;
  targetUri: string;
  headers: Record<string, string | undefined>;
  rawBody?: string;
  senderKel: SignedKeyEvent[];
  now?: number; // Unix seconds
}

export type HttpSignatureVerificationResult = { ok: true; senderAid: string; keySeq: number } | { ok: false; reason: string };

/**
 * Verifies an incoming RFC 9421 HTTP request against the sender's verified KEL.
 * Does NOT require an OIDC token or central registry.
 */
export function verifyHttpRequestWithKeri(params: VerifyHttpSignatureParams): HttpSignatureVerificationResult {
  const sigInput = params.headers['signature-input'];
  const sigHeader = params.headers.signature;
  const contentDigestHeader = params.headers['content-digest'];

  if (!sigInput || !sigHeader) {
    return { ok: false, reason: 'Missing signature or signature-input header' };
  }

  // 1. Verify sender's Key Event Log (KEL)
  const kelResult = verifyKeyEventLog(params.senderKel);
  if (!kelResult.valid || !kelResult.keyState) {
    return { ok: false, reason: `Sender KEL is invalid: ${kelResult.error}` };
  }

  // 2. Parse signature parameters
  const match = sigInput.match(/ci=(\([^)]+\);.*)$/);
  if (!match) {
    return { ok: false, reason: 'Malformed signature-input header' };
  }
  const sigParamsStr = match[1];

  const createdMatch = sigParamsStr.match(/created=(\d+)/);
  const expiresMatch = sigParamsStr.match(/expires=(\d+)/);
  const keyidMatch = sigParamsStr.match(/keyid="([^"]+)"/);

  if (!createdMatch || !expiresMatch || !keyidMatch) {
    return { ok: false, reason: 'Missing created, expires, or keyid in signature-input' };
  }

  const created = Number.parseInt(createdMatch[1], 10);
  const expires = Number.parseInt(expiresMatch[1], 10);
  const keyid = keyidMatch[1];
  const now = params.now ?? Math.floor(Date.now() / 1000);

  // Check clock skew (30s) and expiration (max 300s)
  if (created - now > 30) {
    return { ok: false, reason: 'Clock skew: signature created in the future' };
  }
  if (expires <= now) {
    return { ok: false, reason: 'Signature expired' };
  }
  if (expires - created > 300) {
    return { ok: false, reason: 'Signature lifetime window exceeds maximum allowable (300s)' };
  }

  // Verify keyid matches sender AID
  const expectedAid = `did:keri:${kelResult.keyState.aid}`;
  if (keyid !== expectedAid && keyid !== kelResult.keyState.aid) {
    return { ok: false, reason: `keyid '${keyid}' does not match KEL AID '${expectedAid}'` };
  }

  // 3. Check body and content-digest
  if (params.rawBody) {
    const computedDigest = computeContentDigest(params.rawBody);
    if (!contentDigestHeader || contentDigestHeader !== computedDigest) {
      return { ok: false, reason: 'Content-digest mismatch with request body' };
    }
  }

  // 4. Extract raw signature
  const sigMatch = sigHeader.match(/ci=:([^:]+):/);
  if (!sigMatch) {
    return { ok: false, reason: 'Malformed signature header format' };
  }
  const rawSig = sigMatch[1];

  // 5. Reconstruct base and verify signature against KEL current key
  const signatureBase = buildHttpSignatureBase({
    method: params.method,
    targetUri: params.targetUri,
    contentDigest: contentDigestHeader,
    signatureParamsString: sigParamsStr,
  });

  try {
    const pubBytes = decodeCesrPublicKey(kelResult.keyState.currentPublicKey);
    const sigBytes = decodeCesrSignature(rawSig);
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiDer = Buffer.concat([spkiPrefix, pubBytes]);
    const pubKeyObj = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

    const verified = cryptoVerify(null, Buffer.from(signatureBase, 'utf8'), pubKeyObj, sigBytes);
    if (!verified) {
      return { ok: false, reason: 'Cryptographic signature verification failed' };
    }

    return {
      ok: true,
      senderAid: kelResult.keyState.aid,
      keySeq: kelResult.keyState.sequenceNumber,
    };
  } catch (err) {
    return { ok: false, reason: `Signature verification error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
