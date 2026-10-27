import { createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { decodeCesrPublicKey, decodeCesrSignature, encodeCesrSignature } from './cesr';
import { canonicalStringify, computeSaid, verifySaid } from './said';

export interface TelIssuanceEvent {
  v: string;
  t: 'iss';
  d: string; // SAID of the TEL event
  i: string; // Issuer AID
  s: string; // Sequence ("0", "1", ...)
  ri: string; // Registry identifier
  a: {
    said: string; // SAID of the issued ACDC credential / grant
  };
}

export interface TelRevocationEvent {
  v: string;
  t: 'rev';
  d: string;
  i: string;
  s: string;
  p: string; // Prior TEL event digest
  ri: string;
  a: {
    said: string; // SAID of the revoked ACDC credential / grant
  };
}

export type TelEvent = TelIssuanceEvent | TelRevocationEvent;

export interface SignedTelEvent {
  event: TelEvent;
  signature: string; // CESR '0A'
}

/** Signs a TEL event using the issuer's private key. */
export function signTelEvent(event: TelEvent, privateKey: KeyObject): string {
  const data = Buffer.from(canonicalStringify(event), 'utf8');
  const sig = cryptoSign(null, data, privateKey);
  return encodeCesrSignature(sig);
}

/** Verifies a TEL event signature. */
export function verifyTelEventSignature(event: TelEvent, cesrSig: string, cesrPublicKey: string): boolean {
  try {
    const pubBytes = decodeCesrPublicKey(cesrPublicKey);
    const sigBytes = decodeCesrSignature(cesrSig);
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiDer = Buffer.concat([spkiPrefix, pubBytes]);
    const pubKeyObj = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    const data = Buffer.from(canonicalStringify(event), 'utf8');
    return cryptoVerify(null, data, pubKeyObj, sigBytes);
  } catch {
    return false;
  }
}

/** Records grant issuance into a TEL. */
export function createTelIssuance(params: {
  issuerAid: string;
  registryId: string;
  credentialSaid: string;
  privateKey: KeyObject;
  sequence?: number;
}): SignedTelEvent {
  const seq = (params.sequence ?? 0).toString(16);
  const rawEvent = {
    v: 'KERI10JSON0000a0_',
    t: 'iss' as const,
    d: '',
    i: params.issuerAid,
    s: seq,
    ri: params.registryId,
    a: {
      said: params.credentialSaid,
    },
  };

  const event = computeSaid(rawEvent as Record<string, unknown>) as TelIssuanceEvent;
  const signature = signTelEvent(event, params.privateKey);
  return { event, signature };
}

/** Records grant revocation into a TEL. */
export function createTelRevocation(params: { priorTelEvent: TelEvent; credentialSaid: string; privateKey: KeyObject }): SignedTelEvent {
  const priorSeq = Number.parseInt(params.priorTelEvent.s, 16);
  const nextSeq = (priorSeq + 1).toString(16);

  const rawEvent = {
    v: 'KERI10JSON0000b0_',
    t: 'rev' as const,
    d: '',
    i: params.priorTelEvent.i,
    s: nextSeq,
    p: params.priorTelEvent.d,
    ri: params.priorTelEvent.ri,
    a: {
      said: params.credentialSaid,
    },
  };

  const event = computeSaid(rawEvent as Record<string, unknown>) as TelRevocationEvent;
  const signature = signTelEvent(event, params.privateKey);
  return { event, signature };
}

export type CredentialTelStatus = 'active' | 'revoked' | 'unissued';

/**
 * Evaluates the status of an ACDC credential in a TEL.
 * Validates cryptographic signatures and sequence continuity.
 */
export function evaluateTelStatus(
  credentialSaid: string,
  tel: SignedTelEvent[],
  issuerPublicKey: string,
): { status: CredentialTelStatus; reason?: string } {
  let isIssued = false;
  let isRevoked = false;
  let currentSeq = -1;
  let lastDigest = '';

  for (let i = 0; i < tel.length; i++) {
    const item = tel[i];
    const event = item.event;

    if (!verifySaid(event as unknown as Record<string, unknown>)) {
      return { status: 'unissued', reason: `TEL event ${i} has invalid SAID` };
    }

    if (!verifyTelEventSignature(event, item.signature, issuerPublicKey)) {
      return { status: 'unissued', reason: `TEL event ${i} signature verification failed` };
    }

    const seq = Number.parseInt(event.s, 16);
    if (i === 0) {
      currentSeq = seq;
      lastDigest = event.d;
    } else {
      if (seq !== currentSeq + 1) {
        return { status: 'unissued', reason: `TEL sequence break at index ${i}` };
      }
      if ('p' in event && event.p !== lastDigest) {
        return { status: 'unissued', reason: `TEL digest chain broken at index ${i}` };
      }
      currentSeq = seq;
      lastDigest = event.d;
    }

    if (event.a?.said === credentialSaid) {
      if (event.t === 'iss') {
        isIssued = true;
      } else if (event.t === 'rev') {
        isRevoked = true;
      }
    }
  }

  if (isRevoked) {
    return { status: 'revoked' };
  }
  if (isIssued) {
    return { status: 'active' };
  }
  return { status: 'unissued' };
}
