import { createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { decodeCesrPublicKey, decodeCesrSignature, encodeCesrSignature } from './cesr';
import { canonicalStringify, computeSaid, verifySaid } from './said';
import { type SignedTelEvent, evaluateTelStatus } from './tel';

export type DisclosureCeiling = 'none' | 'boolean' | 'count' | 'summary' | 'redacted' | 'full';
export type AskGrantMode = 'auto' | 'review' | 'block';

export interface AskGrantAttributes {
  grantee: string; // did:keri:<asker_aid>
  queryType: string; // e.g. "availability", "content", "relationship"
  dataClass: string | null; // e.g. "calendar", "photos", null for any
  mode: AskGrantMode;
  disclosureCeiling: DisclosureCeiling;
  validUntil: string; // ISO-8601
}

export interface MCPCapabilityAttributes {
  grantee: string; // did:keri:<agent_aid>
  scopes: ('memory' | 'intents' | 'mcp' | 'capture')[];
  capability: 'read' | 'write' | 'full';
  validUntil: string;
}

export interface AcdcCredential<T = Record<string, unknown>> {
  v: string; // ACDC format version
  d: string; // SAID of the credential
  i: string; // Issuer AID
  s: string; // Schema SAID
  a: T; // Attributes block
  e?: Record<string, unknown>; // Edge / delegation links
}

export interface SignedAcdcCredential<T = Record<string, unknown>> {
  credential: AcdcCredential<T>;
  signature: string; // CESR '0A'
}

/** Pre-computed SAID schema constants for Companion Intelligence. */
export const ASK_GRANT_SCHEMA_SAID = 'EAskGrantSchemaV1_000000000000000000000000000';
export const MCP_CAPABILITY_SCHEMA_SAID = 'EMCPCapabilitySchemaV1_00000000000000000000000';

/** Signs canonical ACDC credential bytes using the issuer's private key. */
export function signAcdcCredential<T>(credential: AcdcCredential<T>, privateKey: KeyObject): string {
  const data = Buffer.from(canonicalStringify(credential), 'utf8');
  const sig = cryptoSign(null, data, privateKey);
  return encodeCesrSignature(sig);
}

/** Verifies an ACDC credential signature using the issuer's public key. */
export function verifyAcdcSignature<T>(credential: AcdcCredential<T>, cesrSignature: string, cesrPublicKey: string): boolean {
  try {
    const pubBytes = decodeCesrPublicKey(cesrPublicKey);
    const sigBytes = decodeCesrSignature(cesrSignature);
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiDer = Buffer.concat([spkiPrefix, pubBytes]);
    const pubKeyObj = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    const data = Buffer.from(canonicalStringify(credential), 'utf8');
    return cryptoVerify(null, data, pubKeyObj, sigBytes);
  } catch {
    return false;
  }
}

/** Issues an Authentic Chained Data Container (ACDC) verifiable credential. */
export function issueAcdc<T extends Record<string, unknown>>(params: {
  issuerAid: string;
  schemaSaid: string;
  attributes: T;
  privateKey: KeyObject;
  edges?: Record<string, unknown>;
}): SignedAcdcCredential<T> {
  const rawCred = {
    v: 'ACDC10JSON00019a_',
    d: '',
    i: params.issuerAid,
    s: params.schemaSaid,
    a: params.attributes,
    ...(params.edges ? { e: params.edges } : {}),
  };

  const credential = computeSaid(rawCred as Record<string, unknown>) as AcdcCredential<T>;
  const signature = signAcdcCredential(credential, params.privateKey);

  return { credential, signature };
}

/** Issues a typed Ask Grant ACDC. */
export function issueAskGrantAcdc(params: {
  issuerAid: string;
  attributes: AskGrantAttributes;
  privateKey: KeyObject;
}): SignedAcdcCredential<AskGrantAttributes> {
  return issueAcdc({
    issuerAid: params.issuerAid,
    schemaSaid: ASK_GRANT_SCHEMA_SAID,
    attributes: params.attributes,
    privateKey: params.privateKey,
  });
}

/** Issues a typed MCP Capability ACDC. */
export function issueMcpCapabilityAcdc(params: {
  issuerAid: string;
  attributes: MCPCapabilityAttributes;
  privateKey: KeyObject;
  edges?: Record<string, unknown>;
}): SignedAcdcCredential<MCPCapabilityAttributes> {
  return issueAcdc({
    issuerAid: params.issuerAid,
    schemaSaid: MCP_CAPABILITY_SCHEMA_SAID,
    attributes: params.attributes,
    privateKey: params.privateKey,
    edges: params.edges,
  });
}

/**
 * Validates an ACDC credential's cryptographic integrity and signature.
 */
export function verifyAcdcCredential<T>(signedCred: SignedAcdcCredential<T>, issuerPublicKey: string): { valid: boolean; error?: string } {
  if (!verifySaid(signedCred.credential as unknown as Record<string, unknown>)) {
    return { valid: false, error: 'ACDC SAID verification failed: content digest mismatch' };
  }

  if (!verifyAcdcSignature(signedCred.credential, signedCred.signature, issuerPublicKey)) {
    return { valid: false, error: 'ACDC issuer signature verification failed' };
  }

  return { valid: true };
}

export interface AskQueryCheck {
  queryType: string;
  dataClass?: string | null;
  askerAid: string;
  now?: Date;
}

export type GrantEvaluationResult =
  | { decision: 'auto'; maxDisclosure: DisclosureCeiling; grantSaid: string }
  | { decision: 'review'; grantSaid?: string }
  | { decision: 'deny'; reason: string; grantSaid?: string };

const DISCLOSURE_LADDER_ORDER: Record<DisclosureCeiling, number> = {
  none: 0,
  boolean: 1,
  count: 2,
  summary: 3,
  redacted: 4,
  full: 5,
};

/** Strictest (narrowest) of two disclosure ceilings. */
export function strictestCeiling(a: DisclosureCeiling, b: DisclosureCeiling): DisclosureCeiling {
  return DISCLOSURE_LADDER_ORDER[a] <= DISCLOSURE_LADDER_ORDER[b] ? a : b;
}

/**
 * Evaluates an ACDC Ask Grant against an incoming query and checks TEL revocation status.
 * Adheres strictly to the pure logic in grantMatch.ts and ADRs 0001-0005.
 */
export function evaluateAcdcGrant(params: {
  query: AskQueryCheck;
  grant: SignedAcdcCredential<AskGrantAttributes>;
  issuerPublicKey: string;
  telEvents?: SignedTelEvent[];
}): GrantEvaluationResult {
  const verification = verifyAcdcCredential(params.grant, params.issuerPublicKey);
  if (!verification.valid) {
    return { decision: 'deny', reason: `Grant credential invalid: ${verification.error}` };
  }

  const attrs = params.grant.credential.a;
  const now = params.query.now ?? new Date();

  // 1. Verify expiration
  const validUntil = new Date(attrs.validUntil);
  if (now > validUntil) {
    return { decision: 'review' }; // Lapsed grant falls back to owner review
  }

  // 2. Verify grantee match
  if (attrs.grantee !== params.query.askerAid) {
    return { decision: 'deny', reason: 'Grantee AID does not match asker' };
  }

  // 3. Check TEL revocation
  if (params.telEvents?.length) {
    const telCheck = evaluateTelStatus(params.grant.credential.d, params.telEvents, params.issuerPublicKey);
    if (telCheck.status === 'revoked') {
      return { decision: 'deny', reason: 'Grant has been revoked in TEL', grantSaid: params.grant.credential.d };
    }
  }

  // 4. Query type match
  if (attrs.queryType !== '*' && attrs.queryType !== params.query.queryType) {
    return { decision: 'review' };
  }

  // 5. Data class match
  // Null dataClass on block grant = wildcard (ADR-0005)
  if (attrs.mode === 'block') {
    if (attrs.dataClass === null || attrs.dataClass === params.query.dataClass) {
      return { decision: 'deny', reason: 'Matched standing block grant', grantSaid: params.grant.credential.d };
    }
  }

  // Null dataClass on auto grant = NOT wildcard (must explicitly match)
  if (attrs.mode === 'auto') {
    if (attrs.dataClass && attrs.dataClass === params.query.dataClass) {
      return {
        decision: 'auto',
        maxDisclosure: attrs.disclosureCeiling,
        grantSaid: params.grant.credential.d,
      };
    }
    // If class doesn't match, floor is review
    return { decision: 'review', grantSaid: params.grant.credential.d };
  }

  return { decision: 'review', grantSaid: params.grant.credential.d };
}
