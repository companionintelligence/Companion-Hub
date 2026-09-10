/**
 * Release desktop bootstrap — polls the local Hub stack, then navigates to it.
 * Product UI lives in the container; this page is embedded in the Tauri binary only.
 *
 * This page is the FIRST half of one startup screen. The second half is
 * StartupScreen in components/hub-status/hub-status.tsx, which takes over the
 * moment the Hub API answers. They are deliberately the same screen — same
 * heading, same progress bar, same per-service rows, same copy — so the handover
 * from the Tauri page to React is invisible; see bootstrap.css.
 *
 * Both halves read the same `get_startup_progress_command`, a Rust-side Docker
 * inspection that works before any container is serving HTTP.
 */
(function bootstrap() {
  const POLL_INTERVAL_MS = 1000;
  const MAX_ATTEMPTS = 180;
  const PROGRESS_INTERVAL_MS = 2000;
  /** Elapsed thresholds where the subtitle changes — the same ones StartupScreen uses. */
  const SLOW_AFTER_S = 90;
  const VERY_SLOW_AFTER_S = 180;

  const statusEl = document.getElementById('status');
  const actionsEl = document.getElementById('actions');
  const progressEl = document.getElementById('progress');
  const barFillEl = document.getElementById('bar-fill');
  const progressPctEl = document.getElementById('progress-pct');
  const elapsedEl = document.getElementById('elapsed');
  const serviceCountsEl = document.getElementById('service-counts');
  const imagePullsEl = document.getElementById('image-pulls');
  const servicesEl = document.getElementById('services');
  const initialisingEl = document.getElementById('initialising');
  const checksUpdatedEl = document.getElementById('checks-updated');

  function invoke(cmd, args) {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') {
      return Promise.reject(new Error('Tauri invoke unavailable'));
    }
    return internals.invoke(cmd, args);
  }

  // ── Titlebar ──────────────────────────────────────────────────────────────
  // main.rs strips native decorations on Windows/Linux, so this page owns both
  // the drag region and the window controls — the same bar (40px, logo + name +
  // three controls) that components/titlebar/titlebar.tsx renders in the app.
  // macOS keeps its native traffic lights over the WebView and gets the 28px
  // transparent spacer titlebar.tsx uses there.

  const MAC_TITLEBAR_PX = 28;
  const TITLEBAR_PX = 40;

  /**
   * Is this macOS, decided synchronously — tauri-plugin-os injects its internals
   * into every window with a js_init_script, so no IPC round trip is needed.
   */
  function isMac() {
    const os = window.__TAURI_OS_PLUGIN_INTERNALS__;
    if (os?.os_type) return os.os_type === 'macos';
    return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  }

  function controlButton(label, className, svg) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    if (className) button.className = className;
    button.innerHTML = svg;
    return button;
  }

  function renderTitlebar() {
    const bar = document.createElement('div');
    const mac = isMac();

    document.documentElement.style.setProperty('--titlebar-height', `${mac ? MAC_TITLEBAR_PX : TITLEBAR_PX}px`);

    if (mac) {
      bar.className = 'titlebar titlebar-mac';
      bar.setAttribute('data-tauri-drag-region', '');
      document.body.prepend(bar);
      return;
    }

    bar.className = 'titlebar';

    const drag = document.createElement('div');
    drag.className = 'titlebar-drag';
    drag.setAttribute('data-tauri-drag-region', '');
    const icon = document.createElement('img');
    icon.className = 'titlebar-icon';
    icon.src = './assets/hub-icon.png';
    icon.alt = '';
    const title = document.createElement('span');
    title.className = 'titlebar-title';
    title.textContent = 'CI Hub';
    drag.append(icon, title);

    // The drag region above never waits on IPC: if the window commands are
    // unavailable the window must still be movable.
    const controls = document.createElement('div');
    controls.className = 'titlebar-controls';

    const minimize = controlButton(
      'Minimize window',
      '',
      '<svg width="10" height="1" viewBox="0 0 10 1" aria-hidden="true"><path d="M0 0.5h10" stroke="currentColor" stroke-width="1" /></svg>',
    );
    minimize.addEventListener('click', () => {
      void invoke('plugin:window|minimize', { label: 'main' }).catch(() => undefined);
    });

    const MAXIMIZE_ICON =
      '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" stroke-width="1" /></svg>';
    const RESTORE_ICON =
      '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="2.5" y="0.5" width="7" height="7" stroke="currentColor" fill="none" stroke-width="1" /><rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" fill="none" stroke-width="1" /></svg>';
    const maximize = controlButton('Maximize window', '', MAXIMIZE_ICON);
    maximize.addEventListener('click', () => {
      void invoke('plugin:window|toggle_maximize', { label: 'main' }).catch(() => undefined);
    });

    // Keep the glyph honest about what the button will do. Debounced, because
    // is_maximized with decorations:false is not free on Windows/Linux.
    let maximizeCheck = null;
    const syncMaximized = () => {
      void invoke('plugin:window|is_maximized', { label: 'main' })
        .then((isMaximized) => {
          maximize.innerHTML = isMaximized ? RESTORE_ICON : MAXIMIZE_ICON;
          maximize.setAttribute('aria-label', isMaximized ? 'Restore window' : 'Maximize window');
        })
        .catch(() => undefined);
    };
    window.addEventListener('resize', () => {
      if (maximizeCheck) clearTimeout(maximizeCheck);
      maximizeCheck = setTimeout(syncMaximized, 150);
    });
    syncMaximized();

    const close = controlButton(
      'Close window',
      'close',
      '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.2" /></svg>',
    );
    close.addEventListener('click', () => {
      void invoke('plugin:window|close', { label: 'main' }).catch(() => undefined);
    });

    controls.append(minimize, maximize, close);
    bar.append(drag, controls);
    document.body.prepend(bar);
  }

  // ── Status line ───────────────────────────────────────────────────────────
  // While the Hub is merely starting, the subtitle is driven by elapsed time, as
  // StartupScreen does. A failure or the timeout pins it until the next attempt.

  let statusPinned = false;

  function setStatus(message, { tone = 'muted', pin = false } = {}) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle('warn', tone === 'warn');
    statusEl.classList.toggle('error', tone === 'error');
    statusPinned = pin;
  }

  function elapsedStatusMessage() {
    if (elapsedSeconds > VERY_SLOW_AFTER_S) return 'Still working - Docker images may be downloading for the first time.';
    if (elapsedSeconds > SLOW_AFTER_S) return 'Almost there - some services are taking longer than usual.';
    return 'Services are coming online...';
  }

  // ── Startup progress ──────────────────────────────────────────────────────

  const SERVICE_ICON = { pending: '○', starting: '◌', ready: '●', failed: '✕', unavailable: '—' };
  const SERVICE_TONE = {
    pending: 'tone-muted',
    starting: 'tone-warn',
    ready: 'tone-ok',
    failed: 'tone-bad',
    unavailable: 'tone-muted',
  };
  const SERVICE_LABEL = {
    pending: 'Waiting...',
    starting: 'Starting',
    ready: 'Ready',
    failed: 'Failed',
    unavailable: 'Not available',
  };

  /** Tone → glyph for the two rows that are checks rather than containers. */
  const CHECK_ICON = { ok: '●', warn: '◌', bad: '✕', muted: '○' };

  let startedAt = Date.now();
  let elapsedSeconds = 0;
  /**
   * Docker access and Hub reachability. They are not containers, so they have no
   * row of their own from the progress command — but when startup has stalled
   * they are the two things worth knowing, so they join the head of the same
   * list rather than opening a second panel.
   */
  let checkRows = [];
  let lastProgress = null;

  function renderElapsed() {
    elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsedEl) {
      elapsedEl.textContent = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')} elapsed`;
    }
    if (!statusPinned) {
      setStatus(elapsedStatusMessage());
    }
  }

  function listRow({ glyph, label, value, tone, hint, pulse = false }) {
    const row = document.createElement('div');
    row.className = 'service-row';

    const left = document.createElement('div');
    left.className = 'service-name';

    const icon = document.createElement('span');
    icon.className = `service-icon ${tone}${pulse ? ' pulse' : ''}`;
    icon.textContent = glyph;
    icon.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'service-label';
    name.textContent = label;
    if (hint) name.title = hint;

    left.append(icon, name);

    const state = document.createElement('span');
    state.className = `service-state ${tone}`;
    state.textContent = value;
    state.title = value;

    row.append(left, state);
    return row;
  }

  function serviceRow(service) {
    const tone = SERVICE_TONE[service.state] ?? 'tone-muted';
    return listRow({
      glyph: SERVICE_ICON[service.state] ?? '○',
      label: service.label,
      value: SERVICE_LABEL[service.state] ?? service.state,
      tone,
      hint: service.container,
      pulse: service.state === 'starting',
    });
  }

  function renderList() {
    if (!servicesEl) return;
    const services = Array.isArray(lastProgress?.services) ? lastProgress.services : [];
    // Optional sidecars (VPN, tunnel, Ollama) must not clutter startup while
    // disconnected, and never count toward the totals — as in StartupScreen.
    const visible = services.filter((service) => !service.optional || service.state === 'ready');
    const rows = [
      ...checkRows.map((check) =>
        listRow({
          glyph: CHECK_ICON[check.tone] ?? '○',
          label: check.label,
          value: check.value,
          tone: `tone-${check.tone}`,
          hint: check.hint,
        }),
      ),
      ...visible.map(serviceRow),
    ];
    servicesEl.replaceChildren(...rows);
    servicesEl.hidden = rows.length === 0;
    if (initialisingEl) initialisingEl.hidden = rows.length > 0;
  }

  function renderProgress(progress) {
    lastProgress = progress;
    const services = Array.isArray(progress?.services) ? progress.services : [];
    const counts = services.reduce(
      (acc, service) => {
        if (!service.optional && acc[service.state] !== undefined) acc[service.state] += 1;
        return acc;
      },
      { pending: 0, starting: 0, ready: 0, failed: 0, unavailable: 0 },
    );

    const pct = typeof progress?.progress_pct === 'number' ? progress.progress_pct : 0;
    if (barFillEl) barFillEl.style.width = `${Math.max(pct, 4)}%`;
    if (progressPctEl) progressPctEl.textContent = `${pct}%`;
    if (progressEl) progressEl.hidden = false;

    if (serviceCountsEl) {
      const failed = counts.failed > 0 ? `, ${counts.failed} Failed` : '';
      serviceCountsEl.textContent = `${counts.ready} Ready, ${counts.starting} Starting, ${counts.pending} pending${failed}`;
    }
    if (imagePullsEl) {
      imagePullsEl.textContent =
        typeof progress?.image_total === 'number' && progress.image_total > 0
          ? `Image pulls: ${progress.image_pulled}/${progress.image_total} (${progress.image_pull_pct}%)`
          : '';
    }

    renderList();
  }

  async function pollProgress() {
    try {
      renderProgress(await invoke('get_startup_progress_command'));
    } catch {
      // Older shell, or Docker not answering yet: hide the bar and leave the
      // "Initialising..." row showing rather than an empty card.
      lastProgress = null;
      if (progressEl) progressEl.hidden = true;
      renderList();
    }
  }

  // ── Recovery state ────────────────────────────────────────────────────────

  function showActions() {
    if (actionsEl) actionsEl.hidden = false;
    // Tells the stylesheet this is the tall recovery state (see bootstrap.css).
    document.body.classList.add('expanded');
    void runDiagnostics();
  }

  function hideActions() {
    if (actionsEl) actionsEl.hidden = true;
    checkRows = [];
    if (checksUpdatedEl) checksUpdatedEl.hidden = true;
    renderList();
    document.body.classList.remove('expanded');
  }

  async function resolveHubUrl() {
    try {
      return await invoke('get_hub_api_url_command');
    } catch {
      return 'http://127.0.0.1:5002';
    }
  }

  async function isHubLive(baseUrl) {
    try {
      const ok = await invoke('check_hub_status', { url: baseUrl });
      return ok === true;
    } catch {
      return false;
    }
  }

  /**
   * The two checks that have no container row above: Docker itself, and whether
   * the Hub is answering HTTP. Everything else is already in the service list.
   */
  async function runDiagnostics() {
    const baseUrl = await resolveHubUrl();
    const rows = [];

    try {
      const dockerAccess = await invoke('check_docker_access_command');
      if (dockerAccess?.state) {
        const stateMap = {
          available: { text: 'Ready', tone: 'ok' },
          permission_denied: { text: 'Permission denied', tone: 'bad' },
          daemon_unavailable: { text: 'Daemon stopped', tone: 'bad' },
          not_installed: { text: 'Not installed', tone: 'bad' },
          error: { text: 'Error', tone: 'bad' },
        };
        const info = stateMap[dockerAccess.state] || { text: dockerAccess.state, tone: 'muted' };
        rows.push({ label: 'Docker Engine', value: info.text, tone: info.tone, hint: 'Docker daemon access' });
      } else {
        const isAvailable = await invoke('check_docker_available');
        rows.push({
          label: 'Docker Engine',
          value: isAvailable ? 'Available' : 'Unavailable',
          tone: isAvailable ? 'ok' : 'bad',
          hint: 'Docker daemon access',
        });
      }
    } catch {
      rows.push({ label: 'Docker Engine', value: 'Check failed', tone: 'bad', hint: 'Docker daemon access' });
    }

    try {
      const live = await isHubLive(baseUrl);
      rows.push({
        label: 'Hub API',
        value: live ? 'Reachable' : 'Waiting for connection',
        tone: live ? 'ok' : 'warn',
        hint: `HTTP reachability of ${baseUrl}`,
      });
    } catch {
      rows.push({ label: 'Hub API', value: 'Unreachable', tone: 'bad', hint: `HTTP reachability of ${baseUrl}` });
    }

    checkRows = rows;
    if (checksUpdatedEl) {
      checksUpdatedEl.hidden = false;
      checksUpdatedEl.textContent = `Checks updated ${new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })}`;
    }
    renderList();
  }

  async function quickRestart() {
    setStatus('Restarting Hub...', { pin: true });
    hideActions();
    try {
      await invoke('restart_hub_command');
    } catch {
      try {
        await invoke('start_hub_command');
      } catch {
        setStatus('Could not restart Hub. Check Docker and try again.', { tone: 'error', pin: true });
        showActions();
        return;
      }
    }
    void waitForHub();
  }

  async function waitForHub() {
    const baseUrl = await resolveHubUrl();
    startedAt = Date.now();
    setStatus(elapsedStatusMessage());

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (await isHubLive(baseUrl)) {
        // The in-app StartupScreen picks the story up from here.
        setStatus('Hub is ready - loading...', { pin: true });
        window.location.replace(`${baseUrl.replace(/\/$/, '')}/`);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // Slow is not the same as broken: this one is amber, the failures are red.
    setStatus('Hub is taking longer than expected. You can retry or start it manually.', { tone: 'warn', pin: true });
    showActions();
  }

  document.getElementById('retry')?.addEventListener('click', () => {
    hideActions();
    void waitForHub();
  });

  document.getElementById('quick-restart')?.addEventListener('click', () => {
    void quickRestart();
  });

  document.getElementById('run-diagnostics')?.addEventListener('click', () => {
    void runDiagnostics();
    void pollProgress();
  });

  document.getElementById('start-hub')?.addEventListener('click', () => {
    setStatus('Starting Hub...', { pin: true });
    void invoke('start_hub_command')
      .then(() => waitForHub())
      .catch(() => {
        setStatus('Could not start Hub. Check Docker and try again.', { tone: 'error', pin: true });
        void runDiagnostics();
      });
  });

  document.getElementById('install-docker')?.addEventListener('click', () => {
    setStatus('Installing Docker...', { pin: true });
    void invoke('install_docker_command')
      .then(() => waitForHub())
      .catch(() => {
        setStatus('Docker install did not complete. Try again or install manually.', { tone: 'error', pin: true });
        void runDiagnostics();
      });
  });

  document.getElementById('open-logs')?.addEventListener('click', () => {
    void invoke('open_logs_dir_command').catch(() => undefined);
  });

  renderTitlebar();
  renderElapsed();
  setInterval(renderElapsed, 1000);
  void pollProgress();
  setInterval(() => void pollProgress(), PROGRESS_INTERVAL_MS);
  void waitForHub();
})();
