import { beforeEach, describe, expect, it, vi } from 'vitest';

import { syncSessionReplayWithConsent } from './sentry';

/**
 * Session Replay is the one telemetry path `beforeSend` cannot gate: replay
 * envelopes never reach that hook, which filters error events only. Registering
 * the integration at init therefore recorded and uploaded sessions no matter what
 * the "Allow error monitoring" switch said — 10% of all sessions and 100% of
 * error sessions. These tests exist so that cannot come back.
 */

const replay = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };

const client = {
  integrations: new Map<string, unknown>(),
  getIntegrationByName(name: string) {
    return this.integrations.get(name);
  },
  addIntegration: vi.fn(() => {
    client.integrations.set('Replay', replay);
  }),
};

vi.mock('@sentry/react', () => ({
  getClient: () => client,
  replayIntegration: () => replay,
  init: vi.fn(),
  browserTracingIntegration: vi.fn(),
  setUser: vi.fn(),
  setTag: vi.fn(),
}));

beforeEach(() => {
  client.integrations.clear();
  vi.clearAllMocks();
});

describe('syncSessionReplayWithConsent', () => {
  it('does not record until consent is granted', () => {
    syncSessionReplayWithConsent(null);

    expect(client.addIntegration).not.toHaveBeenCalled();
  });

  it('treats a withheld answer as no', () => {
    syncSessionReplayWithConsent(false);

    expect(client.addIntegration).not.toHaveBeenCalled();
  });

  it('adds the recorder once consent is granted', () => {
    syncSessionReplayWithConsent(true);

    expect(client.addIntegration).toHaveBeenCalledTimes(1);
  });

  it('does not add a second recorder when consent is re-confirmed', () => {
    syncSessionReplayWithConsent(true);
    syncSessionReplayWithConsent(true);

    expect(client.addIntegration).toHaveBeenCalledTimes(1);
  });

  it('STOPS recording when consent is withdrawn mid-session', () => {
    syncSessionReplayWithConsent(true);
    syncSessionReplayWithConsent(false);

    // The property the whole fix exists for: a flip takes effect without a
    // reload, matching how beforeSend already behaves for errors.
    expect(replay.stop).toHaveBeenCalledTimes(1);
  });

  it('stops recording when the answer becomes unknown again', () => {
    syncSessionReplayWithConsent(true);
    syncSessionReplayWithConsent(null);

    expect(replay.stop).toHaveBeenCalledTimes(1);
  });
});
