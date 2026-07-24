import { describe, expect, it } from 'vitest';
import { buildWakeText, DEFAULT_MIN_URGENCY, isUrgency, passesUrgency, type Urgency } from '../wake-text';

/**
 * Every event the Hub actually emits, with the urgency and data its producer sends.
 *
 * Kept exhaustive on purpose: the golden test below runs over ALL of them, so a new event
 * added without thinking about the wake text fails here rather than silently vanishing on
 * the appliance.
 */
const HUB_EVENTS: Array<[string, Record<string, unknown>, Urgency]> = [
  ['app.crashed', { appUrn: 'immich:ci-store', previousStatus: 'running', newStatus: 'stopped' }, 'high'],
  ['install_error', { appUrn: 'immich:ci-store' }, 'high'],
  ['start_error', { appUrn: 'immich:ci-store' }, 'high'],
  ['stop_error', { appUrn: 'immich:ci-store' }, 'high'],
  ['restart_error', { appUrn: 'immich:ci-store' }, 'high'],
  ['uninstall_error', { appUrn: 'immich:ci-store' }, 'high'],
  ['reset_error', { appUrn: 'immich:ci-store' }, 'high'],
  ['update_error', { appUrn: 'immich:ci-store' }, 'high'],
  ['backup_error', { appUrn: 'immich:ci-store' }, 'high'],
  ['restore_error', { appUrn: 'immich:ci-store' }, 'high'],
  ['update_success', { appUrn: 'immich:ci-store' }, 'info'],
  ['system.update_available', { current: '1.2.0', latest: '1.3.0' }, 'low'],
  ['system.mcp_ready', { toolCount: 12 }, 'info'],
  ['registration.state_changed', { from: 'active', to: 'degraded', reasons: ['tunnel down'] }, 'high'],
  ['system.high_disk', { usagePercent: 94, availableGb: 3 }, 'high'],
  ['system.high_memory', { usagePercent: 92, availableMb: 512 }, 'medium'],
  ['system.health_check_failed', { error: 'timeout' }, 'low'],
];

describe('buildWakeText', () => {
  /**
   * The one that matters.
   *
   * OpenClaw's `compactSystemEvent` SILENTLY DROPS a system event whose text trips any of
   * these rules. A dropped event is indistinguishable from a wake that never fired: the
   * hook returns 200, the heartbeat runs, and the agent simply never sees the alert. This
   * is the failure mode most likely to survive review and reach production unnoticed, so
   * it is pinned across every event rather than spot-checked.
   */
  it.each(HUB_EVENTS)('%s: survives compactSystemEvent (is not silently dropped)', (event, data, urgency) => {
    const text = buildWakeText(event, data, urgency);
    const lower = text.toLowerCase();

    expect(lower).not.toContain('heartbeat poll');
    expect(lower).not.toContain('heartbeat wake');
    expect(lower).not.toContain('reason periodic');
    expect(lower.startsWith('read heartbeat.md')).toBe(false);
    // A leading `System:` is also rewritten to `System (untrusted):` by the tag sanitiser.
    expect(lower.startsWith('system:')).toBe(false);
    expect(/^exec finished(:|\s*\()/i.test(text)).toBe(false);
  });

  it.each(HUB_EVENTS)('%s: names the event and stays within the context budget', (event, data, urgency) => {
    const text = buildWakeText(event, data, urgency);

    expect(text).toContain(event);
    expect(text).toContain(urgency);
    expect(text.length).toBeGreaterThan(20);
    expect(text.length).toBeLessThanOrEqual(800);
  });

  // The text is the agent's only instruction: the heartbeat prompt itself just says
  // "reply HEARTBEAT_OK if nothing needs attention". Without an explicit ask, the agent
  // will shrug at a crashed app.
  it('tells the agent to investigate and speak on a crash', () => {
    const text = buildWakeText('app.crashed', { appUrn: 'immich:ci-store' }, 'high');
    expect(text).toMatch(/investigate/i);
    expect(text).toMatch(/tell the user/i);
    expect(text).toContain('immich:ci-store');
  });

  // REGRESSION: an AppUrn is `${appName}:${appStoreSlug}` (createAppUrn), so the app's NAME is
  // the head of the pair. Reading the tail instead yields the store slug — and since nearly
  // every app ships from the same store, the agent would be told that immich, gitlab and mailu
  // are all an app called "ci-store". Assert on an app whose name and store are unmistakable.
  it('names the app, not the store it came from', () => {
    const text = buildWakeText('app.crashed', { appUrn: 'immich:ci-store' }, 'high');
    expect(text).toContain('app "immich"');
    expect(text).not.toContain('app "ci-store"');
  });

  // ...and the converse: a routine success must not produce an unprompted message.
  it('tells the agent to stay quiet on an informational event', () => {
    expect(buildWakeText('update_success', { appUrn: 'immich:ci-store' }, 'info')).toMatch(/only mention it if the user asks/i);
    expect(buildWakeText('system.mcp_ready', { toolCount: 3 }, 'info')).toMatch(/no reply needed/i);
  });

  // The Hub's event names drifted into two styles — dotted and snake. The suffix fallback
  // means a new `*_error` the Hub adds tomorrow still reads sensibly instead of dumping JSON.
  it('handles an unknown *_error event through the suffix fallback', () => {
    const text = buildWakeText('migrate_error', { appUrn: 'x:ci-store', error: 'disk full' }, 'high');
    expect(text).toContain('"migrate" failed');
    expect(text).toContain('disk full');
  });

  it('caps a pathologically large data payload', () => {
    const text = buildWakeText('some_error', { appUrn: 'x:ci-store', error: 'x'.repeat(5000) }, 'high');
    expect(text.length).toBeLessThanOrEqual(800);
  });

  // A nested object in `data` must not render as the useless token "[object Object]"; the agent
  // should see the actual detail. Not emitted by today's scalar-only producers, but summarizeData
  // accepts Record<string, unknown>, so a future producer can pass one.
  it('renders a nested object as JSON, not [object Object]', () => {
    const text = buildWakeText('system.high_disk', { byMount: { '/': 90, '/data': 71 } }, 'high');
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('"/":90');
  });

  it('survives an event with no appUrn', () => {
    const text = buildWakeText('system.high_disk', { usagePercent: 99 }, 'high');
    expect(text).toContain('system.high_disk');
    expect(text).not.toContain('undefined');
  });
});

describe('passesUrgency', () => {
  it('defaults to dropping only the info tier', () => {
    expect(DEFAULT_MIN_URGENCY).toBe('low');
    expect(passesUrgency('high')).toBe(true);
    expect(passesUrgency('medium')).toBe(true);
    expect(passesUrgency('low')).toBe(true);
    expect(passesUrgency('info')).toBe(false);
  });

  it('respects a stricter floor', () => {
    expect(passesUrgency('high', 'high')).toBe(true);
    expect(passesUrgency('medium', 'high')).toBe(false);
  });

  it('lets an explicit info floor through', () => {
    expect(passesUrgency('info', 'info')).toBe(true);
  });
});

describe('isUrgency', () => {
  it.each(['high', 'medium', 'low', 'info'])('accepts the real tier %s', (tier) => {
    expect(isUrgency(tier)).toBe(true);
  });

  // `value in URGENCY_TIERS` would say yes to all of these, because `in` walks the prototype
  // chain. A floor of "constructor" then compares as NaN against every tier — dropping every
  // wake, with no warning, which is indistinguishable from a healthy but quiet system. This is
  // the whole reason the check is Object.hasOwn.
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])('rejects the inherited key %s', (key) => {
    expect(isUrgency(key)).toBe(false);
  });

  it('rejects a plain typo', () => {
    expect(isUrgency('urgent')).toBe(false);
    expect(isUrgency('')).toBe(false);
  });
});
