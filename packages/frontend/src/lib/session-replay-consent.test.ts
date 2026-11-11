import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  // A restart rolls the session sample rate, so the restart cases below use a rate that always records.
  vi.stubEnv('VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Lets queued microtasks, such as a restart waiting on a stop, run to completion. */
const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

  it('stops without flushing, so the unsent segment is not uploaded after the switch is off', () => {
    syncSessionReplayWithConsent(true);
    syncSessionReplayWithConsent(false);

    // Sessions stop with a flush by default; `flush: false` drops the pending segment instead.
    expect(replay.stop).toHaveBeenCalledWith({ flush: false });
  });

  it('restarts the recorder when consent is granted again after a withdrawal', async () => {
    syncSessionReplayWithConsent(true);
    syncSessionReplayWithConsent(false);
    syncSessionReplayWithConsent(true);

    // The grant after a stop is a restart, not a second recorder.
    await vi.waitFor(() => expect(replay.start).toHaveBeenCalledTimes(1));
    expect(client.addIntegration).toHaveBeenCalledTimes(1);
  });

  it('waits for a stop that is still in flight before restarting', async () => {
    let finishStop = () => {};
    replay.stop.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        finishStop = () => resolve(undefined);
      }),
    );

    syncSessionReplayWithConsent(true);
    syncSessionReplayWithConsent(false);
    syncSessionReplayWithConsent(true);
    await flushPromises();

    // Starting while the old session is still being torn down would let its teardown clear the new one.
    expect(replay.start).not.toHaveBeenCalled();

    finishStop();
    await vi.waitFor(() => expect(replay.start).toHaveBeenCalledTimes(1));
  });

  it('never starts the recorder twice in a row', async () => {
    syncSessionReplayWithConsent(true);
    syncSessionReplayWithConsent(false);
    syncSessionReplayWithConsent(true);
    syncSessionReplayWithConsent(true);
    await flushPromises();

    expect(replay.start).toHaveBeenCalledTimes(1);
  });

  it('does not restart a recorder whose session sample rate is zero', async () => {
    // The published image builds with an empty rate, which Number() reads as 0, so replay stays off.
    vi.stubEnv('VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE', '');

    syncSessionReplayWithConsent(true);
    syncSessionReplayWithConsent(false);
    syncSessionReplayWithConsent(true);
    await flushPromises();

    expect(replay.start).not.toHaveBeenCalled();
  });

  it('rolls the session sample rate before restarting, because start() ignores it', async () => {
    vi.stubEnv('VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE', '0.1');
    const random = vi.spyOn(Math, 'random');

    try {
      random.mockReturnValue(0.5);
      syncSessionReplayWithConsent(true);
      syncSessionReplayWithConsent(false);
      syncSessionReplayWithConsent(true);
      await flushPromises();
      expect(replay.start).not.toHaveBeenCalled();

      random.mockReturnValue(0.05);
      syncSessionReplayWithConsent(false);
      syncSessionReplayWithConsent(true);
      await vi.waitFor(() => expect(replay.start).toHaveBeenCalledTimes(1));
    } finally {
      random.mockRestore();
    }
  });

  it('drops a queued restart when consent is withdrawn again before it runs', async () => {
    let finishStop = () => {};
    replay.stop.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        finishStop = () => resolve(undefined);
      }),
    );

    syncSessionReplayWithConsent(true);
    syncSessionReplayWithConsent(false);
    syncSessionReplayWithConsent(true);
    syncSessionReplayWithConsent(false);
    finishStop();
    await flushPromises();

    expect(replay.start).not.toHaveBeenCalled();
  });
});
