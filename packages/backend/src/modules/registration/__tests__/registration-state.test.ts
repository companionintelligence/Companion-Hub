import { describe, it, expect } from 'vitest';
import {
  isLegalTransition,
  isOperational,
  buildRegistrationStatus,
  transitionPhase,
  parseDegradedReasons,
  type ProvisioningPhase,
  PROVISIONING_PHASES,
  DEGRADED_REASONS,
} from '../registration-state';

describe('registration-state', () => {
  // -----------------------------------------------------------------------
  // isLegalTransition
  // -----------------------------------------------------------------------
  describe('isLegalTransition', () => {
    const legalCases: [ProvisioningPhase, ProvisioningPhase][] = [
      ['unregistered', 'paired'],
      ['paired', 'provisioning'],
      ['provisioning', 'locally_ready'],
      ['provisioning', 'degraded'],
      ['locally_ready', 'publicly_ready'],
      ['locally_ready', 'degraded'],
      ['publicly_ready', 'degraded'],
      ['degraded', 'locally_ready'],
      ['degraded', 'publicly_ready'],
      ['degraded', 'provisioning'],
    ];

    it.each(legalCases)('%s → %s is legal', (from, to) => {
      expect(isLegalTransition(from, to)).toBe(true);
    });

    it('reset to unregistered is always legal from any phase', () => {
      for (const phase of PROVISIONING_PHASES) {
        expect(isLegalTransition(phase, 'unregistered')).toBe(true);
      }
    });

    const illegalCases: [ProvisioningPhase, ProvisioningPhase][] = [
      ['unregistered', 'provisioning'],
      ['unregistered', 'locally_ready'],
      ['unregistered', 'publicly_ready'],
      ['unregistered', 'degraded'],
      ['paired', 'locally_ready'],
      ['paired', 'publicly_ready'],
      ['paired', 'degraded'],
      ['provisioning', 'paired'],
      ['provisioning', 'publicly_ready'],
      ['locally_ready', 'paired'],
      ['locally_ready', 'provisioning'],
      ['publicly_ready', 'paired'],
      ['publicly_ready', 'provisioning'],
      ['publicly_ready', 'locally_ready'],
    ];

    it.each(illegalCases)('%s → %s is illegal', (from, to) => {
      expect(isLegalTransition(from, to)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // isOperational
  // -----------------------------------------------------------------------
  describe('isOperational', () => {
    it('returns true for locally_ready, publicly_ready, degraded', () => {
      expect(isOperational('locally_ready')).toBe(true);
      expect(isOperational('publicly_ready')).toBe(true);
      expect(isOperational('degraded')).toBe(true);
    });

    it('returns false for unregistered, paired, provisioning', () => {
      expect(isOperational('unregistered')).toBe(false);
      expect(isOperational('paired')).toBe(false);
      expect(isOperational('provisioning')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // buildRegistrationStatus
  // -----------------------------------------------------------------------
  describe('buildRegistrationStatus', () => {
    it('includes degradedReasons only when phase is degraded', () => {
      const status = buildRegistrationStatus('degraded', ['tunnel_token_missing']);
      expect(status.phase).toBe('degraded');
      expect(status.degradedReasons).toEqual(['tunnel_token_missing']);
      expect(status.registered).toBe(true);
    });

    it('clears degradedReasons for non-degraded phases', () => {
      const status = buildRegistrationStatus('locally_ready', ['tunnel_token_missing']);
      expect(status.degradedReasons).toEqual([]);
    });

    it('sets registered=true for operational phases', () => {
      expect(buildRegistrationStatus('locally_ready').registered).toBe(true);
      expect(buildRegistrationStatus('publicly_ready').registered).toBe(true);
      expect(buildRegistrationStatus('degraded').registered).toBe(true);
    });

    it('sets registered=false for non-operational phases', () => {
      expect(buildRegistrationStatus('unregistered').registered).toBe(false);
      expect(buildRegistrationStatus('paired').registered).toBe(false);
      expect(buildRegistrationStatus('provisioning').registered).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // transitionPhase
  // -----------------------------------------------------------------------
  describe('transitionPhase', () => {
    it('returns the target phase on legal transitions', () => {
      expect(transitionPhase('unregistered', 'paired')).toBe('paired');
      expect(transitionPhase('paired', 'provisioning')).toBe('provisioning');
      expect(transitionPhase('provisioning', 'locally_ready')).toBe('locally_ready');
    });

    it('throws on illegal transitions', () => {
      expect(() => transitionPhase('unregistered', 'locally_ready')).toThrow('Illegal provisioning-phase transition');
      expect(() => transitionPhase('publicly_ready', 'paired')).toThrow('Illegal provisioning-phase transition');
    });
  });

  // -----------------------------------------------------------------------
  // parseDegradedReasons
  // -----------------------------------------------------------------------
  describe('parseDegradedReasons', () => {
    it('parses valid JSON array', () => {
      expect(parseDegradedReasons('["tunnel_token_missing"]')).toEqual(['tunnel_token_missing']);
    });

    it('filters out unknown reasons', () => {
      expect(parseDegradedReasons('["tunnel_token_missing","bogus"]')).toEqual(['tunnel_token_missing']);
    });

    it('returns empty array for null/undefined/empty', () => {
      expect(parseDegradedReasons(null)).toEqual([]);
      expect(parseDegradedReasons(undefined)).toEqual([]);
      expect(parseDegradedReasons('')).toEqual([]);
    });

    it('returns empty array for malformed JSON', () => {
      expect(parseDegradedReasons('not json')).toEqual([]);
    });

    it('returns empty array for non-array JSON', () => {
      expect(parseDegradedReasons('{"a":1}')).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Constant integrity
  // -----------------------------------------------------------------------
  describe('constants', () => {
    it('PROVISIONING_PHASES contains all expected values', () => {
      expect(PROVISIONING_PHASES).toEqual(['unregistered', 'paired', 'provisioning', 'locally_ready', 'publicly_ready', 'degraded']);
    });

    it('DEGRADED_REASONS contains all expected values', () => {
      expect(DEGRADED_REASONS).toEqual(['tunnel_token_missing', 'tunnel_unreachable', 'cloud_validation_failed']);
    });
  });
});
