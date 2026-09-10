/**
 * Release desktop bootstrap — polls the local Hub stack, then navigates to it.
 * Product UI lives in the container; this page is embedded in the Tauri binary only.
 *
 * Presentation deliberately tracks the Hub frontend (see bootstrap.css): this is
 * the first window a user sees, and it should not look like a different product
 * from the login screen it hands over to.
 */
(function bootstrap() {
  const POLL_INTERVAL_MS = 1000;
  const MAX_ATTEMPTS = 180;

  const statusEl = document.getElementById('status');
  const spinnerEl = document.getElementById('spinner');
  const actionsEl = document.getElementById('actions');
  const diagnosticsCardEl = document.getElementById('diagnostics-card');
  const diagnosticsGridEl = document.getElementById('diagnostics-grid');
  const diagnosticsUpdatedEl = document.getElementById('diagnostics-updated');

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

  function setStatus(message, { tone = 'muted' } = {}) {
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.classList.toggle('warn', tone === 'warn');
      statusEl.classList.toggle('error', tone === 'error');
    }
  }

  function showActions() {
    actionsEl?.classList.add('visible');
    spinnerEl?.style.setProperty('display', 'none');
    // Tells the stylesheet this is the tall recovery state (see bootstrap.css).
    document.body.classList.add('expanded');
    void runDiagnostics();
  }

  function hideActions() {
    actionsEl?.classList.remove('visible');
    spinnerEl?.style.removeProperty('display');
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

  async function runDiagnostics() {
    const baseUrl = await resolveHubUrl();
    const rows = [];

    // 1. Docker Engine Access
    try {
      const dockerAccess = await invoke('check_docker_access_command');
      if (dockerAccess?.state) {
        const stateMap = {
          available: { text: 'Ready', tone: 'ok' },
          permission_denied: { text: 'Permission denied', tone: 'bad' },
          daemon_unavailable: { text: 'Daemon stopped', tone: 'bad' },
          not_installed: { text: 'Not installed', tone: 'warn' },
          error: { text: 'Error', tone: 'bad' },
        };
        const info = stateMap[dockerAccess.state] || { text: dockerAccess.state, tone: 'muted' };
        rows.push({ label: 'Docker Engine', value: info.text, tone: info.tone });
      } else {
        const isAvailable = await invoke('check_docker_available');
        rows.push({
          label: 'Docker Engine',
          value: isAvailable ? 'Available' : 'Unavailable',
          tone: isAvailable ? 'ok' : 'warn',
        });
      }
    } catch {
      rows.push({ label: 'Docker Engine', value: 'Check failed', tone: 'bad' });
    }

    // 2. Hub Backend Reachability
    try {
      const live = await isHubLive(baseUrl);
      rows.push({
        label: 'Hub Backend',
        value: live ? 'Reachable' : 'Waiting for connection',
        tone: live ? 'ok' : 'warn',
      });
    } catch {
      rows.push({ label: 'Hub Backend', value: 'Unreachable', tone: 'bad' });
    }

    // 3. Hub Container Status
    try {
      const hubStatus = await invoke('get_hub_status_command');
      let statusText = 'Unknown';
      let statusTone = 'muted';
      if (hubStatus === 'Running') {
        statusText = 'Running';
        statusTone = 'ok';
      } else if (hubStatus === 'Starting') {
        statusText = 'Starting…';
        statusTone = 'warn';
      } else if (hubStatus === 'Stopped') {
        statusText = 'Stopped';
        statusTone = 'muted';
      } else if (hubStatus === 'DockerNotAvailable') {
        statusText = 'Docker unavailable';
        statusTone = 'bad';
      } else if (typeof hubStatus === 'object' && hubStatus !== null && hubStatus.Error) {
        statusText = hubStatus.Error.message || 'Error';
        statusTone = 'bad';
      }
      rows.push({ label: 'Hub Containers', value: statusText, tone: statusTone });
    } catch {
      // get_hub_status_command may not be available if container is initializing
    }

    // 4. Startup progress if available
    try {
      const progress = await invoke('get_startup_progress_command');
      if (progress && typeof progress.progress_pct === 'number') {
        rows.push({
          label: 'Startup Progress',
          value: `${progress.progress_pct}%`,
          tone: progress.all_ready ? 'ok' : 'muted',
        });
      }
    } catch {
      // Progress not yet available
    }

    if (diagnosticsGridEl) {
      // Built as nodes, not innerHTML: a container status row can carry a raw
      // Docker error message, and `<` in one of those used to eat the rest of
      // the panel.
      diagnosticsGridEl.replaceChildren(
        ...rows.map((row) => {
          const line = document.createElement('div');
          line.className = 'diag-row';

          const label = document.createElement('span');
          label.className = 'diag-label';
          label.textContent = row.label;

          const value = document.createElement('span');
          value.className = `diag-value tone-${row.tone}`;
          value.title = row.value;
          const dot = document.createElement('span');
          dot.className = 'dot';
          const text = document.createElement('span');
          text.className = 'diag-text';
          text.textContent = row.value;
          value.append(dot, text);

          line.append(label, value);
          return line;
        }),
      );
    }
    if (diagnosticsUpdatedEl) {
      diagnosticsUpdatedEl.textContent = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
    if (diagnosticsCardEl) {
      diagnosticsCardEl.classList.add('visible');
    }
  }

  async function quickRestart() {
    setStatus('Restarting Hub…');
    hideActions();
    try {
      await invoke('restart_hub_command');
    } catch {
      try {
        await invoke('start_hub_command');
      } catch {
        setStatus('Could not restart Hub. Check Docker and try again.', { tone: 'error' });
        showActions();
        void runDiagnostics();
        return;
      }
    }
    void waitForHub();
  }

  async function waitForHub() {
    const baseUrl = await resolveHubUrl();
    setStatus('Starting your Hub…');

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (await isHubLive(baseUrl)) {
        setStatus('Hub is ready — loading…');
        window.location.replace(`${baseUrl.replace(/\/$/, '')}/`);
        return;
      }

      if (attempt > 0 && attempt % 15 === 0) {
        setStatus('Still starting your Hub…');
        if (diagnosticsCardEl?.classList.contains('visible')) {
          void runDiagnostics();
        }
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // Slow is not the same as broken: this one is amber, the failures below are red.
    setStatus('Hub is taking longer than expected. You can retry or start it manually.', { tone: 'warn' });
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
  });

  document.getElementById('start-hub')?.addEventListener('click', () => {
    setStatus('Starting Hub…');
    void invoke('start_hub_command')
      .then(() => waitForHub())
      .catch(() => {
        setStatus('Could not start Hub. Check Docker and try again.', { tone: 'error' });
        void runDiagnostics();
      });
  });

  document.getElementById('install-docker')?.addEventListener('click', () => {
    setStatus('Installing Docker…');
    void invoke('install_docker_command')
      .then(() => waitForHub())
      .catch(() => {
        setStatus('Docker install did not complete. Try again or install manually.', { tone: 'error' });
        void runDiagnostics();
      });
  });

  document.getElementById('open-logs')?.addEventListener('click', () => {
    void invoke('open_logs_dir_command').catch(() => undefined);
  });

  renderTitlebar();
  void waitForHub();
})();
