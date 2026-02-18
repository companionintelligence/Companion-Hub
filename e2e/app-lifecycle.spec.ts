// Skipped: Requires Docker-in-Docker (Tier 2 local testing only)
// These tests install real apps which need the Docker daemon and registry access.
// Run locally with: docker compose -f e2e/docker-compose.e2e.yml up

import { test } from './fixtures/fixtures';

test.skip('app install lifecycle — requires Docker-in-Docker', () => {
  // See e2e/future/ for full lifecycle tests
});

test.skip('app uninstall lifecycle — requires Docker-in-Docker', () => {
  // See e2e/future/ for full lifecycle tests
});
