/**
 * End-to-end check against the real @sentry/node client, not the scrubber in
 * isolation.
 *
 * The leak this guards against was invisible to unit tests: `include.cookies`
 * defaults to `dataCollection.cookies !== false` and is NOT gated on
 * `sendDefaultPii`, so the SDK attaches `request.cookies`, `request.data` and
 * the raw `cookie` header to every event regardless of that flag. Only a probe
 * that drives the actual client shows what leaves the process — and it also
 * catches an SDK upgrade that starts attaching a field we do not scrub.
 */

import * as Sentry from '@sentry/node';
import { describe, expect, it } from 'vitest';
import { scrubEvent } from './sentry-scrubber';

type CapturedEnvelope = [unknown, [[unknown, Record<string, unknown>]]];

describe('scrubEvent in the live client pipeline', () => {
  it('ships no cookie, body, identity header or hostname to the transport', async () => {
    const sent: CapturedEnvelope[] = [];

    const client = new Sentry.NodeClient({
      dsn: 'https://abc@o1.ingest.sentry.io/1',
      // Worst case on purpose: even with PII enabled nothing may escape.
      sendDefaultPii: true,
      stackParser: Sentry.defaultStackParser,
      // The integration that turns `normalizedRequest` into `event.request`.
      integrations: [Sentry.requestDataIntegration()],
      beforeSend: scrubEvent,
      transport: () => ({
        send: async (envelope) => {
          sent.push(envelope as unknown as CapturedEnvelope);
          return {};
        },
        flush: async () => true,
      }),
    });
    // Registers the integrations' event processors; `Sentry.init` does this for us.
    client.init();

    const scope = new Sentry.Scope();
    scope.setClient(client);
    scope.setSDKProcessingMetadata({
      normalizedRequest: {
        url: 'https://hub.ci.localhost/api/auth/login?redirect_url=/settings',
        method: 'POST',
        query_string: 'redirect_url=/settings',
        headers: {
          cookie: 'ci-hub-session=eyJhbGciOiJIUzI1NiJ9.SESSIONVALUE.sig',
          authorization: 'Bearer SECRETBEARER',
          'x-ci-hub-user': 'bennett',
          referer: 'https://hub.ci.localhost/login?email=liam%40example.com',
          'user-agent': 'curl/8',
        },
        cookies: { 'ci-hub-session': 'eyJhbGciOiJIUzI1NiJ9.SESSIONVALUE.sig' },
        data: { email: 'liam@example.com', password: 'CLEARTEXTPASSWORD' },
      },
    });

    scope.captureException(new Error('login failed'));
    await client.flush(2000);

    expect(sent).toHaveLength(1);

    const [envelope] = sent;
    const event = envelope?.[1][0][1];
    const request = event?.request as Record<string, unknown> | undefined;

    // Guard against a vacuous pass: with the request section missing (e.g. the
    // integration stopped populating it) every `not.toContain` below is free.
    expect(request).toBeDefined();
    expect((request?.headers as Record<string, string>)['user-agent']).toBe('curl/8');

    const payload = JSON.stringify(sent);
    for (const secret of ['SESSIONVALUE', 'SECRETBEARER', 'CLEARTEXTPASSWORD', 'liam@example.com', 'bennett', 'redirect_url']) {
      expect(payload).not.toContain(secret);
    }

    expect(request?.cookies).toBeUndefined();
    expect(request?.data).toBeUndefined();
    expect(request?.query_string).toBe('[Filtered]');
    expect(request?.url).toBe('https://hub.ci.localhost/api/auth/login');
    expect(event?.server_name).toBeUndefined();
  });
});
