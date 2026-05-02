/**
 * reporter.ts — Screenshots, structured report building, verdict logic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import type { FieldResolution } from './config';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Verdict = 'healthy' | 'degraded' | 'partial' | 'dns-timeout' | 'unknown';

export type StepStatus = 'running' | 'pass' | 'fail' | 'skip' | 'warn';

export interface StepResult {
  status: StepStatus;
  [key: string]: unknown;
}

export interface Report {
  app: string;
  appId: string;
  version?: string;
  startedAt: string;
  finishedAt?: string;
  verdict: Verdict;
  steps: Record<string, StepResult>;
  screenshots: string[];
  issues: string[];
  /** Fields that were auto-generated and should be reviewed by the user */
  userVisibleConfig: Array<{ label: string; env_variable: string; value: string; reason: string }>;
  session: {
    actions: unknown[];
    observations: string[];
    errors: string[];
  };
}

// ─── Reporter class ────────────────────────────────────────────────────────────

export class Reporter {
  public report: Report;
  private screenshotDir: string;
  private reportDir: string;

  constructor(appName: string, appId: string, opts: { screenshotDir: string; reportDir: string }) {
    this.screenshotDir = opts.screenshotDir;
    this.reportDir = opts.reportDir;
    this.report = {
      app: appName,
      appId,
      startedAt: new Date().toISOString(),
      verdict: 'unknown',
      steps: {},
      screenshots: [],
      issues: [],
      userVisibleConfig: [],
      session: { actions: [], observations: [], errors: [] },
    };
  }

  step(name: string, data: StepResult) {
    this.report.steps[name] = data;
  }

  issue(msg: string) {
    this.report.issues.push(msg);
    console.warn(`[issue] ${msg}`);
  }

  async screenshot(page: Page, label: string): Promise<string> {
    const date = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.screenshotDir, date, this.report.appId);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: true });
    this.report.screenshots.push(p);
    return p;
  }

  addUserVisibleConfig(resolutions: FieldResolution[]) {
    for (const r of resolutions) {
      if (!r.showToUser) continue;
      this.report.userVisibleConfig.push({
        label: r.field.label,
        env_variable: r.field.env_variable,
        value: r.value,
        reason: r.reason ?? '',
      });
    }
  }

  finalise(): Verdict {
    this.report.finishedAt = new Date().toISOString();

    // dns-timeout is sticky — set during the run, never overwritten
    if (this.report.verdict === 'dns-timeout') return 'dns-timeout';

    const steps = Object.values(this.report.steps);
    if (steps.some((s) => s.status === 'fail')) {
      this.report.verdict = 'degraded';
    } else if (steps.every((s) => ['pass', 'skip', 'warn'].includes(s.status))) {
      this.report.verdict = 'healthy';
    } else {
      this.report.verdict = 'partial';
    }

    return this.report.verdict;
  }

  write(): string {
    fs.mkdirSync(this.reportDir, { recursive: true });
    const slug = `${this.report.appId}-${Date.now()}`;
    const p = path.join(this.reportDir, `${slug}.json`);
    fs.writeFileSync(p, JSON.stringify(this.report, null, 2));
    return p;
  }

  /** If verdict is degraded, write a fix-request for the fix agent to pick up. */
  writeFixRequest(reportPath: string) {
    if (this.report.verdict !== 'degraded' && this.report.verdict !== 'dns-timeout') return;
    const p = path.join(this.reportDir, `fix-request-${this.report.appId}-${Date.now()}.json`);
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          app: this.report.app,
          appId: this.report.appId,
          version: this.report.version,
          report: reportPath,
          verdict: this.report.verdict,
          issues: this.report.issues,
          steps: this.report.steps,
          sessionErrors: this.report.session.errors,
          userVisibleConfig: this.report.userVisibleConfig,
        },
        null,
        2,
      ),
    );
  }
}
