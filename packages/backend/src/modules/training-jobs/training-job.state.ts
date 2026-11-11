/**
 * Job lifecycle. The set is deliberately small: HBPE's step list lives inside RUNNING, not in the
 * state machine, so a new job kind never needs a new state.
 */

export const TRAINING_JOB_STATES = [
  'QUEUED',
  'ACQUIRING_RESOURCES',
  'STAGING_DATA',
  'RUNNING',
  'EVALUATING',
  'PROMOTING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type TrainingJobState = (typeof TRAINING_JOB_STATES)[number];

export type TrainingJobEvent =
  | 'resources_granted'
  | 'data_ready'
  | 'steps_done'
  | 'gate_passed'
  | 'gate_rejected'
  | 'promoted'
  | 'error'
  | 'cancel';

const TERMINAL: ReadonlySet<TrainingJobState> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

const NEXT: Readonly<Record<TrainingJobState, Partial<Record<TrainingJobEvent, TrainingJobState>>>> = {
  QUEUED: { resources_granted: 'ACQUIRING_RESOURCES', cancel: 'CANCELLED', error: 'FAILED' },
  ACQUIRING_RESOURCES: { resources_granted: 'STAGING_DATA', cancel: 'CANCELLED', error: 'FAILED' },
  STAGING_DATA: { data_ready: 'RUNNING', cancel: 'CANCELLED', error: 'FAILED' },
  RUNNING: { steps_done: 'EVALUATING', cancel: 'CANCELLED', error: 'FAILED' },
  // A rejected gate is a finished job that kept the old artifact, not a failure.
  EVALUATING: { gate_passed: 'PROMOTING', gate_rejected: 'COMPLETED', cancel: 'CANCELLED', error: 'FAILED' },
  PROMOTING: { promoted: 'COMPLETED', error: 'FAILED' },
  COMPLETED: {},
  FAILED: {},
  CANCELLED: {},
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TrainingJobState,
    readonly event: TrainingJobEvent,
  ) {
    super(`cannot apply ${event} in state ${from}`);
  }
}

export function isTerminal(state: TrainingJobState): boolean {
  return TERMINAL.has(state);
}

export function transition(state: TrainingJobState, event: TrainingJobEvent): TrainingJobState {
  const next = NEXT[state][event];
  if (!next) throw new InvalidTransitionError(state, event);
  return next;
}
