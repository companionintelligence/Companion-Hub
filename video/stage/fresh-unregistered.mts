/**
 * Capture pass 3 — put the Hub back to "never paired" for the
 * `device-registration` shot. MUST RUN LAST: it clears the database, which
 * destroys the operator every other shot signs in as.
 *
 *   curl -X POST localhost:9193/___control -d '{"scenario":"unregistered"}'
 *   pnpm exec tsx video/stage/fresh-unregistered.mts
 *   cd video && npm run capture -- --only device-registration
 *
 * Do not reach for `POST /api/registration/prepare-fresh` instead; it refuses
 * while the Hub is operational.
 */

const { freshUnregistered } = await import('../../e2e/fixtures/hub-states');

await freshUnregistered();
// biome-ignore lint/suspicious/noConsole: capture-stage script progress output
console.log('hub reset to fresh/unregistered — re-run video/stage/seed.mts before any other pass');
process.exit(0);
