import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadResponseAsFile, getFilenameFromContentDisposition } from './log-download';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('getFilenameFromContentDisposition', () => {
  it('returns the fallback filename when the header is missing', () => {
    expect(getFilenameFromContentDisposition(null, 'ci-hub-logs.log')).toBe('ci-hub-logs.log');
  });

  it('extracts a quoted filename', () => {
    expect(getFilenameFromContentDisposition('attachment; filename="hub.log"', 'fallback.log')).toBe('hub.log');
  });

  it('extracts and decodes an RFC 5987 filename', () => {
    expect(getFilenameFromContentDisposition("attachment; filename*=UTF-8''hub%20logs.log", 'fallback.log')).toBe('hub logs.log');
  });
});

describe('downloadResponseAsFile', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('downloads the response body using the filename from the response headers', async () => {
    vi.useFakeTimers();

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:ci-hub-logs');
    const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const appendChildSpy = vi.spyOn(document.body, 'appendChild');

    const response = new Response(new Blob(['hub logs'], { type: 'text/plain' }), {
      headers: {
        'Content-Disposition': 'attachment; filename="ci-hub-logs-2026-04-17.log"',
      },
    });

    await downloadResponseAsFile(response, 'fallback.log');

    const link = appendChildSpy.mock.calls[0]?.[0] as HTMLAnchorElement | undefined;
    expect(link).toBeDefined();
    expect(link?.download).toBe('ci-hub-logs-2026-04-17.log');
    expect(link?.href).toBe('blob:ci-hub-logs');
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(createObjectUrlSpy).toHaveBeenCalledOnce();

    await vi.runAllTimersAsync();
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith('blob:ci-hub-logs');
  });

  it('saves downloads through Tauri when running in the desktop app', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: vi.fn() },
      configurable: true,
    });
    mockInvoke.mockResolvedValue('/Users/bennett/Downloads/ci-hub-logs.log');

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:unused');
    const response = new Response('hub logs', {
      headers: {
        'Content-Disposition': 'attachment; filename="ci-hub-logs.log"',
      },
    });

    await downloadResponseAsFile(response, 'fallback.log');

    expect(mockInvoke).toHaveBeenCalledWith('save_download_command', {
      filename: 'ci-hub-logs.log',
      contents: Array.from(new TextEncoder().encode('hub logs')),
    });
    expect(clickSpy).not.toHaveBeenCalled();
    expect(createObjectUrlSpy).not.toHaveBeenCalled();
  });
});
