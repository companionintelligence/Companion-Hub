import { describe, expect, it } from 'vitest';
import {
  CAPTURE_LIMITS,
  type CaptureTiming,
  type CaptureVerdict,
  OutputTail,
  REDACTED,
  buildAppCapture,
  buildLlmCapture,
  captureJson,
  captureTail,
  captureText,
  isCredentialName,
  pickHeaders,
  promptCharsOf,
  redactHeaders,
  redactUrl,
  scaleLimits,
  truncationMarker,
} from '../capture';

const SECRET = 'sk-live-9f4c2b7e0a1d3f5081726354abcdef00';

const timing: CaptureTiming = { startedAt: 1_700_000_000_000, durationMs: 1234, ttftMs: 210 };
const verdict: CaptureVerdict = { score: 'pass', ok: true, kind: null, failures: [] };

describe('credential redaction', () => {
  it('replaces the value of every header whose name is a known credential, keeping the name visible', () => {
    const out = redactHeaders({
      Authorization: `Bearer ${SECRET}`,
      'x-api-key': SECRET,
      Cookie: `session=${SECRET}`,
      'content-type': 'application/json',
    });
    expect(out.Authorization).toBe(REDACTED);
    expect(out['x-api-key']).toBe(REDACTED);
    expect(out.Cookie).toBe(REDACTED);
    // Kept, not deleted: "this request carried an Authorization header" is diagnostic on a 401.
    expect(Object.keys(out)).toContain('Authorization');
    expect(out['content-type']).toBe('application/json');
  });

  it('also catches the credential-shaped names nobody enumerated', () => {
    const out = redactHeaders({ 'x-auth-token': SECRET, 'x-vendor-secret': SECRET, 'x-request-id': 'abc-123', server: 'uvicorn' });
    expect(out['x-auth-token']).toBe(REDACTED);
    expect(out['x-vendor-secret']).toBe(REDACTED);
    expect(out['x-request-id']).toBe('abc-123');
    expect(out.server).toBe('uvicorn');
  });

  it('does NOT match names that merely contain the letters, so a real header keeps its diagnostic value', () => {
    expect(isCredentialName('www-authenticate')).toBe(false);
    expect(isCredentialName('monkey')).toBe(false);
    expect(isCredentialName('content-type')).toBe(false);
    expect(isCredentialName('authorization')).toBe(true);
    expect(isCredentialName('X-Api-Key')).toBe(true);
  });

  it('bounds a non-credential header value so a stray header cannot spend a KB', () => {
    const out = redactHeaders({ 'x-note': 'z'.repeat(1000) }, 16);
    expect(out['x-note']).toHaveLength(16);
  });

  it('strips a credential out of a URL query string and out of the user:pass authority', () => {
    expect(redactUrl(`http://host:8000/v1/chat?api_key=${SECRET}&model=qwen3`)).toBe(`http://host:8000/v1/chat?api_key=${REDACTED}&model=qwen3`);
    expect(redactUrl(`https://user:${SECRET}@host/v1/chat`)).toBe(`https://${REDACTED}@host/v1/chat`);
    expect(redactUrl(`/v1/chat?access_token=${SECRET}#frag`)).toBe(`/v1/chat?access_token=${REDACTED}#frag`);
  });

  it('leaves a URL with nothing credential-shaped in it exactly as sent', () => {
    expect(redactUrl('http://host:11434/api/chat')).toBe('http://host:11434/api/chat');
    expect(redactUrl('http://host:8000/v1/chat?model=qwen3&stream=true')).toBe('http://host:8000/v1/chat?model=qwen3&stream=true');
    expect(redactUrl(null)).toBe('');
  });

  it('redacts a credential-named header even when a caller asks for it by name', () => {
    const headers = new Headers({ 'content-type': 'application/json', 'set-cookie': `sid=${SECRET}` });
    const out = pickHeaders(headers, ['content-type', 'set-cookie']);
    expect(out['content-type']).toBe('application/json');
    expect(out['set-cookie']).toBe(REDACTED);
  });

  it('keeps no trace of a header or query credential anywhere in the assembled envelope', () => {
    const envelope = buildLlmCapture({
      request: {
        url: `http://host:8000/v1/chat/completions?api_key=${SECRET}`,
        headers: { Authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        bodyText: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] }),
        bodyObject: { model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] },
        dialect: 'openai-chat',
        model: 'qwen3:8b',
        backend: 'vllm',
        transport: 'direct',
        stream: false,
        timeoutMs: 30_000,
      },
      response: { status: 200, headers: { 'set-cookie': `sid=${SECRET}`, 'content-type': 'application/json' }, text: 'hello' },
      timing,
      verdict,
    });
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
    expect(envelope.request?.url).toContain(REDACTED);
    expect(envelope.response?.headers['set-cookie']).toBe(REDACTED);
    expect(envelope.request?.promptChars).toBe(2);
  });

  it('does NOT redact a credential inside a request body — the documented limit of a name-based scheme', () => {
    const envelope = buildLlmCapture({
      request: {
        url: 'http://host:8000/v1/chat/completions',
        headers: {},
        bodyText: JSON.stringify({ model: 'qwen3:8b', apiKey: SECRET }),
        dialect: 'openai-chat',
        model: 'qwen3:8b',
        backend: 'vllm',
        transport: 'direct',
        stream: false,
        timeoutMs: 30_000,
      },
      timing,
      verdict,
    });
    // Bodies are the measurement and are stored as sent. A caller putting a credential in one is
    // capturing it — this test exists so nobody reads the module as promising otherwise.
    expect(envelope.request?.body?.text).toContain(SECRET);
  });
});

describe('bounded excerpts', () => {
  it('keeps a head AND a tail with a marker naming exactly how much was dropped', () => {
    const original = `${'H'.repeat(500)}${'M'.repeat(9000)}${'T'.repeat(500)}`;
    const cap = captureText(original, 100);
    expect(cap).not.toBeNull();
    expect(cap?.chars).toBe(original.length);
    expect(cap?.truncated).toBe(true);
    expect(cap?.omitted).toBe(original.length - 100);
    // 100 characters of the original survive; the marker is the only thing added.
    expect(cap?.text).toHaveLength(100 + truncationMarker(cap?.omitted ?? 0, original.length).length);
    expect(cap?.text.startsWith('H'.repeat(75))).toBe(true);
    expect(cap?.text.endsWith('T'.repeat(25))).toBe(true);
    expect(cap?.text).toContain(`truncated ${original.length - 100} of ${original.length} chars`);
  });

  it('returns the string untouched when it already fits, with omitted 0', () => {
    expect(captureText('short', 100)).toEqual({ text: 'short', chars: 5, truncated: false, omitted: 0 });
  });

  it('spends the whole budget on the head when tailShare is 0', () => {
    const cap = captureText('A'.repeat(50) + 'Z'.repeat(50), 10, 0);
    expect(cap?.text.startsWith('A'.repeat(10))).toBe(true);
    expect(cap?.text.endsWith('\n')).toBe(true);
  });

  it('keeps null distinct from empty, because a genuinely empty response is a real finding', () => {
    expect(captureText(null, 100)).toBeNull();
    expect(captureText(undefined, 100)).toBeNull();
    expect(captureText('', 100)).toEqual({ text: '', chars: 0, truncated: false, omitted: 0 });
  });

  it('reports the full size even when the budget is zero, rather than silently keeping nothing', () => {
    expect(captureText('abcdef', 0)).toEqual({ text: '', chars: 6, truncated: true, omitted: 6 });
  });

  it('keeps the END for process output, where the head is a banner and the tail is the failure', () => {
    const cap = captureTail(`${'banner\n'.repeat(100)}FATAL: it broke`, 20);
    expect(cap?.text.endsWith('FATAL: it broke')).toBe(true);
    expect(cap?.truncated).toBe(true);
    expect(captureTail(null, 20)).toBeNull();
  });

  it('describes a value it cannot serialize instead of dropping the field', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(captureJson(cycle, 200)?.text).toContain('[unserializable:');
    expect(captureJson({ a: 1 }, 200)?.text).toBe('{"a":1}');
    expect(captureJson(null, 200)).toBeNull();
  });

  it('scales every budget together, so a limit added to the interface cannot silently ignore the scale', () => {
    const half = scaleLimits(0.5);
    for (const key of Object.keys(CAPTURE_LIMITS) as (keyof typeof CAPTURE_LIMITS)[]) {
      expect(half[key]).toBe(Math.round(CAPTURE_LIMITS[key] * 0.5));
    }
    expect(scaleLimits(-1).requestBody).toBe(0);
  });
});

describe('promptCharsOf', () => {
  it('counts the expanded prompt off the body rather than re-expanding it', () => {
    expect(promptCharsOf({ messages: [{ content: 'abc' }, { content: 'de' }] })).toBe(5);
    expect(promptCharsOf({ prompt: 'abcd', system: 'ef' })).toBe(6);
    expect(promptCharsOf({ input: ['ab', 'cd'] })).toBe(4);
  });

  it('says "not known" rather than 0, which would read as "we sent an empty prompt"', () => {
    expect(promptCharsOf({ model: 'qwen3:8b' })).toBeNull();
    expect(promptCharsOf(null)).toBeNull();
    expect(promptCharsOf('not an object')).toBeNull();
  });
});

describe('app capture', () => {
  it('states the missing request as null rather than faking an empty response panel', () => {
    const envelope = buildAppCapture({ command: 'run-harness --app notes', stdout: 'starting\nok', stderr: '', timing, verdict });
    expect(envelope.request).toBeNull();
    expect(envelope.response).toBeNull();
    expect(envelope.output?.command?.text).toBe('run-harness --app notes');
    expect(envelope.output?.stdout?.text).toBe('starting\nok');
    expect(envelope.checks).toEqual([]);
  });
});

describe('OutputTail', () => {
  it('retains a fixed number of bounded lines, so watching a target costs constant memory', () => {
    const tail = new OutputTail({ maxLines: 3, maxLineChars: 10 });
    tail.push('one\ntwo\n\nthree\n');
    tail.push(`${'x'.repeat(50)}\nfour`);
    expect(tail.size()).toBe(3);
    expect(tail.text().split('\n')).toEqual(['three', `${'x'.repeat(10)}…`, 'four']);
  });

  it('drops blank lines and starts empty', () => {
    const tail = new OutputTail();
    expect(tail.size()).toBe(0);
    expect(tail.text()).toBe('');
    tail.push('\n\n   \n');
    expect(tail.size()).toBe(0);
  });
});
