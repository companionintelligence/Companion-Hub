/**
 * Interactive confirmation for commands that destroy or expose state.
 *
 * Every prompt in the CLI goes through here so the non-TTY refusal is worded and gated the same
 * way everywhere: a script that cannot answer must fail loudly rather than hang on a read.
 */
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { colorize, STEP_ICONS } from './cli-ui.js';

export function confirmDestructive(actionLabel: string, force: boolean, noun = 'destructive') {
  if (force) return true;
  if (!process.stdin.isTTY) {
    console.error(colorize(`  ${STEP_ICONS.fail} ${actionLabel} is ${noun} \u2014 requires an interactive terminal or --yes`, 'red'));
    process.exit(2);
  }
  return false;
}

/**
 * `noun` only changes the wording of the non-TTY refusal \u2014 the gate itself is identical. `cihub pool
 * enable` is reversible, so calling it "destructive" would train operators to ignore the word where
 * it does mean data loss.
 */
export async function confirmDestructiveAction(actionLabel: string, force: boolean, prompt: string, noun?: string) {
  if (confirmDestructive(actionLabel, force, noun)) return true;
  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question(prompt)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}
