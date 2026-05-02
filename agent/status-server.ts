#!/usr/bin/env node
/**
 * status-server.ts
 *
 * Lightweight Express server exposing observability into the agent loop.
 * Serves:
 *   GET /          → HTML dashboard
 *   GET /api/status → agent status JSON
 *   GET /api/reports → list of test reports
 *   GET /api/reports/:id → single report
 *   GET /api/logs   → last 200 lines of fix-agent.log
 *   GET /api/screenshots → list of screenshots by date/app
 *
 * Usage: npx ts-node agent/status-server.ts
 * Port: STATUS_PORT (default 3099)
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';

const PORT           = parseInt(process.env.STATUS_PORT || '3099');
const COMPANION_DIR  = path.resolve(__dirname, '..');
const STATUS_FILE    = path.join(COMPANION_DIR, 'agent', 'results', 'status.json');
const REPORT_DIR     = path.join(COMPANION_DIR, 'reports');
const LOG_FILE       = path.join(COMPANION_DIR, 'logs', 'fix-agent.log');
const SCREENSHOT_DIR = path.join(COMPANION_DIR, 'screenshots');

function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); }
  catch { return { lastUpdated: null, queue: [], processing: null, completed: [], errors: [] }; }
}

function listReports() {
  try {
    return fs.readdirSync(REPORT_DIR)
      .filter(f => f.endsWith('.json') && !f.startsWith('fix-request') && !f.startsWith('processed') && !f.startsWith('failed') && !f.startsWith('skipped'))
      .map(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, f), 'utf8'));
          return { id: f, app: d.app, verdict: d.verdict, startedAt: d.startedAt, finishedAt: d.finishedAt };
        } catch { return { id: f }; }
      })
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  } catch { return []; }
}

function lastLogLines(n = 200) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    return lines.slice(-n).join('\n');
  } catch { return ''; }
}

function listScreenshots() {
  try {
    const dates = fs.readdirSync(SCREENSHOT_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const result: Record<string, Record<string, string[]>> = {};
    for (const date of dates) {
      result[date] = {};
      const apps = fs.readdirSync(path.join(SCREENSHOT_DIR, date));
      for (const app of apps) {
        result[date][app] = fs.readdirSync(path.join(SCREENSHOT_DIR, date, app));
      }
    }
    return result;
  } catch { return {}; }
}

function dashboard(status: any, reports: any[]): string {
  const verdictColor = (v: string) => ({ healthy: '#1AC8B4', degraded: '#f87171', partial: '#fbbf24', unknown: '#6b7280' }[v] || '#6b7280');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Companion E2E Agent Status</title>
  <meta http-equiv="refresh" content="15">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0F1F1B; color: #e5e7eb; font-family: system-ui, sans-serif; padding: 24px; }
    h1 { font-size: 1.4rem; color: #1AC8B4; margin-bottom: 4px; }
    .sub { color: #6b7280; font-size: 0.8rem; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #152820; border: 1px solid #2A4A40; border-radius: 8px; padding: 16px; }
    .card h2 { font-size: 0.75rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
    .status-pill { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
    .row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #1a3028; font-size: 0.85rem; }
    .row:last-child { border-bottom: none; }
    .mono { font-family: monospace; font-size: 0.75rem; color: #9ca3af; }
    .log { background: #0d1117; border: 1px solid #2A4A40; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 0.7rem; color: #9ca3af; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
    .empty { color: #4b5563; font-style: italic; font-size: 0.85rem; padding: 8px 0; }
  </style>
</head>
<body>
  <h1>🤖 Companion E2E Agent</h1>
  <p class="sub">Auto-refreshes every 15s — ${new Date().toLocaleString()}</p>

  <div class="grid">
    <div class="card">
      <h2>Agent State</h2>
      <div class="row">
        <span>Processing</span>
        <span>${status.processing
          ? `<span class="status-pill" style="background:#fbbf24;color:#000">${status.processing}</span>`
          : `<span class="status-pill" style="background:#2A4A40;color:#6b7280">idle</span>`}</span>
      </div>
      <div class="row"><span>Queue</span><span>${status.queue?.length || 0} pending</span></div>
      <div class="row"><span>Completed</span><span>${status.completed?.length || 0}</span></div>
      <div class="row"><span>Errors</span><span style="color:#f87171">${status.errors?.length || 0}</span></div>
      <div class="row"><span>Last updated</span><span class="mono">${status.lastUpdated ? new Date(status.lastUpdated).toLocaleTimeString() : '—'}</span></div>
    </div>

    <div class="card">
      <h2>Recent Fixes</h2>
      ${(status.completed || []).slice(-5).reverse().map((c: any) => `
        <div class="row">
          <span>${c.app}</span>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="status-pill" style="background:${c.result === 'fixed' ? '#14532d' : '#450a0a'};color:${c.result === 'fixed' ? '#1AC8B4' : '#f87171'}">${c.result}</span>
            ${c.pr && c.pr !== 'dry-run' ? `<a href="${c.pr}" style="color:#60a5fa;font-size:0.7rem" target="_blank">PR</a>` : ''}
          </div>
        </div>`).join('') || '<p class="empty">No fixes yet</p>'}
    </div>

    <div class="card">
      <h2>Test Reports</h2>
      ${reports.slice(0, 8).map(r => `
        <div class="row">
          <span>${r.app || r.id}</span>
          <span class="status-pill" style="background:${verdictColor(r.verdict)}22;color:${verdictColor(r.verdict)}">${r.verdict || '?'}</span>
        </div>`).join('') || '<p class="empty">No reports yet</p>'}
    </div>
  </div>

  <div class="card" style="margin-bottom:16px">
    <h2>Recent Errors</h2>
    ${(status.errors || []).slice(-5).reverse().map((e: any) => `
      <div class="row">
        <span style="color:#f87171">${e.app}</span>
        <span class="mono">${e.error?.slice(0, 80)}</span>
      </div>`).join('') || '<p class="empty">No errors</p>'}
  </div>

  <div class="card">
    <h2>Fix Agent Log (last 200 lines)</h2>
    <div class="log" id="log">${lastLogLines().replace(/</g, '&lt;')}</div>
  </div>

  <script>
    // Scroll log to bottom
    const log = document.getElementById('log');
    if (log) log.scrollTop = log.scrollHeight;
  </script>
</body>
</html>`;
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readStatus(), null, 2));

  } else if (url === '/api/reports') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listReports(), null, 2));

  } else if (url.startsWith('/api/reports/')) {
    const id = decodeURIComponent(url.slice('/api/reports/'.length));
    const p  = path.join(REPORT_DIR, id);
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(p));
    } else {
      res.writeHead(404); res.end('Not found');
    }

  } else if (url === '/api/logs') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(lastLogLines());

  } else if (url === '/api/screenshots') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listScreenshots(), null, 2));

  } else {
    const status  = readStatus();
    const reports = listReports();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(dashboard(status, reports));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[status-server] http://localhost:${PORT}  (Tailscale: http://100.79.67.15:${PORT})`);
});
