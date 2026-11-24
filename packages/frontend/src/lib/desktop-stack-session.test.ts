import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearHubSteadySession,
  clearKeptStackUpdateOutcome,
  clearStackUpdatePending,
  isStackUpdatePending,
  keepStackUpdateOutcome,
  markHubSteadySession,
  markStackUpdatePending,
  readHubSteadySession,
  readKeptStackUpdateOutcome,
} from './desktop-stack-session';

describe('desktop-stack-session', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('tracks steady hub session', () => {
    expect(readHubSteadySession()).toBe(false);
    markHubSteadySession();
    expect(readHubSteadySession()).toBe(true);
    clearHubSteadySession();
    expect(readHubSteadySession()).toBe(false);
  });

  it('tracks pending stack updates', () => {
    expect(isStackUpdatePending()).toBe(false);
    markStackUpdatePending();
    expect(isStackUpdatePending()).toBe(true);
    clearStackUpdatePending();
    expect(isStackUpdatePending()).toBe(false);
  });

  it('keeps an update outcome until it is cleared', () => {
    keepStackUpdateOutcome({ state: 'not_confirmed', version: '0.3.9' });
    expect(readKeptStackUpdateOutcome()).toEqual({ state: 'not_confirmed', version: '0.3.9' });
    clearKeptStackUpdateOutcome();
    expect(readKeptStackUpdateOutcome()).toBeNull();
  });

  it('drops a kept outcome more than a day old', () => {
    const keptAt = 1_700_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    keepStackUpdateOutcome({ state: 'completed', version: '0.3.10' }, keptAt);

    expect(readKeptStackUpdateOutcome(keptAt + day)).toEqual({ state: 'completed', version: '0.3.10' });
    expect(readKeptStackUpdateOutcome(keptAt + day + 1)).toBeNull();
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a null', 'null'],
    ['an unknown state', '{"state":"done","version":"0.3.10","keptAt":1700000000000}'],
    ['no version', '{"state":"completed","keptAt":1700000000000}'],
    ['no time', '{"state":"completed","version":"0.3.10"}'],
  ])('reads %s as no outcome', (_name, stored) => {
    sessionStorage.setItem('ci-hub-stack-update-outcome', stored);
    expect(readKeptStackUpdateOutcome(1_700_000_000_000)).toBeNull();
  });
});
