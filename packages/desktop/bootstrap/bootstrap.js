/**
 * Release desktop bootstrap — polls the local Hub stack, then navigates to it.
 * Product UI lives in the container; this page is embedded in the Tauri binary only.
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

  function setStatus(message, { error = false } = {}) {
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.classList.toggle('error', error);
    }
  }

  function showActions() {
    actionsEl?.classList.add('visible');
    spinnerEl?.style.setProperty('display', 'none');
    void runDiagnostics();
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
          available: { text: 'Ready', class: 'diag-ok' },
          permission_denied: { text: 'Permission Denied', class: 'diag-error' },
          daemon_unavailable: { text: 'Daemon Stopped', class: 'diag-error' },
          not_installed: { text: 'Not Installed', class: 'diag-warn' },
          error: { text: 'Error', class: 'diag-error' },
        };
        const info = stateMap[dockerAccess.state] || { text: dockerAccess.state, class: 'diag-info' };
        rows.push({ label: 'Docker Engine', value: info.text, class: info.class });
      } else {
        const isAvailable = await invoke('check_docker_available');
        rows.push({
          label: 'Docker Engine',
          value: isAvailable ? 'Available' : 'Unavailable',
          class: isAvailable ? 'diag-ok' : 'diag-warn',
        });
      }
    } catch {
      rows.push({ label: 'Docker Engine', value: 'Check failed', class: 'diag-error' });
    }

    // 2. Hub Backend Reachability
    try {
      const live = await isHubLive(baseUrl);
      rows.push({
        label: 'Hub Backend',
        value: live ? 'Reachable' : 'Waiting for connection',
        class: live ? 'diag-ok' : 'diag-warn',
      });
    } catch {
      rows.push({ label: 'Hub Backend', value: 'Unreachable', class: 'diag-error' });
    }

    // 3. Hub Container Status
    try {
      const hubStatus = await invoke('get_hub_status_command');
      let statusText = 'Unknown';
      let statusClass = 'diag-info';
      if (hubStatus === 'Running') {
        statusText = 'Running';
        statusClass = 'diag-ok';
      } else if (hubStatus === 'Starting') {
        statusText = 'Starting…';
        statusClass = 'diag-warn';
      } else if (hubStatus === 'Stopped') {
        statusText = 'Stopped';
        statusClass = 'diag-info';
      } else if (hubStatus === 'DockerNotAvailable') {
        statusText = 'Docker unavailable';
        statusClass = 'diag-error';
      } else if (typeof hubStatus === 'object' && hubStatus !== null && hubStatus.Error) {
        statusText = hubStatus.Error.message || 'Error';
        statusClass = 'diag-error';
      }
      rows.push({ label: 'Hub Containers', value: statusText, class: statusClass });
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
          class: progress.all_ready ? 'diag-ok' : 'diag-info',
        });
      }
    } catch {
      // Progress not yet available
    }

    if (diagnosticsGridEl) {
      diagnosticsGridEl.innerHTML = rows
        .map((r) => `<div class="diag-row"><span class="diag-label">${r.label}</span><span class="diag-value ${r.class}">${r.value}</span></div>`)
        .join('');
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
    actionsEl?.classList.remove('visible');
    spinnerEl?.style.removeProperty('display');
    try {
      await invoke('restart_hub_command');
    } catch {
      try {
        await invoke('start_hub_command');
      } catch {
        setStatus('Could not restart Hub. Check Docker and try again.', { error: true });
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

    setStatus('Hub is taking longer than expected. You can retry or start it manually.', { error: true });
    showActions();
  }

  document.getElementById('retry')?.addEventListener('click', () => {
    actionsEl?.classList.remove('visible');
    spinnerEl?.style.removeProperty('display');
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
        setStatus('Could not start Hub. Check Docker and try again.', { error: true });
        void runDiagnostics();
      });
  });

  document.getElementById('install-docker')?.addEventListener('click', () => {
    setStatus('Installing Docker…');
    void invoke('install_docker_command')
      .then(() => waitForHub())
      .catch(() => {
        setStatus('Docker install did not complete. Try again or install manually.', { error: true });
        void runDiagnostics();
      });
  });

  document.getElementById('open-logs')?.addEventListener('click', () => {
    void invoke('open_logs_dir_command').catch(() => undefined);
  });

  void waitForHub();
})();
