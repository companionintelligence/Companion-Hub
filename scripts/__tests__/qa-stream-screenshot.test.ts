import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// qa-stream.ts is copied to fleet nodes and runs its CLI body on import, so keep the diagnostic
// formatter as a self-contained source block and exercise that exact implementation here.
const source = readFileSync(join(import.meta.dirname, '..', 'qa-stream.ts'), 'utf-8');
const block = /\/\/ <screenshot-diagnostics>([\s\S]*?)\/\/ <\/screenshot-diagnostics>/.exec(source);
if (!block) throw new Error('the <screenshot-diagnostics> block is missing from scripts/qa-stream.ts');
const js = ts.transpileModule(block[1], { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const { screenshotDiagnostic, screenshotFailureKind } = new Function(`${js}\nreturn { screenshotDiagnostic, screenshotFailureKind };`)() as {
  screenshotDiagnostic: (input: {
    blank: boolean;
    timedOut: boolean;
    status: number | null;
    signal: string | null;
    stderr: string;
    elapsedMs: number;
  }) => string;
  screenshotFailureKind: (input: { attempted: boolean; hasScreenshot: boolean; backendHealthy: boolean | null }) => 'screenshot' | 'backend' | null;
};

const captureBlock = /\/\/ <playwright-screenshot-capture>([\s\S]*?)\/\/ <\/playwright-screenshot-capture>/.exec(source);
if (!captureBlock) throw new Error('the <playwright-screenshot-capture> block is missing from scripts/qa-stream.ts');
const captureJs = ts.transpileModule(captureBlock[1], { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const makeCapture = new Function('CHROME_SHOT_FLAGS', 'isBlankScreenshot', `${captureJs}\nreturn captureScreenshotWithPlaywright;`);
const captureScreenshotWithPlaywright = (blank = false) =>
  makeCapture(['--headless=new', '--no-sandbox', '--disable-background-networking'], () => blank);

const input = (overrides: Partial<Parameters<typeof screenshotDiagnostic>[0]> = {}) => ({
  blank: false,
  timedOut: false,
  status: null,
  signal: null,
  stderr: '',
  elapsedMs: 0,
  ...overrides,
});

describe('qa-stream screenshot diagnostics', () => {
  it('reports a browser timeout separately from an external signal', () => {
    expect(screenshotDiagnostic(input({ timedOut: true, signal: 'SIGKILL', elapsedMs: 55_250 }))).toBe(
      'screenshot timed out after 55s (browser process killed)',
    );
    expect(screenshotDiagnostic(input({ signal: 'SIGKILL' }))).toBe('screenshot failed: exit=null signal=SIGKILL');
  });

  it('keeps the blank-page classification stable', () => {
    expect(screenshotDiagnostic(input({ blank: true, timedOut: true }))).toBe('screenshot blank (page load timed out before paint)');
  });

  it('keeps the tail of Chromium diagnostics without leaking an unbounded log', () => {
    const note = screenshotDiagnostic(input({ status: 1, stderr: `${'noise '.repeat(100)} renderer failed` }));
    expect(note).toMatch(/^screenshot failed: exit=1 \| /);
    expect(note).toContain('renderer failed');
    expect(note.length).toBeLessThan(220);
  });

  it('classifies an attempted screenshot failure and keeps backend degradation distinct', () => {
    expect(screenshotFailureKind({ attempted: true, hasScreenshot: false, backendHealthy: null })).toBe('screenshot');
    expect(screenshotFailureKind({ attempted: false, hasScreenshot: false, backendHealthy: null })).toBeNull();
    expect(screenshotFailureKind({ attempted: true, hasScreenshot: false, backendHealthy: false })).toBe('backend');
    expect(screenshotFailureKind({ attempted: true, hasScreenshot: true, backendHealthy: false })).toBe('backend');
  });
});

describe('qa-stream screenshot browser flags', () => {
  it('disables background Chromium services that caused fleet page-load hangs', () => {
    for (const flag of [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
    ]) {
      expect(source).toContain(`'${flag}'`);
    }
  });

  function mockChromium(
    options: {
      commit?: boolean;
      contentPending?: boolean;
      closePending?: boolean;
      navigationError?: boolean;
      renderDelayMs?: number;
      screenshotError?: boolean;
      visibleContent?: boolean;
    } = {},
  ) {
    const state = {
      url: 'about:blank',
      gotoOptions: null as Record<string, unknown> | null,
      launchOptions: null as Record<string, unknown> | null,
      connectOptions: null as Record<string, unknown> | null,
      contextOptions: null as Record<string, unknown> | null,
      screenshotOptions: null as Record<string, unknown> | null,
      screenshotCount: 0,
      contentReady: false,
      contentWaitOptions: null as Record<string, unknown> | null,
      browserCloseCalled: false,
      serverCloseCalled: false,
      browserClosed: false,
      serverClosed: false,
      killSignal: null as string | null,
    };
    const page = {
      goto: async (url: string, gotoOptions: Record<string, unknown>) => {
        state.gotoOptions = gotoOptions;
        if (options.commit !== false) state.url = url;
        if (options.navigationError) throw new Error('navigation timed out');
      },
      url: () => state.url,
      waitForFunction: async (_fn: () => boolean, _arg: undefined, waitOptions: Record<string, unknown>) => {
        state.contentWaitOptions = waitOptions;
        if (options.contentPending) return await new Promise<never>(() => {});
        if (options.visibleContent === false) throw new Error('visible content did not appear');
        if (options.renderDelayMs) await new Promise((resolve) => setTimeout(resolve, options.renderDelayMs));
        state.contentReady = true;
        return { dispose: async () => {} };
      },
      screenshot: async (screenshotOptions: Record<string, unknown>) => {
        state.screenshotOptions = screenshotOptions;
        state.screenshotCount += 1;
        if (options.visibleContent !== false && !state.contentReady) throw new Error('screenshot started before visible content');
        if (options.screenshotError) throw new Error('capture failed');
      },
    };
    const chromium = {
      launchServer: async (launchOptions: Record<string, unknown>) => {
        state.launchOptions = launchOptions;
        return {
          wsEndpoint: () => 'ws://127.0.0.1:4444/browser',
          process: () => ({
            exitCode: null,
            kill: (signal: 'SIGKILL') => {
              state.killSignal = signal;
              return true;
            },
          }),
          close: async () => {
            state.serverCloseCalled = true;
            if (options.closePending) return await new Promise<never>(() => {});
            state.serverClosed = true;
          },
        };
      },
      connect: async (_wsEndpoint: string, connectOptions: Record<string, unknown>) => {
        state.connectOptions = connectOptions;
        return {
          newContext: async (contextOptions: Record<string, unknown>) => {
            state.contextOptions = contextOptions;
            return { newPage: async () => page };
          },
          close: async () => {
            state.browserCloseCalled = true;
            if (options.closePending) return await new Promise<never>(() => {});
            state.browserClosed = true;
          },
        };
      },
    };
    return { chromium, state };
  }

  const captureOptions = {
    captureTimeoutMs: 30_000,
    cleanupTimeoutMs: 500,
    domContentLoadedTimeoutMs: 15_000,
    contentWaitTimeoutMs: 10_000,
    screenshotTimeoutMs: 10_000,
  };

  describe('qa-stream Playwright capture', () => {
    it('captures at DOMContentLoaded without waiting for long-lived page requests', async () => {
      const { chromium, state } = mockChromium();
      const result = await captureScreenshotWithPlaywright()(
        chromium,
        '/usr/bin/chromium',
        '/tmp/app.png',
        'http://localhost:8080/',
        captureOptions,
        false,
      );
      expect(result).toEqual({ ok: true, diag: '', fallback: false });
      expect(state.gotoOptions).toEqual({ waitUntil: 'domcontentloaded', timeout: 15_000 });
      expect(state.screenshotCount).toBe(1);
      expect(state.screenshotOptions).toMatchObject({ fullPage: false, timeout: 10_000, animations: 'disabled', caret: 'hide' });
      expect(state.contextOptions).toMatchObject({ ignoreHTTPSErrors: false, viewport: { width: 1280, height: 800 } });
      expect(state.launchOptions?.args).not.toContain('--headless=new');
      expect(state.contentWaitOptions).toMatchObject({ timeout: 10_000, polling: 100 });
      expect(state.browserCloseCalled).toBe(true);
      expect(state.serverCloseCalled).toBe(true);
      expect(state.browserClosed).toBe(true);
      expect(state.serverClosed).toBe(true);
    });

    it('waits for an SPA to render after DOMContentLoaded before capturing', async () => {
      const { chromium, state } = mockChromium({ renderDelayMs: 25 });
      const result = await captureScreenshotWithPlaywright()(
        chromium,
        '/usr/bin/chromium',
        '/tmp/app.png',
        'http://localhost:8080/',
        captureOptions,
        false,
      );
      expect(result).toEqual({ ok: true, diag: '', fallback: false });
      expect(state.contentReady).toBe(true);
      expect(state.screenshotCount).toBe(1);
    });

    it('keeps a committed partial page when DOMContentLoaded is delayed', async () => {
      const { chromium, state } = mockChromium({ navigationError: true });
      const result = await captureScreenshotWithPlaywright()(
        chromium,
        '/usr/bin/chromium',
        '/tmp/app.png',
        'https://localhost:8080/',
        captureOptions,
        true,
      );
      expect(result.ok).toBe(true);
      expect(state.screenshotCount).toBe(1);
      expect(state.contextOptions).toMatchObject({ ignoreHTTPSErrors: true });
    });

    it('falls back to the CLI when navigation never commits', async () => {
      const { chromium, state } = mockChromium({ commit: false, navigationError: true });
      const result = await captureScreenshotWithPlaywright()(
        chromium,
        '/usr/bin/chromium',
        '/tmp/app.png',
        'http://localhost:8080/',
        captureOptions,
        false,
      );
      expect(result).toMatchObject({ ok: false, fallback: true });
      expect(state.screenshotCount).toBe(0);
      expect(state.serverCloseCalled).toBe(true);
      expect(state.browserClosed).toBe(true);
    });

    it('marks an empty page as a screenshot warning and still closes the browser', async () => {
      const { chromium, state } = mockChromium({ visibleContent: false });
      const result = await captureScreenshotWithPlaywright(true)(
        chromium,
        '/usr/bin/chromium',
        '/tmp/app.png',
        'http://localhost:8080/',
        captureOptions,
        false,
      );
      expect(result).toMatchObject({ ok: false, fallback: false, diag: 'screenshot blank after rendered-content wait' });
      expect(state.browserClosed).toBe(true);
    });

    it('falls back to CLI when Playwright cannot capture the page', async () => {
      const { chromium, state } = mockChromium({ screenshotError: true });
      const result = await captureScreenshotWithPlaywright()(
        chromium,
        '/usr/bin/chromium',
        '/tmp/app.png',
        'http://localhost:8080/',
        captureOptions,
        false,
      );
      expect(result).toMatchObject({ ok: false, fallback: true });
      expect(state.browserClosed).toBe(true);
    });

    it('bounds a stuck content wait and kills Chromium when graceful cleanup hangs', async () => {
      const { chromium, state } = mockChromium({ contentPending: true, closePending: true });
      const startedAt = Date.now();
      const result = await captureScreenshotWithPlaywright()(
        chromium,
        '/usr/bin/chromium',
        '/tmp/app.png',
        'http://localhost:8080/',
        {
          ...captureOptions,
          captureTimeoutMs: 40,
          cleanupTimeoutMs: 10,
          contentWaitTimeoutMs: 1000,
        },
        false,
      );
      expect(result).toMatchObject({ ok: false, fallback: true });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(state.browserCloseCalled).toBe(true);
      expect(state.serverCloseCalled).toBe(true);
      expect(state.killSignal).toBe('SIGKILL');
    });
  });
});
