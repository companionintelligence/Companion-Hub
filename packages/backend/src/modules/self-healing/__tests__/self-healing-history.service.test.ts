import { describe, it, expect, beforeEach } from 'vitest';
import { SelfHealingHistoryService } from '../self-healing-history.service';
import type { AppUrn } from '@ci-hub/common/types';

const APP_URN = 'test-app:store' as AppUrn;

describe('SelfHealingHistoryService', () => {
  let service: SelfHealingHistoryService;

  beforeEach(() => {
    service = new SelfHealingHistoryService();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('addIncident', () => {
    it('should add an incident and return it with id and timestamp', () => {
      const incident = service.addIncident({
        appUrn: APP_URN,
        containerName: 'test-container',
        categories: ['startup-failure'],
        logsExcerpt: 'some log line',
        action: 'restarted',
        outcome: 'pending',
      });

      expect(incident.id).toBeDefined();
      expect(incident.timestamp).toBeDefined();
      expect(incident.appUrn).toBe(APP_URN);
      expect(incident.action).toBe('restarted');
    });

    it('should store incident in history', () => {
      service.addIncident({
        appUrn: APP_URN,
        containerName: 'c1',
        categories: ['crash-loop'],
        logsExcerpt: '',
        action: 'restarted',
        outcome: 'resolved',
      });

      expect(service.getAll()).toHaveLength(1);
    });

    it('should evict oldest incident when buffer is full (max 200)', () => {
      for (let i = 0; i < 201; i++) {
        service.addIncident({
          appUrn: APP_URN,
          containerName: `c${i}`,
          categories: ['unknown'],
          logsExcerpt: '',
          action: 'notified-user',
          outcome: 'unknown',
        });
      }

      const all = service.getAll();
      expect(all).toHaveLength(200);
      // First incident (c0) should be evicted
      expect(all[0].containerName).toBe('c1');
    });
  });

  describe('updateOutcome', () => {
    it('should update the outcome of an existing incident', () => {
      const incident = service.addIncident({
        appUrn: APP_URN,
        containerName: 'c1',
        categories: ['startup-failure'],
        logsExcerpt: '',
        action: 'restarted',
        outcome: 'pending',
      });

      service.updateOutcome(incident.id, 'resolved');

      const all = service.getAll();
      expect(all[0]?.outcome).toBe('resolved');
    });

    it('should be a no-op for unknown id', () => {
      service.addIncident({
        appUrn: APP_URN,
        containerName: 'c1',
        categories: ['startup-failure'],
        logsExcerpt: '',
        action: 'restarted',
        outcome: 'pending',
      });

      expect(() => service.updateOutcome('nonexistent-id', 'resolved')).not.toThrow();
    });
  });

  describe('getRecentIncidents', () => {
    it('should return incidents within the default 24-hour window', () => {
      service.addIncident({
        appUrn: APP_URN,
        containerName: 'c1',
        categories: ['crash-loop'],
        logsExcerpt: '',
        action: 'restarted',
        outcome: 'pending',
      });

      const recent = service.getRecentIncidents(APP_URN);
      expect(recent).toHaveLength(1);
    });

    it('should not return incidents for a different app', () => {
      service.addIncident({
        appUrn: 'other-app:store' as AppUrn,
        containerName: 'c1',
        categories: ['crash-loop'],
        logsExcerpt: '',
        action: 'restarted',
        outcome: 'pending',
      });

      const recent = service.getRecentIncidents(APP_URN);
      expect(recent).toHaveLength(0);
    });

    it('should not return incidents outside the time window', () => {
      const incident = service.addIncident({
        appUrn: APP_URN,
        containerName: 'c1',
        categories: ['crash-loop'],
        logsExcerpt: '',
        action: 'restarted',
        outcome: 'resolved',
      });

      // Force the timestamp to be old
      const all = service.getAll();
      const stored = all.find((i) => i.id === incident.id);
      if (stored) {
        (stored as { timestamp: string }).timestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      }

      // Window of only 1 hour
      const recent = service.getRecentIncidents(APP_URN, 60 * 60 * 1000);
      expect(recent).toHaveLength(0);
    });
  });

  describe('countByCategory', () => {
    it('should count incidents matching a specific category within window', () => {
      service.addIncident({
        appUrn: APP_URN,
        containerName: 'c1',
        categories: ['crash-loop'],
        logsExcerpt: '',
        action: 'restarted',
        outcome: 'resolved',
      });
      service.addIncident({
        appUrn: APP_URN,
        containerName: 'c2',
        categories: ['crash-loop', 'oom-killed'],
        logsExcerpt: '',
        action: 'restarted',
        outcome: 'resolved',
      });
      service.addIncident({
        appUrn: APP_URN,
        containerName: 'c3',
        categories: ['startup-failure'],
        logsExcerpt: '',
        action: 'notified-user',
        outcome: 'unknown',
      });

      expect(service.countByCategory(APP_URN, 'crash-loop')).toBe(2);
      expect(service.countByCategory(APP_URN, 'oom-killed')).toBe(1);
      expect(service.countByCategory(APP_URN, 'startup-failure')).toBe(1);
      expect(service.countByCategory(APP_URN, 'port-conflict')).toBe(0);
    });
  });

  describe('countRestarts', () => {
    it('should count restarted actions within the default 1-hour window', () => {
      service.addIncident({
        appUrn: APP_URN,
        containerName: 'c1',
        categories: ['crash-loop'],
        logsExcerpt: '',
        action: 'restarted',
        outcome: 'resolved',
      });
      service.addIncident({
        appUrn: APP_URN,
        containerName: 'c2',
        categories: ['startup-failure'],
        logsExcerpt: '',
        action: 'notified-user',
        outcome: 'unknown',
      });
      service.addIncident({
        appUrn: APP_URN,
        containerName: 'c3',
        categories: ['crash-loop'],
        logsExcerpt: '',
        action: 'restarted',
        outcome: 'resolved',
      });

      expect(service.countRestarts(APP_URN)).toBe(2);
    });
  });

  describe('getLatest', () => {
    it('should return the most recent N incidents', () => {
      for (let i = 0; i < 10; i++) {
        service.addIncident({
          appUrn: APP_URN,
          containerName: `c${i}`,
          categories: ['unknown'],
          logsExcerpt: '',
          action: 'notified-user',
          outcome: 'unknown',
        });
      }

      const latest = service.getLatest(3);
      expect(latest).toHaveLength(3);
      expect(latest[2]?.containerName).toBe('c9');
    });
  });
});
