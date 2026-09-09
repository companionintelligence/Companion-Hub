# Telemetry

> What Companion Hub reports, to whom, and how to stop it.

Hub can report crashes to [Sentry](https://sentry.io). Nothing else leaves the
appliance: there is no product analytics, no usage metering, and no PostHog or
Amplitude. The `cihub` CLI reports nothing at all.

**It is on by default in distributed builds.** The DSN is compiled into the
published image and the desktop bundle, so a self-hosted Hub reports crashes
until an operator turns it off. That is a deliberate trade — a crash nobody sees
is a crash nobody fixes — but it is your machine, and the switches below are the
whole story.

## Turning it off

Highest precedence first. Every one is checked **at the point of sending**, not
merely in the UI, and is re-read per event so a change takes effect immediately
without a restart.

| Switch | Where | Effect |
| --- | --- | --- |
| `CI_LOCAL_ONLY=true` | hub `.env` | Nothing leaves this machine, for any reason |
| `CI_TELEMETRY=off` | hub `.env` | No error reporting; other local features unaffected |
| **Allow anonymous error monitoring** | Settings → General | The in-product switch (`allowErrorMonitoring` in `state/settings.json`) |
| no DSN configured | build | Nothing to send to |

The env vars override the UI switch, so a box owner's decision cannot be undone
from the dashboard. If you are unsure what is in force, the Hub answers
`GET /api/config/telemetry` with `{ enabled, reason }` — unauthenticated, and it
never returns a DSN.

**Consent fails closed.** Until the frontend has a definitive answer, and after
any failed check, events are dropped. Unknown is never treated as permission.

## What is collected when it is on

| Reported | Not reported |
| --- | --- |
| Exception type, message, stack trace | Cookies and request bodies |
| Device id, organization id, device slug | Identity headers, session tokens |
| Portal URL, Hub image tag, release | The server hostname (`includeServerName: false`) |
| Browser errors and performance traces | The client IP (`sendDefaultPii: false`) |
| On app failure: the app's URN and container logs | Your apps' data |

Container logs are the sharpest edge here: they are scrubbed for known secret
shapes, but a log line that prints a bare credential in an unrecognised format
can survive that. If your apps log secrets, turn error reporting off.

### Session Replay

The frontend can record masked session replays (all text masked, all media
blocked). **It is only started once you have granted consent**, and stopping
consent stops the recorder mid-session.

This is enforced by starting and stopping the recorder rather than by filtering
events, because replay data does not pass through the hook that filters error
events — a detail worth stating because getting it wrong is invisible from the
outside. See `syncSessionReplayWithConsent` in
`packages/frontend/src/lib/sentry.ts`, and the tests in
`packages/frontend/src/lib/session-replay-consent.test.ts`.

## Local-only telemetry

`HostTelemetryService` samples CPU, memory and disk every few seconds and keeps
48 hours of history in the Hub's own SQLite database, to draw the dashboard's
graphs. It has no network egress and is not gated by the switches above, because
there is nothing to consent to — the data never leaves.

It does include the host machine's Docker `Name`. That matters in one place:
`GET /api/system/logs/download` bundles it, so check a support bundle before
attaching it to a public issue.

## For developers

- Consent logic: `packages/backend/src/core/error-reporting/telemetry-consent.ts`
- Backend init and per-event gate: `packages/backend/src/instrument.ts`
- Frontend gate: `packages/frontend/src/lib/telemetry-consent.ts`
- Scrubbing: `sentry-scrubber.pipeline.test.ts` asserts no cookie, body,
  identity header or hostname reaches the transport.

If you add a capture site, call it through `ErrorReportingService` rather than
the SDK directly — that is where `isEnabled()` is checked.
