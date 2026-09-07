import { describe, expect, it, vi } from 'vitest';
import { promptUntilValid } from '../lib/cli-wizard';

/** A readline stand-in that answers from a queue, so a retry sequence can be scripted exactly. */
function scriptedRl(answers: string[]) {
  const asked: string[] = [];
  return {
    asked,
    rl: {
      question: async (prompt: string) => {
        asked.push(prompt);
        return answers.shift() ?? '';
      },
    },
  };
}

/** Parses the digits 1-4 the way the wizard's environment menu does. */
const parseDigit = (answer: string) => (['1', '2', '3', '4'].includes(answer) ? Number(answer) : null);

describe('promptUntilValid', () => {
  it('returns the parsed answer without re-asking when the first reply is valid', async () => {
    const { rl, asked } = scriptedRl(['2']);
    await expect(promptUntilValid(rl, '  Environment: ', parseDigit)).resolves.toBe(2);
    expect(asked).toHaveLength(1);
  });

  /**
   * The defect this replaced: a single mistyped digit ran through the exit-on-invalid resolver and
   * ended the guided first-run flow outright. Re-asking is the whole fix, so this is the test that
   * fails if the loop is removed.
   */
  it('re-asks after an unrecognized answer instead of exiting', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { rl, asked } = scriptedRl(['9', 'banana', '3']);

    await expect(promptUntilValid(rl, '  Environment: ', parseDigit)).resolves.toBe(3);

    expect(asked).toHaveLength(3);
    expect(log.mock.calls.flat().join(' ')).toContain('not one of the options');
    log.mockRestore();
  });

  it.each(['q', 'quit', 'exit', 'QUIT'])('treats %s as a clean exit, not a usage error', async (answer) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('exit');
    }) as never);
    const { rl } = scriptedRl([answer]);

    await expect(promptUntilValid(rl, '  Environment: ', parseDigit)).rejects.toThrow('exit');

    // Code 0: abandoning a wizard is a choice. A non-zero code would make `cihub wizard` look
    // failed to any script or shell prompt that inspects $?.
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
    log.mockRestore();
  });

  it('gives up after the attempt bound rather than looping forever', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('exit');
    }) as never);
    // An ended stdin makes rl.question resolve empty forever; without the bound this would spin.
    const { rl, asked } = scriptedRl([]);

    await expect(promptUntilValid(rl, '  Environment: ', parseDigit, 3)).rejects.toThrow('exit');

    expect(asked).toHaveLength(3);
    expect(exit).toHaveBeenCalledWith(2);
    exit.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  it('trims the answer before parsing, matching the menu prompts', async () => {
    const { rl } = scriptedRl(['  4  ']);
    await expect(promptUntilValid(rl, '  Environment: ', parseDigit)).resolves.toBe(4);
  });
});
