/**
 * Which deadline applies to which request.
 *
 * The bug this covers was invisible in code review because the comment was TRUE for the case
 * everyone pictured. `CONNECT_TIMEOUT_MS` "only guards the wait for response headers" — correct for a
 * streamed request, where the first frame arrives in milliseconds. For a non-streamed completion the
 * upstream sends no headers until the whole body is ready, so the identical timer silently becomes a
 * cap on total generation time.
 *
 * Proven on the fleet, same node, same model, back to back:
 *   direct :11434 -> 200 in 33.9s
 *   pool   :5002  -> 502 in 15.03s, reported as an unreachable node
 * A 12s generation through the pool succeeded, and a cold model load — the likelier suspect —
 * succeeded in 4.6s with nothing resident. It is specifically generations past the deadline, which
 * means every real coding task, long summary and agent turn failed while short pings passed.
 */

import { describe, expect, it } from 'vitest';
import { isStreamingRequest } from '../hub-pool-proxy.service';

describe('isStreamingRequest', () => {
  it('is true only for an explicit stream:true', () => {
    expect(isStreamingRequest({ stream: true })).toBe(true);
  });

  it('is false for a body that omits stream — the OpenAI default is non-streamed', () => {
    // The default matters: omitting `stream` is how almost every client sends a completion, and it
    // is exactly the case that was being cut off at 15s.
    expect(isStreamingRequest({ model: 'm', messages: [] })).toBe(false);
  });

  it('is false for stream:false and for truthy-but-not-true values', () => {
    expect(isStreamingRequest({ stream: false })).toBe(false);
    // A string "true" is not a streaming request — the upstream would not stream, so budgeting as
    // though it would is how a real generation gets aborted again.
    expect(isStreamingRequest({ stream: 'true' })).toBe(false);
    expect(isStreamingRequest({ stream: 1 })).toBe(false);
  });

  it('survives the shapes a proxy actually sees', () => {
    expect(isStreamingRequest(null)).toBe(false);
    expect(isStreamingRequest(undefined)).toBe(false);
    expect(isStreamingRequest('not an object')).toBe(false);
    expect(isStreamingRequest([])).toBe(false);
  });
});

describe('describeAllCandidatesFailed recognises both deadlines', () => {
  it('names a completion timeout as a deadline, not a dead node', async () => {
    // The seam the merge created: two deadlines now exist, and the message helper originally matched
    // only the header one. Left unfixed, every long-generation abort — the common case, and the
    // whole reason the completion budget exists — would print a raw abort string instead of the
    // sentence that stops an operator hunting through pairing and ACLs.
    const { describeAllCandidatesFailed } = await import('../hub-pool-proxy.service');
    const msg = describeAllCandidatesFailed('qwen3.6:35b', 2, new Error('No completion within 300000ms'));
    expect(msg).toMatch(/deadline, not/i);
    expect(msg).not.toMatch(/unreachable/i);
    expect(msg).toContain('HUB_POOL_COMPLETION_TIMEOUT_MS');
  });

  it('still names a header timeout the same way', async () => {
    const { describeAllCandidatesFailed } = await import('../hub-pool-proxy.service');
    expect(describeAllCandidatesFailed('m', 1, new Error('No response headers within 15000ms'))).toMatch(/deadline, not/i);
  });

  it('a real transport failure is still reported as a failure', async () => {
    const { describeAllCandidatesFailed } = await import('../hub-pool-proxy.service');
    const msg = describeAllCandidatesFailed('m', 3, new Error('connect ECONNREFUSED 100.64.0.2:5002'));
    expect(msg).toContain('ECONNREFUSED');
    expect(msg).not.toMatch(/deadline, not/i);
  });
});
