import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { holdsMarketplaceRuleCopies, marketplaceRuleDifferences } from './marketplace-rules-parity.js';

/*
 * CI-Marketplace checks listings with copies of the rules below it in this package (see
 * marketplace-rules-parity.ts). Changing one of the Hub's rules without changing the copy lets the
 * marketplace ship listings every Hub then refuses at install, so a change here fails this test
 * until the marketplace's copy follows.
 *
 * The marketplace checkout is CI_MARKETPLACE_DIR, else `ci-marketplace` beside this repo. Without
 * one the test is skipped, unless CI_REQUIRE_MARKETPLACE=1 (ci.yml clones the marketplace's dev
 * branch and sets it). The marketplace runs the same comparison from its side before a catalog
 * deploy (its __tests__/hub-rules-parity.test.ts).
 */
const marketplaceDir = process.env.CI_MARKETPLACE_DIR ?? path.resolve(import.meta.dirname, '../../../../../../ci-marketplace');
const present = holdsMarketplaceRuleCopies(marketplaceDir);
const required = process.env.CI_REQUIRE_MARKETPLACE === '1';

describe("CI-Marketplace's copy of the Hub's listing rules", () => {
  it.runIf(required && !present)('needs a CI-Marketplace checkout with the copies', () => {
    expect.fail(`No CI-Marketplace checkout with ${'scripts/lib/hub-*-rules.ts'} at ${marketplaceDir}; set CI_MARKETPLACE_DIR.`);
  });

  it.runIf(present)('decides every catalog listing and edge case the way the Hub does', async () => {
    const differences = await marketplaceRuleDifferences(marketplaceDir);
    expect(differences, `Compared with ${marketplaceDir}. Update its scripts/lib/hub-*-rules.ts to match the Hub.`).toEqual([]);
  });
});
