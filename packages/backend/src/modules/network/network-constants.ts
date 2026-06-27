/** First Hub-allocated app /24 (10.128.10.0/24). 10.128.0.0–10.128.9.0 are reserved for hub infrastructure. */
export const HUB_APP_ALLOCATION_START_CIDR = '10.128.10.0/24';

/** Last Hub-allocated app /24 (10.254.254.0/24). */
export const HUB_APP_ALLOCATION_END_CIDR = '10.254.254.0/24';

/**
 * Superset CIDR for diagnostics: detects foreign Docker networks that collide with Hub's
 * 10.128+ address space (10.128.0.0–10.255.255.255). Wider than the /24 slots Hub actually
 * allocates between {@link HUB_APP_ALLOCATION_START_CIDR} and {@link HUB_APP_ALLOCATION_END_CIDR}.
 */
export const HUB_APP_POOL_CIDR = '10.128.0.0/9';
