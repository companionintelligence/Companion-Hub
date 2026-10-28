import { createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { computeCesrDigest, decodeCesrPublicKey, decodeCesrSignature, encodeCesrPublicKey, encodeCesrSignature } from './cesr.js';
import { canonicalStringify, computeSaid, verifySaid } from './said.js';

export interface Ed25519Keypair {
  publicKeyBytes: Buffer;
  cesrPublicKey: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** Generates a fresh Ed25519 keypair for KERI. */
export function generateEd25519Keypair(): Ed25519Keypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' });
  // In SPKI DER format for Ed25519, the last 32 bytes are the raw public key
  const publicKeyBytes = rawPub.subarray(rawPub.length - 32);
  const cesrPublicKey = encodeCesrPublicKey(publicKeyBytes);
  return {
    publicKeyBytes,
    cesrPublicKey,
    privateKey,
    publicKey,
  };
}

/** Pre-rotation commitment: computes the digest of the next public key. */
export function computePreRotationCommitment(nextCesrPublicKey: string): string {
  return computeCesrDigest(Buffer.from(nextCesrPublicKey, 'utf8'));
}

export interface InceptionEvent {
  v: string; // KERI version string
  t: 'icp';
  d: string; // SAID
  i: string; // Identifier (matches d)
  s: string; // Hex sequence ("0")
  kt: string; // Keys threshold ("1")
  k: string[]; // Active public keys (CESR 'B')
  nt: string; // Next keys threshold ("1")
  n: string[]; // Pre-rotation commitments (CESR 'E')
  bt: string; // Witness threshold ("0")
  b: string[]; // Witnesses
  c: string[];
  a: Record<string, unknown>[];
}

export interface RotationEvent {
  v: string;
  t: 'rot';
  d: string;
  i: string;
  s: string; // Hex sequence ("1", "2", ...)
  p: string; // Prior event digest (CESR 'E')
  kt: string;
  k: string[]; // Revealed next public keys
  nt: string;
  n: string[]; // Next-next pre-rotation commitments
  bt: string;
  b: string[];
  a: Record<string, unknown>[];
}

export interface InteractionEvent {
  v: string;
  t: 'ixn';
  d: string;
  i: string;
  s: string;
  p: string;
  a: Record<string, unknown>[]; // Data seals / metadata anchors
}

export type KeyEvent = InceptionEvent | RotationEvent | InteractionEvent;

export interface SignedKeyEvent {
  event: KeyEvent;
  signatures: string[]; // CESR '0A' signatures
}

/** Signs canonical event bytes using an Ed25519 private key. */
export function signKeyEvent(event: KeyEvent, privateKey: KeyObject): string {
  const data = Buffer.from(canonicalStringify(event), 'utf8');
  const sig = cryptoSign(null, data, privateKey);
  return encodeCesrSignature(sig);
}

/** Verifies a CESR signature over a canonical event using a CESR public key. */
export function verifyKeyEventSignature(event: KeyEvent, cesrSignature: string, cesrPublicKey: string): boolean {
  try {
    const pubBytes = decodeCesrPublicKey(cesrPublicKey);
    const sigBytes = decodeCesrSignature(cesrSignature);
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiDer = Buffer.concat([spkiPrefix, pubBytes]);
    const pubKeyObj = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    const data = Buffer.from(canonicalStringify(event), 'utf8');
    return cryptoVerify(null, data, pubKeyObj, sigBytes);
  } catch {
    return false;
  }
}

/** Incepts a new Autonomic Identifier (AID). */
export function createInceptionEvent(params: {
  currentCesrPublicKey: string;
  nextCesrPublicKey: string;
  privateKey: KeyObject;
  witnesses?: string[];
}): SignedKeyEvent {
  const nxtCommitment = computePreRotationCommitment(params.nextCesrPublicKey);
  const placeholder = '#'.repeat(44);
  const rawEvent = {
    v: 'KERI10JSON000115_',
    t: 'icp' as const,
    d: placeholder,
    i: placeholder,
    s: '0',
    kt: '1',
    k: [params.currentCesrPublicKey],
    nt: '1',
    n: [nxtCommitment],
    bt: params.witnesses?.length ? String(params.witnesses.length) : '0',
    b: params.witnesses ?? [],
    c: [],
    a: [],
  };

  const canonical = canonicalStringify(rawEvent);
  const digest = computeCesrDigest(Buffer.from(canonical, 'utf8'));
  const finalEvent: InceptionEvent = { ...rawEvent, d: digest, i: digest };
  const sig = signKeyEvent(finalEvent, params.privateKey);

  return { event: finalEvent, signatures: [sig] };
}

/** Rotates keys for an Autonomic Identifier, revealing the preimage of the prior pre-rotation commitment. */
export function createRotationEvent(params: {
  priorEvent: KeyEvent;
  newCesrPublicKey: string;
  nextNextCesrPublicKey: string;
  newPrivateKey: KeyObject;
  witnesses?: string[];
}): SignedKeyEvent {
  const priorSeq = Number.parseInt(params.priorEvent.s, 16);
  const nextSeq = (priorSeq + 1).toString(16);
  const nextNextCommitment = computePreRotationCommitment(params.nextNextCesrPublicKey);

  const rawEvent: Omit<RotationEvent, 'd'> = {
    v: 'KERI10JSON000135_',
    t: 'rot',
    i: params.priorEvent.i,
    s: nextSeq,
    p: params.priorEvent.d,
    kt: '1',
    k: [params.newCesrPublicKey],
    nt: '1',
    n: [nextNextCommitment],
    bt: params.witnesses?.length ? String(params.witnesses.length) : '0',
    b: params.witnesses ?? [],
    a: [],
  };

  const finalEvent = computeSaid(rawEvent as Record<string, unknown>) as unknown as RotationEvent;
  const sig = signKeyEvent(finalEvent, params.newPrivateKey);

  return { event: finalEvent, signatures: [sig] };
}

/** Anchors an interaction (e.g. metadata change, username rename, TEL anchor) without rotating keys. */
export function createInteractionEvent(params: {
  priorEvent: KeyEvent;
  currentCesrPublicKey: string;
  privateKey: KeyObject;
  seals: Record<string, unknown>[];
}): SignedKeyEvent {
  const priorSeq = Number.parseInt(params.priorEvent.s, 16);
  const nextSeq = (priorSeq + 1).toString(16);

  const rawEvent: Omit<InteractionEvent, 'd'> = {
    v: 'KERI10JSON0000a0_',
    t: 'ixn',
    i: params.priorEvent.i,
    s: nextSeq,
    p: params.priorEvent.d,
    a: params.seals,
  };

  const finalEvent = computeSaid(rawEvent as Record<string, unknown>) as unknown as InteractionEvent;
  const sig = signKeyEvent(finalEvent, params.privateKey);

  return { event: finalEvent, signatures: [sig] };
}

export interface KeyState {
  aid: string;
  sequenceNumber: number;
  currentPublicKey: string;
  nextCommitment: string;
  latestEventDigest: string;
}

/**
 * Validates a Key Event Log (KEL) verifying the entire cryptographic hash chain,
 * pre-rotation commitments, and event signatures.
 */
export function verifyKeyEventLog(kel: SignedKeyEvent[]): { valid: boolean; keyState?: KeyState; error?: string } {
  if (!kel.length) {
    return { valid: false, error: 'KEL is empty' };
  }

  const first = kel[0];
  if (!first) {
    return { valid: false, error: 'KEL is empty' };
  }
  if (first.event.t !== 'icp') {
    return { valid: false, error: 'First KEL event must be an inception (icp) event' };
  }
  const inceptionKey = first.event.k[0];
  const nextCommitmentValue = first.event.n[0];
  const inceptionSignature = first.signatures[0];
  if (!inceptionKey || !nextCommitmentValue || !inceptionSignature) {
    return { valid: false, error: 'Inception event is missing its key, next-key commitment, or signature' };
  }

  const placeholder = '#'.repeat(44);
  const testIcp = { ...first.event, d: placeholder, i: placeholder };
  const expectedIcpDigest = computeCesrDigest(Buffer.from(canonicalStringify(testIcp), 'utf8'));

  if (first.event.d !== expectedIcpDigest || first.event.i !== expectedIcpDigest) {
    return { valid: false, error: 'Inception event SAID or identifier digest verification failed' };
  }

  let currentKey = inceptionKey;
  let nextCommitment = nextCommitmentValue;
  let lastDigest = first.event.d;
  let currentSeq = 0;

  if (!verifyKeyEventSignature(first.event, inceptionSignature, currentKey)) {
    return { valid: false, error: 'Inception event signature verification failed' };
  }

  for (let idx = 1; idx < kel.length; idx++) {
    const item = kel[idx];
    if (!item) {
      return { valid: false, error: `KEL event at index ${idx} is missing` };
    }
    const event = item.event;

    if (!verifySaid(event as unknown as Record<string, unknown>)) {
      return { valid: false, error: `Event at index ${idx} has invalid SAID` };
    }

    const eventSeq = Number.parseInt(event.s, 16);
    if (eventSeq !== currentSeq + 1) {
      return { valid: false, error: `Invalid sequence at index ${idx}: expected ${currentSeq + 1}, got ${eventSeq}` };
    }

    if ('p' in event && event.p !== lastDigest) {
      return { valid: false, error: `Broken digest hash chain at index ${idx}: prior digest does not match` };
    }

    if (event.t === 'rot') {
      const revealedKey = event.k[0];
      const nextCommitmentValue = event.n[0];
      const signature = item.signatures[0];
      if (!revealedKey || !nextCommitmentValue || !signature) {
        return { valid: false, error: `Rotation event at index ${idx} is missing its key, next-key commitment, or signature` };
      }
      const revealedCommitment = computePreRotationCommitment(revealedKey);
      if (revealedCommitment !== nextCommitment) {
        return {
          valid: false,
          error: `Pre-rotation commitment violation at index ${idx}: revealed key does not match prior nxt commitment`,
        };
      }

      currentKey = revealedKey;
      nextCommitment = nextCommitmentValue;

      if (!verifyKeyEventSignature(event, signature, currentKey)) {
        return { valid: false, error: `Rotation event signature verification failed at index ${idx}` };
      }
    } else if (event.t === 'ixn') {
      const signature = item.signatures[0];
      if (!signature) {
        return { valid: false, error: `Interaction event at index ${idx} is missing its signature` };
      }
      if (!verifyKeyEventSignature(event, signature, currentKey)) {
        return { valid: false, error: `Interaction event signature verification failed at index ${idx}` };
      }
    } else {
      return { valid: false, error: `Unexpected event type ${(event as { t: string }).t} at index ${idx}` };
    }

    currentSeq = eventSeq;
    lastDigest = event.d;
  }

  return {
    valid: true,
    keyState: {
      aid: first.event.i,
      sequenceNumber: currentSeq,
      currentPublicKey: currentKey,
      nextCommitment,
      latestEventDigest: lastDigest,
    },
  };
}
