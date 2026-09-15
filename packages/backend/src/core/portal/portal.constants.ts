export const CI_MARKETPLACE_STORE_SLUG = 'ci-marketplace';

/**
 * Ceiling for fetching Portal's full `/store` listing, for the in-memory catalog and the CI Marketplace
 * sync alike. Portal builds that listing on demand and has taken 16–37s, so the 30s and 15s client
 * defaults failed every time and neither copy of the catalog refreshed.
 */
export const PORTAL_STORE_LISTING_TIMEOUT_MS = 45_000;
