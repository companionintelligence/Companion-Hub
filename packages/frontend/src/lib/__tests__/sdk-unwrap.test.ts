import { describe, expect, it } from 'vitest';
import { sdkErrorMessage, unwrapSdk } from '@/lib/sdk-unwrap';

describe('unwrapSdk', () => {
  // Without the app's interceptor the client hands back the parsed JSON body, and String() of it is
  // what a refused model pull used to show: "[object Object]".
  it("throws the body's message, not [object Object]", async () => {
    const body = { statusCode: 409, message: 'Model requires 20480 MB disk but only 1024 MB is available.' };

    await expect(unwrapSdk(Promise.resolve({ error: body }))).rejects.toThrow('Model requires 20480 MB disk but only 1024 MB is available.');
  });

  it('rethrows an Error as it is and returns data otherwise', async () => {
    const error = new Error('network down');
    await expect(unwrapSdk(Promise.resolve({ error }))).rejects.toBe(error);
    await expect(unwrapSdk(Promise.resolve({ data: { status: 'queued' } }))).resolves.toEqual({ status: 'queued' });
  });
});

describe('sdkErrorMessage', () => {
  it('reads every error body shape the Hub and its engines answer with', () => {
    expect(sdkErrorMessage({ message: ['modelId must be a string', 'bestEffort must be a boolean'] })).toBe(
      'modelId must be a string; bestEffort must be a boolean',
    );
    expect(sdkErrorMessage({ error: 'Model not found: Qwen3.8-27B-GGUF' })).toBe('Model not found: Qwen3.8-27B-GGUF');
    expect(sdkErrorMessage({ error: { message: 'bad model', type: 'invalid_request_error' } })).toBe('bad model');
    expect(sdkErrorMessage({ status: 'error', reason: 'not offered' })).toBe('not offered');
    expect(sdkErrorMessage('Bad Gateway')).toBe('Bad Gateway');
    expect(sdkErrorMessage({ code: 42 })).toBe('{"code":42}');
  });
});
