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

  document.getElementById('start-hub')?.addEventListener('click', () => {
    setStatus('Starting Hub…');
    void invoke('start_hub_command')
      .then(() => waitForHub())
      .catch(() => setStatus('Could not start Hub. Check Docker and try again.', { error: true }));
  });

  document.getElementById('install-docker')?.addEventListener('click', () => {
    setStatus('Installing Docker…');
    void invoke('install_docker_command')
      .then(() => waitForHub())
      .catch(() => setStatus('Docker install did not complete. Try again or install manually.', { error: true }));
  });

  document.getElementById('open-logs')?.addEventListener('click', () => {
    void invoke('open_logs_dir_command').catch(() => undefined);
  });

  void waitForHub();
})();
