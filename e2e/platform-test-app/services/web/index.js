const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');
const { createClient } = require('redis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static assets
app.use('/static', express.static(path.join(__dirname, 'public')));

// Health toggle
let healthy = true;

// ── API Routes ──────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.status(healthy ? 200 : 500).json({ status: healthy ? 'ok' : 'unhealthy' });
});

app.post('/api/set-unhealthy', (_req, res) => {
  healthy = false;
  res.json({ status: 'unhealthy' });
});

app.post('/api/set-healthy', (_req, res) => {
  healthy = true;
  res.json({ status: 'ok' });
});

app.get('/api/env', (_req, res) => {
  const filtered = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('E2E_') || k.startsWith('CI_') || k.startsWith('APP_')) {
      filtered[k] = v;
    }
  }
  res.json(filtered);
});

app.get('/api/db-check', async (_req, res) => {
  const client = new Client({
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'e2e',
    password: process.env.DB_PASSWORD || 'e2e',
    database: process.env.DB_NAME || 'e2e',
  });
  try {
    await client.connect();
    const result = await client.query('SELECT COUNT(*) as count FROM worker_heartbeats');
    await client.end();
    res.json({ ok: true, rows: Number(result.rows[0].count) });
  } catch (err) {
    try {
      await client.end();
    } catch {
      /* ignored */
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/redis-check', async (_req, res) => {
  const redis = createClient({ url: `redis://${process.env.REDIS_HOST || 'cache'}:6379` });
  try {
    await redis.connect();
    const ts = Date.now().toString();
    await redis.set('e2e_check', ts);
    const val = await redis.get('e2e_check');
    await redis.quit();
    res.json({ ok: true, written: ts, read: val, match: ts === val });
  } catch (err) {
    try {
      await redis.quit();
    } catch {
      /* ignored */
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/worker-status', async (_req, res) => {
  const client = new Client({
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'e2e',
    password: process.env.DB_PASSWORD || 'e2e',
    database: process.env.DB_NAME || 'e2e',
  });
  try {
    await client.connect();
    const result = await client.query("SELECT MAX(created_at) as latest FROM worker_heartbeats WHERE created_at > NOW() - INTERVAL '30 seconds'");
    await client.end();
    const latest = result.rows[0].latest;
    res.json({ ok: !!latest, latest });
  } catch (err) {
    try {
      await client.end();
    } catch {
      /* ignored */
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';

app.post('/api/write-file', (req, res) => {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const filename = req.body.filename || 'test.txt';
    const content = req.body.content || '';
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), content);
    res.json({ ok: true, filename });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/read-file', (req, res) => {
  try {
    const filename = req.query.filename || 'test.txt';
    const content = fs.readFileSync(path.join(UPLOAD_DIR, filename), 'utf-8');
    res.json({ ok: true, filename, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── HTML page ───────────────────────────────────────────────

const html = `<!DOCTYPE html>
<html>
<head>
  <title>CI E2E Test App</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <h1>CI E2E Test App</h1>
  <p>This app validates Hub platform capabilities.</p>
  <img id="logo" src="/static/logo.svg" alt="logo" width="64" height="64">
  <h2>Environment Variables</h2>
  <pre id="env">Loading...</pre>
  <script>
    fetch('/api/env').then(r=>r.json()).then(d=>{
      document.getElementById('env').textContent=JSON.stringify(d,null,2);
    });
  </script>
</body>
</html>`;

// SPA fallback: any non-API, non-static route returns index.html
app.get(/^(?!\/api|\/static).*/, (_req, res) => {
  res.type('html').send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  /* server started */
});
