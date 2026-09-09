/**
 * What the pool tells a caller when every candidate failed.
 *
 * This file exists because the message it covers was wrong in a way that cost real debugging time.
 * Every failure — timeout, refusal, 500 — produced the same sentence: "All pool nodes serving model
 * X are currently unreachable." On a live fleet run that sentence appeared five times, on two nodes
 * that were serving the identical request fine over the direct transport in the same run. The
 * durations gave it away: 15017ms and 15020ms on one node, ~11050ms on another — variance of
 * milliseconds against a fixed deadline, which is the signature of our own budget expiring, not of
 * a network.
 *
 * "Unreachable" sends an operator to look at pairing, ACLs and inventory. "We gave up after 15s"
 * sends them to look at load. Those are different days of work, so the distinction is worth a test.
 */

import { describe, expect, it } from 'vitest';
import { describeAllCandidatesFailed } from '../hub-pool-proxy.service';

describe('describeAllCandidatesFailed', () => {
  it('names the deadline, and refuses to call a slow node unreachable', () => {
    const msg = describeAllCandidatesFailed('qwen3.6:35b', 2, new Error('No response headers within 15000ms'));
    expect(msg).toContain('15000ms');
    expect(msg).toContain('qwen3.6:35b');
    // The claim we must never make on this evidence.
    expect(msg).not.toMatch(/unreachable/i);
    expect(msg).toMatch(/deadline, not proof/i);
  });

  it('treats an abort as the same deadline, since that is how the timeout surfaces', () => {
    // The proxy aborts the request via AbortController, so the error a caller sees is an abort
    // rather than the timer's own message. Both are the budget expiring.
    expect(describeAllCandidatesFailed('m', 1, new Error('This operation was aborted'))).toMatch(/deadline, not proof/i);
  });

  it('reports a genuine transport failure as a failure, and carries the reason', () => {
    const msg = describeAllCandidatesFailed('m', 3, new Error('connect ECONNREFUSED 100.64.0.2:5002'));
    expect(msg).toContain('ECONNREFUSED');
    expect(msg).toContain('3 pool candidates');
    // A real refusal must NOT be softened into "we ran out of time".
    expect(msg).not.toMatch(/deadline, not proof/i);
  });

  it('agrees with itself on plurality', () => {
    expect(describeAllCandidatesFailed('m', 1, new Error('boom'))).toContain('1 pool candidate for');
    expect(describeAllCandidatesFailed('m', 2, new Error('boom'))).toContain('2 pool candidates for');
  });

  it('survives a non-Error rejection without printing [object Object]', () => {
    const msg = describeAllCandidatesFailed('m', 1, { code: 'weird' });
    expect(msg).not.toContain('[object Object]');
  });
});
