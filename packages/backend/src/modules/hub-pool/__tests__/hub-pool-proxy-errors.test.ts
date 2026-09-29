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
import { firstByteBudgetMs } from '../hub-pool-budget';

describe('describeAllCandidatesFailed', () => {
  it('names the deadline, and refuses to call a slow node unreachable', () => {
    const msg = describeAllCandidatesFailed('qwen3.6:35b', 2, new Error('No response headers within 300000ms'));
    expect(msg).toContain('300000ms');
    expect(msg).toContain('qwen3.6:35b');
    // The claim we must never make on this evidence.
    expect(msg).not.toMatch(/unreachable/i);
    expect(msg).toMatch(/deadline, not proof/i);
  });

  it('states the budget that APPLIED, not the fixed settings — a prompt-sized 922 s wait is not "300000ms"', () => {
    // Measured on fzzy, 2026-09-17: a 184 KB agent turn was cancelled at exactly 922.0 s (its
    // body-sized budget), and the message said "300000ms for headers on a streamed request".
    const msg = describeAllCandidatesFailed('qwen3-coder:30b', 1, new Error('No response headers within 922000ms'));
    expect(msg).toContain('922000ms');
    expect(msg).toContain('HUB_POOL_MIN_PREFILL_TOKENS_PER_SEC');
    expect(msg).not.toContain('300000ms for headers on a streamed request');
    expect(msg).toMatch(/deadline, not proof/i);
  });

  it('names the completion budget for a non-streamed request, and the undici cap when that is what cut it', () => {
    expect(describeAllCandidatesFailed('m', 2, new Error('No completion within 450000ms'))).toMatch(
      /450000ms for a whole non-streamed completion.*HUB_POOL_COMPLETION_TIMEOUT_MS/,
    );
    const undici = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
    expect(describeAllCandidatesFailed('m', 1, undici)).toMatch(/undici headersTimeout/);
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

// Ollama's log for one OpenClaw turn on beta-max: 47,104 prompt tokens, 98% evaluated at 296.8 s,
// cancelled by a fixed 300 s budget — five minutes of GPU work discarded and the request moved to a
// cold peer. The budget has to grow with the prompt the engine must read first.
describe('firstByteBudgetMs', () => {
  it('keeps the fixed budget for a small body', () => {
    expect(firstByteBudgetMs(0)).toBe(300_000);
    expect(firstByteBudgetMs(2_000)).toBe(300_000);
  });

  it('grows with the body once the estimated prompt outruns the floor rate', () => {
    // 160 KB ≈ 40,000 tokens; at the 50 tok/s floor that is 800 s.
    expect(firstByteBudgetMs(160_000)).toBe(800_000);
    // 188 KB (the 47k-token turn) ≈ 47,000 tokens → 940 s: past the 296.8 s it actually needed on a GPU node.
    expect(firstByteBudgetMs(188_000)).toBe(940_000);
  });
});
