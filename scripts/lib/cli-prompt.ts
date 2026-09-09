/**
 * Interactive confirmation for commands that destroy or expose state.
 *
 * Every prompt in the CLI goes through here so the non-TTY refusal is worded and gated the same
 * way everywhere: a script that cannot answer must fail loudly rather than hang on a read.
 */
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { colorize, STEP_ICONS } from './cli-ui.js';

/**
 * Non-interactive consent, for callers that genuinely have no terminal.
 *
 * `cihub fleet` drives every one of these commands over `ssh -n`, which has no TTY by construction,
 * so without an env-level opt-in a fleet operation cannot approve a pairing, enable a pool, or pin a
 * model — it exits 2 before doing anything. Deliberately an environment variable rather than a
 * silent non-TTY exemption: "there is no terminal" must never by itself mean "yes".
 */
export function assumeYesFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CI_HUB_ASSUME_YES ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function confirmDestructive(actionLabel: string, force: boolean, noun = 'destructive') {
  if (force || assumeYesFromEnv()) return true;
  if (!process.stdin.isTTY) {
    console.error(
      colorize(`  ${STEP_ICONS.fail} ${actionLabel} is ${noun} \u2014 requires an interactive terminal, --yes, or CI_HUB_ASSUME_YES=1`, 'red'),
    );
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
