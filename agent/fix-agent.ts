/**
 * fix-agent.ts — Watches reports/ for fix-request files.
 *
 * For each request:
 *   1. Load app config + docker-compose from ci-marketplace
 *   2. Run diagnostics (local heuristics + optional AI)
 *   3. Apply the patch
 *   4. Verify with `bun verify:app`
 *   5. Commit + open a PR via `gh`
 *   6. Update agent/results/status.json throughout
 *
 * Usage:
 *   npx ts-node agent/fix-agent.ts           # process once
 *   WATCH=true npx ts-node agent/fix-agent.ts # watch mode
 *
 * Env:
 *   OPENAI_API_KEY          (for AI diagnosis)
 *   MARKETPLACE_DIR         (default: ../ci-marketplace)
 *   REPORT_DIR              (default: ../reports)
 *   LOG_DIR                 (default: ../logs)
 *   STATUS_FILE             (default: ./results/status.json)
 *   GITHUB_PR_BASE_BRANCH   (default: main)
 *   DRY_RUN=true            skip git/PR steps
 *   WATCH=true              watch reports/ for new requests
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import { loadAppConfig, loadDockerCompose, resolveAppId } from '../e2e/lib/config';
import { diagnose } from './lib/diagnostics';

// ─── Config ───────────────────────────────────────────────────────────────────

const COMPANION_DIR   = path.resolve(__dirname, '..');
const MARKETPLACE_DIR = process.env.MARKETPLACE_DIR ?? path.join(COMPANION_DIR, 'ci-marketplace');
const REPORT_DIR      = process.env.REPORT_DIR      ?? path.join(COMPANION_DIR, 'reports');
const LOG_DIR         = process.env.LOG_DIR         ?? path.join(COMPANION_DIR, 'logs');
const STATUS_FILE     = process.env.STATUS_FILE     ?? path.join(__dirname, 'results', 'status.json');
const PR_BASE         = process.env.GITHUB_PR_BASE_BRANCH ?? 'main';
const DRY_RUN         = process.env.DRY_RUN === 'true';
const WATCH_MODE      = process.env.WATCH  === 'true';

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });

// ─── Status ───────────────────────────────────────────────────────────────────

interface AgentStatus {
  lastUpdated:  string;
  queue:        string[];
  processing:   string | null;
  completed:    Array<{ app: string; result: 'fixed'|'failed'|'skipped'; pr?: string; at: string }>;
  errors:       Array<{ app: string; error: string; at: string }>;
}

const status: AgentStatus = (() => {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); }
  catch { return { lastUpdated: '', queue: [], processing: null, completed: [], errors: [] }; }
})();

function saveStatus() {
  status.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

// ─── Logging ──────────────────────────────────────────────────────────────────

const LOG_FILE = path.join(LOG_DIR, 'fix-agent.log');

function log(msg: string, level: 'info'|'warn'|'error' = 'info') {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ─── Fix pipeline ─────────────────────────────────────────────────────────────

async function processRequest(fixRequestPath: string) {
  const req  = JSON.parse(fs.readFileSync(fixRequestPath, 'utf8'));
  const { app, appId: rawAppId, version, issues, steps, sessionErrors, userVisibleConfig } = req;

  const appId = rawAppId ?? resolveAppId(app) ?? app.toLowerCase().replace(/\s+/g, '-');
  log(`Processing: ${app} (${appId})`);

  status.processing = appId;
  saveStatus();

  // ── Load marketplace files ──
  const config       = loadAppConfig(appId);
  const dockerCompose = loadDockerCompose(appId);

  if (!config || !dockerCompose) {
    const msg = `App not found in marketplace: ${appId}`;
    log(msg, 'error');
    status.errors.push({ app: appId, error: msg, at: new Date().toISOString() });
    status.processing = null;
    saveStatus();
    fs.renameSync(fixRequestPath, fixRequestPath.replace('fix-request-', 'failed-'));
    return;
  }

  // ── Diagnose ──
  log('Running diagnostics...');
  let result;
  try {
    result = await diagnose({
      appId, appName: app, version,
      verdict:  req.verdict,
      issues:   issues ?? [],
      steps:    steps  ?? {},
      sessionErrors: sessionErrors ?? [],
      userVisibleConfig: userVisibleConfig ?? [],
      config,
      dockerCompose,
    });
  } catch (e: any) {
    log(`Diagnosis failed: ${e.message}`, 'error');
    status.errors.push({ app: appId, error: e.message, at: new Date().toISOString() });
    status.processing = null;
    saveStatus();
    return;
  }

  log(`Categories: ${result.categories.join(', ')} | Confidence: ${result.confidence}`);
  log(`Diagnosis: ${result.diagnosis}`);

  if (!result.fix) {
    log('No fix determined — skipping');
    status.completed.push({ app: appId, result: 'skipped', at: new Date().toISOString() });
    status.processing = null;
    saveStatus();
    fs.renameSync(fixRequestPath, fixRequestPath.replace('fix-request-', 'skipped-'));
    return;
  }

  // ── Apply patch ──
  const appDir    = path.join(MARKETPLACE_DIR, 'apps', appId);
  const targetPath = path.join(appDir, result.fix.file);
  const backupPath = targetPath + '.bak';
  fs.copyFileSync(targetPath, backupPath);

  log(`Patching ${result.fix.file}: ${result.fix.summary}`);
  fs.writeFileSync(targetPath, JSON.stringify(result.fix.patch, null, 2));

  // ── Verify ──
  log('Running bun verify:app...');
  let verified = false;
  try {
    execSync(`cd "${MARKETPLACE_DIR}" && bun run verify:app -- ${appId}`, {
      stdio: 'pipe', timeout: 60_000,
    });
    verified = true;
    log('Verification passed');
  } catch (e: any) {
    log(`Verification failed: ${e.stderr?.toString().slice(0, 200) ?? e.message}`, 'warn');
    fs.copyFileSync(backupPath, targetPath); // restore
  }
  fs.unlinkSync(backupPath);

  if (!verified) {
    status.errors.push({ app: appId, error: 'verify:app failed after patch', at: new Date().toISOString() });
    status.completed.push({ app: appId, result: 'failed', at: new Date().toISOString() });
    status.processing = null;
    saveStatus();
    fs.renameSync(fixRequestPath, fixRequestPath.replace('fix-request-', 'failed-'));
    return;
  }

  // ── Commit + PR ──
  if (DRY_RUN) {
    log('[DRY RUN] Skipping git/PR');
    status.completed.push({ app: appId, result: 'fixed', pr: 'dry-run', at: new Date().toISOString() });
  } else {
    const branch = `fix/e2e-${appId}-${Date.now()}`;
    try {
      execSync(`cd "${MARKETPLACE_DIR}" && git checkout -b ${branch}`,            { stdio: 'pipe' });
      execSync(`cd "${MARKETPLACE_DIR}" && git add apps/${appId}/`,               { stdio: 'pipe' });

      const commitMsg = `fix(${appId}): ${result.fix.summary}\n\n${result.diagnosis}`;
      execSync(`cd "${MARKETPLACE_DIR}" && git commit -m ${JSON.stringify(commitMsg)}`, { stdio: 'pipe' });
      execSync(`cd "${MARKETPLACE_DIR}" && git push origin ${branch}`,             { stdio: 'pipe' });

      const prBody = [
        `## E2E Fix: ${app}`,
        '',
        `**Categories:** ${result.categories.join(', ')}`,
        `**Confidence:** ${result.confidence}`,
        '',
        `**Diagnosis:**`,
        result.diagnosis,
        '',
        result.suggestions.length ? `**Notes:**\n${result.suggestions.map(s => `- ${s}`).join('\n')}` : '',
        '',
        userVisibleConfig?.length
          ? `**User-visible config fields (should be reviewed):**\n${userVisibleConfig.map((f: any) => `- \`${f.env_variable}\` — ${f.reason}`).join('\n')}`
          : '',
        '',
        '---',
        '*Auto-generated by companion fix-agent*',
      ].filter(Boolean).join('\n');

      const prOut = execSync(
        `cd "${MARKETPLACE_DIR}" && gh pr create --title ${JSON.stringify(`fix(${appId}): ${result.fix.summary}`)} --body ${JSON.stringify(prBody)} --base ${PR_BASE}`,
        { encoding: 'utf8', stdio: 'pipe' },
      ).trim();

      log(`PR: ${prOut}`);
      status.completed.push({ app: appId, result: 'fixed', pr: prOut, at: new Date().toISOString() });
    } catch (e: any) {
      log(`Git/PR failed: ${e.message}`, 'error');
      status.errors.push({ app: appId, error: `git/PR: ${e.message}`, at: new Date().toISOString() });
      status.completed.push({ app: appId, result: 'failed', at: new Date().toISOString() });
    }
  }

  fs.renameSync(fixRequestPath, fixRequestPath.replace('fix-request-', 'processed-'));
  status.processing = null;
  saveStatus();
  log(`Done: ${appId}`);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

async function scan() {
  const files = fs.readdirSync(REPORT_DIR).filter(f => f.startsWith('fix-request-') && f.endsWith('.json'));
  if (!files.length) return;
  status.queue = files;
  saveStatus();
  for (const f of files) await processRequest(path.join(REPORT_DIR, f));
}

async function main() {
  log(`Fix agent started${DRY_RUN ? ' [DRY RUN]' : ''}${WATCH_MODE ? ' [WATCH]' : ''}`);
  await scan();

  if (WATCH_MODE) {
    log('Watching for fix requests...');
    fs.watch(REPORT_DIR, async (_, filename) => {
      if (filename?.startsWith('fix-request-') && filename.endsWith('.json')) {
        await scan();
      }
    });
  }
}

main().catch(e => { log(`Fatal: ${e.message}`, 'error'); process.exit(1); });
