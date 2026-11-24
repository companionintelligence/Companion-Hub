# Telemetry

> What Companion Hub reports, to whom, and how to stop it.

Companion Hub can report errors, performance traces, session replays and
release-health sessions to [Sentry](https://sentry.io). Nothing else goes to
Sentry. The Hub ships no analytics or usage-metering SDK, and the `cihub` CLI
has no telemetry code. The Hub also calls the CI cloud Portal for the app
catalog, pairing and entitlements. That traffic is separate from Sentry, and
the switches below do not stop it.

**Reporting is off until you turn it on.** The frontend DSN is compiled into the
web bundle of the published image, but the Hub sends nothing until you turn on
**Allow anonymous error monitoring** in Settings → General. A fresh appliance
has made no choice, so it reports nothing.

`ALLOW_ERROR_MONITORING=true` shows the switch on until you save a choice. The
web app then reports, because the Hub's answer to it uses that value. The
backend and the desktop shell report only from a saved choice, so until you save
one they report nothing. Saving any setting on the Settings form also saves the
value the switch shows, so the first save turns a seeded `true` into a saved
choice.

## Turning it off

| Switch | Where | Effect |
| --- | --- | --- |
| `CI_LOCAL_ONLY=true` | Hub `.env` | Stops all Sentry reporting. It does not stop Portal API calls. |
| `CI_TELEMETRY=off` | Hub `.env` | Stops all Sentry reporting, including for a DSN in the image. |
| **Allow anonymous error monitoring** | Settings → General | Stops or starts all Sentry reporting. Saved as `allowErrorMonitoring` in `state/settings.json`. |
| No DSN | Build | Nothing to send to. |

Sentry reporting means error reports, browser and backend traces, session
replays and release-health sessions.

The environment switches win over the in-app switch, so a box owner's decision
cannot be undone from the dashboard. Each switch takes effect as follows:

- The environment switches are read when the Hub starts. Restart the Hub after
  you change them.
- The in-app switch needs no restart. The backend re-reads it at most once a
  second. In the tab where you save, the web app applies the change when the
  save completes. Other open tabs apply it within about a minute, when they next
  ask the Hub. The web app also asks about every minute and before it reports an
  error.
- When the answer is off, the web app's transport refuses every envelope, and
  replay recording stops. Envelopes that reach the transport afterwards are
  dropped. Data that already reached Sentry stays there.

**Consent fails closed.** Until the web app has a definitive answer, and after
any failed check, it sends nothing. To see the current answer, call
`GET /api/config/telemetry`. It returns `{ enabled, reason }`, needs no login,
and never returns a DSN.

## What is reported when it is on

| Reported | Notes |
| --- | --- |
| Exception type, message and stack trace | Error reports are not sampled. |
| Device ID | Set as the Sentry user and as the `device_id` tag. |
| Portal URL, portal environment, release and Hub image tag | Tags on every event. |
| Browser errors and browser traces | Web app. Traces are sampled. See [Sampling](#sampling-in-the-published-image). |
| Backend errors and backend traces | Backend. Traces are sampled. |
| Release-health session events | Web app and backend. |
| For a failed API call: the HTTP status, the request path and the start of the response body | Web app. The body is cut to 300 characters and scrubbed. Client (4xx) errors are not reported. |
| App failures: the app URN, failure phase, error class and message | Only for app failures. |
| App failures: the cause, when known | Up to 1,024 characters, scrubbed. |
| App failures: the organization ID and device slug | Tags. Only for app failures. |
| App failures: a host health snapshot | CPU count, load averages, memory totals, Hub process memory and uptime, and event-loop delay. |
| Port conflicts | The conflicting host port, and a remedy that says what to change on the device. |
| App crashes, failed installs and crash loops | The names and states of the app's containers. |
| Session replays, after consent | Web app only. Text is masked and media is blocked. |

Not reported:

- Cookies, request bodies and identity headers. The SDK does not collect them,
  and the scrubber removes any that arrive.
- The server hostname. `includeServerName: false` keeps it out.
- The client IP address. The SDK's `userInfo` option is off, and the scrubber
  drops any `ip_address` that arrives.
- Your apps' data. Container logs are not attached to a report as a field. An
  error message that quotes container output is sent after the scrubber removes
  secrets, home paths and other matched patterns.
- Query strings and fragments in URLs. The scrubber removes them from request
  URLs, breadcrumbs and span attributes.
- Sentry logs and metrics. The Hub does not call those APIs.

## Sampling in the published image

The web app reads its sample rates at build time. The published image does not
get them from the build workflow, so it sends fewer traces and no replays:

- `.github/workflows/build-container.yml` passes no sample-rate arguments. It
  passes only the frontend DSN and release (lines 245 and 246).
- The Dockerfile sets the sample-rate arguments to empty strings (lines 53 to
  55). `Number('')` is 0.

So the published image sends no browser traces, no session replays and no
replays on error.

A local build through `docker-compose.prod.yml` (lines 110 to 112) uses 0.1 for
browser traces, 0.1 for session replays and 1 for replays on error.

The backend reads `SENTRY_TRACES_SAMPLE_RATE`, which defaults to 0.1. The
published image does not set it, so backend traces are sampled at 0.1 unless
your `.env` sets it.

## Session Replay

The web app records masked session replays. Text is hidden, and images and
media are blocked. The recorder does not start until you grant consent, and it
stops as soon as you withdraw it.

Granting consent again can start a new recording. The SDK's restart ignores the
sample rate, so the Hub draws against the session sample rate each time it
restarts. At a rate of 0.1, most restarts record nothing. The recording stops
without sending its unsent part, so no more replay data leaves the browser after
you switch the setting off. Replays that Sentry already received stay there.

See `syncSessionReplayWithConsent` in `packages/frontend/src/lib/sentry.ts`,
and the tests in `packages/frontend/src/lib/session-replay-consent.test.ts`.

## Local-only telemetry

The host telemetry service samples CPU, memory and disk every 5 seconds. It
keeps 48 hours of samples in the Hub's PostgreSQL database, to draw the
dashboard's graphs. Nothing in it goes to Sentry. The switches above do not
affect it, because the data stays on the appliance.

Each sample also stores the Docker daemon's `Name` from `docker info`, which is
usually the host machine's name. It stores app names and container counts too.

`GET /api/system/logs/download` streams `docker compose logs` for the Hub
container. It does not include the host telemetry samples. The download holds
whatever the Hub printed, so check it before you attach it to a public issue.

## For developers

- Consent decision, used by both sides:
  `packages/backend/src/core/error-reporting/telemetry-consent.ts`.
- Backend init, error gate and transport gate: `packages/backend/src/instrument.ts`.
- Web app init, transport gate, replay gate and consent timer:
  `packages/frontend/src/lib/sentry.ts`. Cached answer:
  `packages/frontend/src/lib/telemetry-consent.ts`.
- Scrubbing: `packages/frontend/src/lib/sentry-scrubber.ts` and
  `packages/backend/src/core/error-reporting/sentry-scrubber.ts`.
  `sentry-scrubber.pipeline.test.ts` asserts that no cookie, body, identity
  header or hostname reaches the transport.

The gates sit where they do because of how the SDK sends data:

- The SDK sends traces as span envelopes by default (`traceLifecycle: 'stream'`).
  In that mode `beforeSendTransaction` is never called, and `beforeSendSpan`
  cannot drop a span. So the transport gates traces and release-health
  sessions.
- Replay envelopes skip `beforeSend` as well, so the recorder is started and
  stopped instead.

On the backend, call capture sites through `ErrorReportingService` rather than
the SDK directly. That is where `isEnabled()` is checked. In the web app, use
`captureHubException` or `captureHubWarning`.
