import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';

/** Categories of issues the self-healing agent can detect */
export type IssueCategory =
  | 'port-conflict'
  | 'oom-killed'
  | 'crash-loop'
  | 'image-pull-error'
  | 'startup-failure'
  | 'volume-permission'
  | 'database-error'
  | 'config-error'
  | 'dependency-failure'
  | 'unknown';

/** What the agent did in response to an incident */
export type HealingAction = 'restarted' | 'notified-user' | 'ai-diagnosed' | 'skipped';

/** Outcome of the healing action */
export type HealingOutcome = 'resolved' | 'pending' | 'failed' | 'unknown';

export interface HealingIncident {
  id: string;
  appUrn: AppUrn;
  containerName: string;
  categories: IssueCategory[];
  logsExcerpt: string;
  action: HealingAction;
  outcome: HealingOutcome;
  diagnosis?: string;
  timestamp: string;
}

const MAX_INCIDENTS = 200;

/**
 * Tracks a ring-buffer of self-healing incidents for this Hub instance.
 * Provides context to the AI agent for pattern-based diagnosis and prevents
 * re-attempting fixes that have already failed multiple times.
 */
@Injectable()
export class SelfHealingHistoryService {
  private incidents: HealingIncident[] = [];

  /** Record a new incident. Evicts the oldest if the buffer is full. */
  addIncident(incident: Omit<HealingIncident, 'id' | 'timestamp'>): HealingIncident {
    const entry: HealingIncident = {
      ...incident,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    this.incidents.push(entry);
    if (this.incidents.length > MAX_INCIDENTS) {
      this.incidents.shift();
    }

    return entry;
  }

  /** Update the outcome of an existing incident by id */
  updateOutcome(id: string, outcome: HealingOutcome): void {
    const incident = this.incidents.find((i) => i.id === id);
    if (incident) {
      incident.outcome = outcome;
    }
  }

  /** Get all incidents for a given app URN within the last `withinMs` milliseconds */
  getRecentIncidents(appUrn: AppUrn, withinMs = 24 * 60 * 60 * 1000): HealingIncident[] {
    const cutoff = Date.now() - withinMs;
    return this.incidents.filter((i) => i.appUrn === appUrn && new Date(i.timestamp).getTime() > cutoff);
  }

  /**
   * Count how many times a specific category has been seen for an app in the given window.
   * Useful for deciding whether to attempt an autonomous restart.
   */
  countByCategory(appUrn: AppUrn, category: IssueCategory, withinMs = 60 * 60 * 1000): number {
    const cutoff = Date.now() - withinMs;
    return this.incidents.filter((i) => i.appUrn === appUrn && i.categories.includes(category) && new Date(i.timestamp).getTime() > cutoff).length;
  }

  /** Count how many autonomous restarts were attempted for an app in the given window */
  countRestarts(appUrn: AppUrn, withinMs = 60 * 60 * 1000): number {
    const cutoff = Date.now() - withinMs;
    return this.incidents.filter((i) => i.appUrn === appUrn && i.action === 'restarted' && new Date(i.timestamp).getTime() > cutoff).length;
  }

  /** Return all recorded incidents (newest last) */
  getAll(): HealingIncident[] {
    return [...this.incidents];
  }

  /** Return the most recent N incidents across all apps */
  getLatest(n = 20): HealingIncident[] {
    return this.incidents.slice(-n);
  }

  /** Exposed for testing */
  _clear(): void {
    this.incidents = [];
  }
}
