import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usageAndExit } from '../lib/cli-args.js';
import { renderHelp, STEP_ICONS, stripAnsi } from '../lib/cli-ui.js';

/**
 * `usageAndExit` fires from ~20 call sites, so what it prints is the CLI's whole error experience.
 * The contract pinned here is a readability one: the message has to survive on a short terminal.
 * Asserting only "mentions --help" would still pass if the full reference came back underneath it,
 * so both the line budget and the message's position in the stream are asserted explicitly.
 */
const SHORT_TERMINAL_ROWS = 24;

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

/** Split on newlines too: one console.error call can still carry many rendered rows. */
const stderrLines = () => (errorSpy.mock.calls as unknown[][]).flatMap((call) => stripAnsi(String(call[0])).split('\n'));

beforeEach(() => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe('usageAndExit', () => {
  it('leaves the error itself as the last thing on screen', () => {
    expect(() => usageAndExit('Unknown flag: --lmit')).toThrow('exit');

    const lines = stderrLines();
    expect(lines[lines.length - 1]).toContain(`${STEP_ICONS.fail} Unknown flag: --lmit`);
  });

  it('fits a short terminal instead of reprinting the full reference', () => {
    expect(() => usageAndExit('Unknown command: frobnicate')).toThrow('exit');

    expect(stderrLines().length).toBeLessThan(SHORT_TERMINAL_ROWS);
    // Guards the assertion above: it only means anything while the full help is genuinely long.
    expect(renderHelp().split('\n').length).toBeGreaterThan(SHORT_TERMINAL_ROWS);
  });

  it('points at the help commands the dispatcher accepts', () => {
    expect(() => usageAndExit('Unexpected argument: --')).toThrow('exit');

    const text = stderrLines().join('\n');
    expect(text).toContain('cihub --help');
    expect(text).toContain('cihub man');
  });

  it('still prints the hint when no message is supplied', () => {
    expect(() => usageAndExit()).toThrow('exit');

    const lines = stderrLines();
    expect(lines.length).toBeLessThan(SHORT_TERMINAL_ROWS);
    expect(lines.join('\n')).toContain('cihub --help');
  });

  it('defaults to exit code 2 and honours an explicit code', () => {
    expect(() => usageAndExit('bad usage')).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(2);

    exitSpy.mockClear();
    expect(() => usageAndExit('bad usage', 1)).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes only to stderr so a piped stdout stays clean', () => {
    expect(() => usageAndExit('bad usage')).toThrow('exit');

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});
