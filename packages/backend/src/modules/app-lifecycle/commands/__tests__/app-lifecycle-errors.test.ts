import { describe, expect, it } from 'vitest';
import {
  NETWORK_OVERLAP_CODE,
  NETWORK_OVERLAP_USER_MESSAGE,
  createNetworkOverlapError,
  translateDockerNetworkOverlapError,
} from '../app-lifecycle-errors';

describe('app-lifecycle-errors network overlap', () => {
  it('creates a structured network overlap error', () => {
    const error = createNetworkOverlapError(['10.128.10.0/24']);

    expect(error.errorCode).toBe(NETWORK_OVERLAP_CODE);
    expect(error.message).toBe(NETWORK_OVERLAP_USER_MESSAGE);
    expect(error.errorDetail).toContain('10.128.10.0/24');
  });

  it('translates Docker overlap daemon errors', () => {
    const translated = translateDockerNetworkOverlapError(new Error('networks have overlapping IPv4 for 10.128.10.0/24'));

    expect(translated?.errorCode).toBe(NETWORK_OVERLAP_CODE);
    expect(translated?.errorDetail).toContain('10.128.10.0/24');
  });
});
