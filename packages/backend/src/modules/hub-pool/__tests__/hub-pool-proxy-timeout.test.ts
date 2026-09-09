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
