/**
 * Arguments applied to every hub work queue at ALL declaration sites — the
 * consumer (queue.entity.ts) and the RPC clients (queue.factory.ts). They MUST
 * be byte-identical everywhere or RabbitMQ's queue-equivalence check rejects the
 * redeclaration with PRECONDITION_FAILED, so they are defined here once.
 *
 * Why: without a bound, a stuck or slow consumer lets a queue grow until it
 * trips RabbitMQ's disk-free alarm, which blocks ALL publishers connection-wide
 * and hangs the app. With a bounded queue plus `reject-publish` overflow, the
 * queue cannot fill the disk and over-capacity publishes fail fast instead —
 * Queue.publish turns the rejection into a `{ success: false }` result for the
 * caller (see queue.entity.ts) rather than blocking.
 *
 * No message TTL is set on purpose: app-events RPCs can legitimately wait tens
 * of minutes behind slow image pulls, and a TTL would silently expire that real
 * work. The length/byte caps alone bound disk usage.
 *
 * NOTE: queue arguments are immutable once a queue exists; changing them
 * requires the ci-hub-queue broker to be recreated. That container has no
 * volume, so any Compose recreate (e.g. when its service definition changes)
 * brings the queues up fresh with the current arguments.
 */
export const HUB_QUEUE_ARGUMENTS: Record<string, number | string> = {
  // Hard cap on ready messages per queue.
  'x-max-length': 10_000,
  // Hard cap on total queued bytes per queue (128 MiB) — bounds disk directly.
  'x-max-length-bytes': 134_217_728,
  // When either cap is reached, reject new publishes (publisher gets a clear
  // failure) instead of dropping messages or letting the queue grow.
  'x-overflow': 'reject-publish',
};
