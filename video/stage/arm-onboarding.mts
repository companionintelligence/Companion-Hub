/**
 * Capture pass 2 — re-arm the first-boot wizard.
 *
 *   pnpm exec tsx video/stage/arm-onboarding.mts        # then capture --only onboarding-wizard
 *   RESTORE=1 pnpm exec tsx video/stage/arm-onboarding.mts   # put the Hub back afterwards
 *
 * `onboarding-page.tsx` skips the wizard whenever the operator's
 * `hasCompletedOnboarding` is true, so the shot needs it flipped off. Flip it back
 * before any later pass: an un-onboarded operator changes what /home and /login do.
 */

const { setWelcomeSeen } = await import('../../e2e/helpers/settings');

const seen = process.env.RESTORE === '1';
await setWelcomeSeen(seen);
// biome-ignore lint/suspicious/noConsole: capture-stage script progress output
console.log(`hasCompletedOnboarding = ${seen}`);
process.exit(0);
