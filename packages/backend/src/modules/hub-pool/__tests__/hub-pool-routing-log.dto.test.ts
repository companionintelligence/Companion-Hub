/**
 * `GET routing-log?since=` is a cursor, and a cursor that parses in the Hub's local zone moves by the
 * Hub's UTC offset: hours of rows skipped or re-read with no error anywhere. The controller tests call
 * the handler directly, past the validation pipe, so what the query string may carry is pinned here.
 */
import { describe, expect, it } from 'vitest';
import { MAX_ROUTING_LOG_CAPACITY } from '../hub-pool-routing-log.service';
import { RoutingLogQueryDto } from '../hub-pool.dto';

const parse = (query: Record<string, string>) => RoutingLogQueryDto.schema.safeParse(query);

describe('RoutingLogQueryDto', () => {
  it.each([
    ['the nextSince a previous call returned', '2026-09-17T10:02:11.800Z'],
    ['no milliseconds', '2026-09-17T10:02:11Z'],
    ['an explicit offset', '2026-09-17T12:02:11.800+02:00'],
  ])('accepts %s', (_label, since) => {
    expect(parse({ since })).toMatchObject({ success: true, data: { since } });
  });

  it.each([
    ['a date with no zone, which would parse in whatever zone the Hub runs in', '2026-09-17T10:02:11'],
    ['a human date', 'Sep 17 2026'],
    // What Express hands the handler for `?since=2026-09-17T12:02:11+02:00` sent unencoded: `+` is a space in a query string.
    ['an offset whose + was decoded as a space', '2026-09-17T12:02:11 02:00'],
    ['epoch milliseconds', '1789639331800'],
  ])('refuses %s', (_label, since) => {
    expect(parse({ since }).success).toBe(false);
  });

  it('bounds limit by the largest ring HUB_POOL_ROUTING_LOG_SIZE can configure, not by the default one', () => {
    expect(parse({ limit: String(MAX_ROUTING_LOG_CAPACITY) })).toMatchObject({ success: true, data: { limit: MAX_ROUTING_LOG_CAPACITY } });
    expect(parse({ limit: String(MAX_ROUTING_LOG_CAPACITY + 1) }).success).toBe(false);
    expect(parse({ limit: '0' }).success).toBe(false);
  });
});
