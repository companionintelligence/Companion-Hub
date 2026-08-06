import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearHubSteadySession,
  clearStackUpdatePending,
  isStackUpdatePending,
  markHubSteadySession,
  markStackUpdatePending,
  readHubSteadySession,
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
});
