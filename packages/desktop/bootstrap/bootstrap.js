/**
 * Release desktop bootstrap — shows the local Hub's state until its API answers, then
 * navigates to it. Product UI lives in the container; this page is embedded in the Tauri
 * binary only.
 *
 * This page is the FIRST half of one startup screen. The second half is StartupScreen and
 * the stopped / couldn't-start screens beside it in components/hub-status/hub-status.tsx,
 * which take over the moment the Hub API answers. They are deliberately the same screens —
 * same headings, progress bar, status panel, copy and actions — so the handover from the
 * Tauri page to React is invisible; see bootstrap.css.
 *
 * Both halves read the same `get_startup_progress_command`, a Rust-side Docker inspection
 * that works before any container is serving HTTP. It also says whether the user stopped
 * the Hub, why the last start failed, and whether Docker is usable, so this page can show
 * the right screen straight away instead of waiting for a timeout.
 */
(function bootstrap() {
  const HUB_POLL_MS = 1000;
  const PROGRESS_POLL_MS = 2000;
  /** Starting this long without the Hub answering is "hasn't finished starting". */
  const STUCK_AFTER_MS = 3 * 60 * 1000;
  /** After this long, a View logs link joins the starting screen — as in StartupScreen. */
  const LOGS_LINK_AFTER_S = 90;
  /**
   * With no start running and nothing up, the Hub is not running. Right after launch the
   * desktop app may still be about to auto-start it, so wait this long before saying so.
   */
  const NOT_RUNNING_GRACE_MS = 15 * 1000;

  const byId = (id) => document.getElementById(id);
  const el = {
    title: byId('title'),
    status: byId('status'),
    initialising: byId('initialising'),
    progress: byId('progress'),
    barFill: byId('bar-fill'),
    progressPct: byId('progress-pct'),
    progressTime: byId('progress-time'),
    panel: byId('panel'),
    facts: byId('facts'),
    rows: byId('rows'),
    panelError: byId('panel-error'),
    counts: byId('counts'),
    command: byId('command'),
    commandText: byId('command-text'),
    commandCopy: byId('command-copy'),
    actions: byId('actions'),
    startHub: byId('start-hub'),
    restartHub: byId('restart-hub'),
    keepWaiting: byId('keep-waiting'),
    tryAgain: byId('try-again'),
    installDocker: byId('install-docker'),
    copyError: byId('copy-error'),
    openLogs: byId('open-logs'),
    aside: byId('aside'),
    waiting: byId('waiting'),
  };

  function invoke(cmd, args) {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') {
      return Promise.reject(new Error('Tauri invoke unavailable'));
    }
    return internals.invoke(cmd, args);
  }

  /**
   * The OS, decided synchronously — tauri-plugin-os injects its internals into every
   * window with a js_init_script, so no IPC round trip is needed.
   */
  function osType() {
    const os = window.__TAURI_OS_PLUGIN_INTERNALS__;
    if (os?.os_type) return os.os_type;
    const agent = navigator.userAgent || '';
    if (/Mac|iPhone|iPad/.test(navigator.platform || agent)) return 'macos';
    if (/Windows/.test(agent)) return 'windows';
    return 'linux';
  }

  // ── Titlebar ──────────────────────────────────────────────────────────────
  // main.rs strips native decorations on Windows/Linux, so this page owns both
  // the drag region and the window controls — the same bar (40px, logo + name +
  // three controls) that components/titlebar/titlebar.tsx renders in the app.
  // macOS keeps its native traffic lights over the WebView and gets the 28px
  // transparent spacer titlebar.tsx uses there.

  const MAC_TITLEBAR_PX = 28;
  const TITLEBAR_PX = 40;

  function isMac() {
    return osType() === 'macos';
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

  // ── Page state ────────────────────────────────────────────────────────────

  const openedAt = Date.now();
  const page = {
    /** Last `get_startup_progress_command` result, and when it arrived. */
    progress: null,
    progressAt: 0,
    /** The screen on show: checking | starting | stuck | stopped | failed | docker. */
    view: 'checking',
    /** Start of the current wait, for the elapsed clock. */
    waitStartedAt: openedAt,
    /** When starting becomes "hasn't finished starting". Keep waiting pushes it out. */
    deadline: openedAt + STUCK_AFTER_MS,
    /** This page's own start or restart command is still running. */
    commandRunning: false,
    /** This page ran the latest start, so a failure can say how long it took. */
    startedHere: false,
    /** Rejection message from this page's own start or restart. */
    commandError: null,
    failedAfterSecs: null,
    installError: null,
    navigating: false,
  };

  // ── Formatting ────────────────────────────────────────────────────────────

  const NBSP = String.fromCharCode(0xa0);

  function clock(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }

  /** "Sep 16" and "9:25 PM" must not wrap apart. */
  function keepTogether(text) {
    return text.replace(/ /g, NBSP);
  }

  function dayOf(ms) {
    return keepTogether(new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  }

  function timeOf(ms) {
    return keepTogether(new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
  }

  function minutes(count) {
    return count === 1 ? '1 minute' : `${count} minutes`;
  }

  function errorText(error) {
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    return '';
  }

  // ── Reading the progress ──────────────────────────────────────────────────

  function coreServices(progress) {
    return Array.isArray(progress?.services) ? progress.services.filter((service) => !service.optional) : [];
  }

  /** Images are only downloading while a start is running; otherwise nothing is pulling them. */
  function downloading(progress) {
    return Boolean(progress?.start_in_progress) && typeof progress.image_total === 'number' && progress.image_pulled < progress.image_total;
  }

  /** `starting_secs` as of now, not as of the last poll. */
  function startingSecs(service) {
    return (service.starting_secs ?? 0) + Math.floor((Date.now() - page.progressAt) / 1000);
  }

  /**
   * How long the stuck service has been holding things up. A container in a restart loop
   * keeps resetting its own start time, so never report less than this page has waited.
   */
  function stuckSecs(service) {
    return Math.max(startingSecs(service), (Date.now() - page.waitStartedAt) / 1000);
  }

  /** The service that has been starting the longest. */
  function stuckService(core) {
    const starting = core.filter((service) => service.state === 'starting');
    starting.sort((a, b) => (b.starting_secs ?? 0) - (a.starting_secs ?? 0));
    return starting[0] ?? null;
  }

  function failedService(core) {
    return core.find((service) => service.state === 'failed') ?? null;
  }

  function startError(progress) {
    return page.commandError || progress?.start_error || '';
  }

  /** Everything worth pasting into a bug report about the failure. */
  function errorToCopy(progress) {
    const detail = failedService(coreServices(progress))?.detail || '';
    return [...new Set([detail, startError(progress)].filter(Boolean))].join('\n\n');
  }

  // ── Which screen ──────────────────────────────────────────────────────────

  function pickView(now) {
    const progress = page.progress;
    if (!progress) return 'checking';
    if (progress.docker_access && progress.docker_access.state !== 'available') return 'docker';

    const core = coreServices(progress);
    const startRunning = page.commandRunning || progress.start_in_progress;
    if (!startRunning && (startError(progress) || failedService(core))) return 'failed';
    if (!startRunning) {
      if (progress.user_stopped) return 'stopped';
      const nothingUp = core.length > 0 && core.every((service) => ['stopped', 'pending', 'not_started'].includes(service.state));
      if (nothingUp && now - openedAt >= NOT_RUNNING_GRACE_MS) return 'stopped';
    }

    // A long first download is not "stuck": give the services their three minutes after it.
    if (downloading(progress)) page.deadline = Math.max(page.deadline, now + STUCK_AFTER_MS);
    return now >= page.deadline ? 'stuck' : 'starting';
  }

  function restartClock(now) {
    page.waitStartedAt = now;
    page.deadline = now + STUCK_AFTER_MS;
  }

  function enterView(view, now) {
    const previous = page.view;
    if (view === previous) return;
    // Started from somewhere else (the tray, the watchdog, Docker coming back): a new wait.
    if (view === 'starting' && ['stopped', 'failed', 'docker'].includes(previous)) restartClock(now);
    if (view === 'failed' && page.startedHere && page.failedAfterSecs === null) {
      page.failedAfterSecs = (now - page.waitStartedAt) / 1000;
    }
    if (view === 'stopped') page.startedHere = false;
    page.view = view;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  const SERVICE_PHRASE = {
    'ci-hub-db': 'the database',
    'ci-hub-queue': 'the message queue',
    'ci-hub': 'the Hub backend',
    traefik: 'the router',
  };

  const STATE_LABEL = {
    pending: 'Waiting',
    starting: 'Starting',
    ready: 'Ready',
    failed: 'Failed',
    stopped: 'Stopped',
    not_started: 'Not started',
  };

  const STATE_MARK = {
    pending: 'waiting',
    starting: 'starting',
    ready: 'ready',
    failed: 'failed',
    stopped: 'stopped',
    not_started: 'not-started',
  };

  const STATE_TONE = {
    pending: 'tone-muted',
    starting: 'tone-warn',
    ready: 'tone-ok',
    failed: 'tone-bad',
    stopped: 'tone-muted',
    not_started: 'tone-muted',
  };

  const DOCKER_FACT = {
    available: ['Running', ''],
    daemon_unavailable: ['Not running', 'tone-bad'],
    not_installed: ['Not installed', 'tone-bad'],
    permission_denied: ['No permission', 'tone-bad'],
    error: ['Unreachable', 'tone-bad'],
  };

  /** Always shown, zero or not. Stopped and Not started join only when they happen. */
  const COUNTS = [
    ['ready', 'Ready'],
    ['starting', 'Starting'],
    ['pending', 'Waiting'],
    ['failed', 'Failed'],
  ];
  const OCCASIONAL_COUNTS = [
    ['stopped', 'Stopped'],
    ['not_started', 'Not started'],
  ];

  /** Only touch text that changed: #status is a live region, and this runs every second. */
  function setText(node, content) {
    if (node.textContent !== content) node.textContent = content;
  }

  function textNode(tag, content, className) {
    const node = document.createElement(tag);
    node.textContent = content;
    if (className) node.className = className;
    return node;
  }

  /**
   * One SVG, so the dot stays centred in the ring. Drawn as a bordered box with an inset
   * dot, each box was rounded to device pixels separately, and with desktop text scaling
   * the dot sat off centre.
   */
  const STARTING_MARK =
    '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5" /><circle class="mark-pulse" cx="5" cy="5" r="1.5" fill="currentColor" /></svg>';

  function mark(state) {
    const kind = STATE_MARK[state] ?? 'waiting';
    const node = document.createElement('span');
    node.className = `mark mark-${kind}`;
    node.setAttribute('aria-hidden', 'true');
    if (kind === 'starting') node.innerHTML = STARTING_MARK;
    return node;
  }

  function dockerHead(access) {
    switch (access?.state) {
      case 'not_installed':
        return ["Docker isn't installed", 'CI Hub runs on Docker. Install it and CI Hub will carry on from here.'];
      case 'permission_denied':
        return ["CI Hub can't use Docker", "Your account isn't allowed to use Docker. Add it to the docker group, then log out and back in."];
      case 'error':
        return ["CI Hub can't reach Docker", access.detail || "Docker didn't answer. Check that it's running."];
      default:
        return [
          "Docker isn't running",
          osType() === 'linux'
            ? 'CI Hub runs on Docker. Start Docker and CI Hub will carry on from here.'
            : 'CI Hub runs on Docker. Open Docker Desktop and CI Hub will carry on from here.',
        ];
    }
  }

  function headFor(view, progress, core, elapsed) {
    switch (view) {
      case 'checking':
        return ['Checking CI Hub', "Looking at Docker and the Hub's services…"];
      case 'docker':
        return dockerHead(progress.docker_access);
      case 'failed': {
        const failed = failedService(core);
        if (!failed) return ["CI Hub couldn't start", "CI Hub won't retry on its own until you try again."];
        const phrase = SERVICE_PHRASE[failed.container] ?? `the ${failed.label.toLowerCase()}`;
        return ["CI Hub couldn't start", `Docker couldn't start ${phrase}. CI Hub won't retry on its own.`];
      }
      case 'stopped': {
        if (!progress.user_stopped) return ["CI Hub isn't running", 'Start it to use CI Hub and your apps.'];
        const at = progress.user_stopped_at_ms;
        const when = at ? ` on ${dayOf(at)} at ${timeOf(at)}` : '';
        return ['CI Hub is stopped', `You stopped it${when}. It stays stopped until you start it again.`];
      }
      case 'stuck': {
        const service = stuckService(core);
        const waited = Math.max(1, Math.floor((service ? stuckSecs(service) : elapsed) / 60));
        return [
          "CI Hub hasn't finished starting",
          `${service ? service.label : 'CI Hub'} has been starting for ${minutes(waited)}. Restarting the Hub often clears this.`,
        ];
      }
      default:
        return [
          'Starting CI Hub',
          downloading(progress)
            ? 'Downloading what CI Hub needs. The first start after an install or update can take a few minutes.'
            : 'Services are coming online…',
        ];
    }
  }

  function timeFor(view, progress, elapsed) {
    if (view === 'stopped') {
      const at = progress.user_stopped ? progress.user_stopped_at_ms : null;
      return at ? `Stopped since ${dayOf(at)}, ${timeOf(at)}` : 'Not running';
    }
    if (view === 'failed') {
      if (page.failedAfterSecs !== null) return `Failed after ${clock(page.failedAfterSecs)}`;
      return progress.start_failed_at_ms ? `Failed at ${timeOf(progress.start_failed_at_ms)}` : 'Failed';
    }
    return `${clock(elapsed)} elapsed`;
  }

  function renderProgress(view, progress, elapsed) {
    const pct = Math.min(100, Math.max(0, Number(progress.progress_pct) || 0));
    const shown = view === 'stopped' ? 0 : pct;
    const moving = view === 'starting' || view === 'stuck';
    el.barFill.style.width = `${moving ? Math.max(shown, 4) : shown}%`;
    setText(el.progressPct, `${shown}%`);
    setText(el.progressTime, timeFor(view, progress, elapsed));
  }

  function fact(term, value, tone) {
    const group = document.createElement('div');
    group.className = 'fact';
    group.append(textNode('dt', term), textNode('dd', value, tone));
    return group;
  }

  function renderFacts(view, progress) {
    const images = view === 'docker' ? '—' : `${progress.image_pulled} of ${progress.image_total} (${progress.image_pull_pct}%)`;
    const [docker, dockerTone] = DOCKER_FACT[progress.docker_access?.state ?? 'available'] ?? DOCKER_FACT.error;
    let api = ['Not running', ''];
    if (progress.hub_api_live) api = ['Answering', ''];
    else if (view === 'stuck') api = ['Not answering', 'tone-warn'];
    else if (view === 'starting') api = ['Not answering yet', ''];
    const signature = [images, docker, dockerTone, api[0], api[1]].join('\n');
    // The clock ticks every second. Rebuilding the facts then throws away a
    // selection in the error text beside them, so only rebuild when a value changes.
    if (el.facts.dataset.signature === signature) return;
    el.facts.dataset.signature = signature;
    el.facts.replaceChildren(fact('Images pulled', images), fact('Docker', docker, dockerTone), fact('Hub API', ...api));
  }

  function serviceRow(service, stuck) {
    const row = document.createElement('div');
    row.className = 'row';
    if (stuck) row.classList.add('row-attn');
    if (service.state === 'failed') row.classList.add('row-fail');

    const name = document.createElement('div');
    name.className = 'row-name';
    name.title = service.container;
    name.append(mark(service.state), textNode('span', service.label));

    const label = stuck ? `Starting for ${clock(stuckSecs(service))}` : (STATE_LABEL[service.state] ?? service.state);
    const main = document.createElement('div');
    main.className = 'row-main';
    main.append(name, textNode('span', label, `state ${STATE_TONE[service.state] ?? 'tone-muted'}`));
    row.append(main);

    if (service.state === 'failed' && service.detail) row.append(textNode('p', service.detail, 'row-detail'));
    return row;
  }

  function dockerStatusNote() {
    return page.installError ? `Docker install didn't finish. ${page.installError}` : 'Service status shows here once Docker is running.';
  }

  /** Structure of the status rows, without the elapsed clock that ticks every second. */
  function rowsSignature(view, core) {
    if (view === 'docker') return `docker\n${dockerStatusNote()}`;
    const stuckId = view === 'stuck' ? (stuckService(core)?.container ?? '') : '';
    const body = core.map((service) => `${service.container}\t${service.state}\t${service.detail || ''}`).join('\n');
    return `${view}\n${stuckId}\n${body}`;
  }

  function refreshRowClocks(view, core) {
    if (view !== 'stuck') return;
    const stuck = stuckService(core);
    const labels = el.rows.querySelectorAll('.row-main > .state');
    core.forEach((service, index) => {
      const label = service === stuck ? `Starting for ${clock(stuckSecs(service))}` : (STATE_LABEL[service.state] ?? service.state);
      const node = labels[index];
      if (node) setText(node, label);
    });
  }

  function renderRows(view, progress, core) {
    const signature = rowsSignature(view, core);
    if (el.rows.dataset.signature === signature) {
      refreshRowClocks(view, core);
    } else {
      el.rows.dataset.signature = signature;
      if (view === 'docker') {
        el.rows.replaceChildren(textNode('p', dockerStatusNote(), 'rows-note'));
      } else {
        const stuck = view === 'stuck' ? stuckService(core) : null;
        el.rows.replaceChildren(...core.map((service) => serviceRow(service, service === stuck)));
      }
    }

    // A failure no service row can carry, e.g. Docker refusing the compose file.
    const failedRowHasDetail = Boolean(failedService(core)?.detail);
    const panelError = view === 'failed' && !failedRowHasDetail ? startError(progress) : '';
    setText(el.panelError, panelError);
    el.panelError.hidden = !panelError;
  }

  function renderCounts(view, core) {
    const tally = (state) => core.filter((service) => service.state === state).length;
    const items = COUNTS.map(([state, label]) => [state, view === 'docker' ? '—' : tally(state), label]);
    if (view !== 'docker') {
      for (const [state, label] of OCCASIONAL_COUNTS) {
        const count = tally(state);
        if (count > 0) items.push([state, count, label]);
      }
    }
    const signature = items.map(([state, count, label]) => `${state}:${count}:${label}`).join('\n');
    if (el.counts.dataset.signature === signature) return;
    el.counts.dataset.signature = signature;
    el.counts.replaceChildren(
      ...items.map(([state, count, label]) => {
        const node = document.createElement('span');
        node.className = count === 0 || count === '—' ? 'count count-zero' : 'count';
        node.append(mark(state), textNode('span', String(count), 'count-n'), document.createTextNode(` ${label}`));
        return node;
      }),
    );
  }

  function dockerCommand(access) {
    if (osType() !== 'linux') return '';
    if (access === 'daemon_unavailable') return 'sudo systemctl start docker';
    if (access === 'permission_denied') return 'sudo usermod -aG docker $USER';
    return '';
  }

  function renderActions(view, progress, elapsed) {
    const access = progress?.docker_access?.state;
    const command = view === 'docker' ? dockerCommand(access) : '';
    el.command.hidden = !command;
    el.commandText.textContent = command;

    const shown = {
      startHub: view === 'stopped',
      restartHub: view === 'stuck',
      keepWaiting: view === 'stuck',
      tryAgain: view === 'failed',
      installDocker: view === 'docker' && access === 'not_installed',
      copyError: view === 'failed' && Boolean(errorToCopy(progress)),
      openLogs: view === 'stuck' || view === 'failed' || (view === 'starting' && elapsed > LOGS_LINK_AFTER_S),
    };
    for (const [key, visible] of Object.entries(shown)) el[key].hidden = !visible;
    el.actions.hidden = !Object.values(shown).some(Boolean);
    el.aside.hidden = view !== 'stopped';
    el.waiting.hidden = view !== 'docker';
  }

  function render() {
    if (page.navigating) return;
    const now = Date.now();
    const view = pickView(now);
    enterView(view, now);

    const progress = page.progress;
    const core = coreServices(progress);
    const elapsed = (now - page.waitStartedAt) / 1000;

    const [title, line] = headFor(view, progress, core, elapsed);
    setText(el.title, title);
    setText(el.status, line);

    const checking = view === 'checking';
    el.initialising.hidden = !checking;
    el.progress.hidden = checking;
    el.panel.hidden = checking;
    if (!checking) {
      renderProgress(view, progress, elapsed);
      renderFacts(view, progress);
      renderRows(view, progress, core);
      renderCounts(view, core);
    }
    renderActions(view, progress, elapsed);
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  async function pollProgress() {
    try {
      const progress = await invoke('get_startup_progress_command');
      // A start from somewhere else supersedes this page's last failed attempt.
      if (progress?.start_in_progress && !page.commandRunning) page.commandError = null;
      page.progress = progress;
      page.progressAt = Date.now();
    } catch {
      // Docker or the shell not answering this once: keep showing the last known state.
    }
    render();
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
      return (await invoke('check_hub_status', { url: baseUrl })) === true;
    } catch {
      return false;
    }
  }

  async function watchHub() {
    const baseUrl = await resolveHubUrl();
    for (;;) {
      if (await isHubLive(baseUrl)) {
        // The in-app StartupScreen picks the story up from here.
        page.navigating = true;
        el.title.textContent = 'CI Hub is ready';
        el.status.textContent = 'Opening CI Hub…';
        window.location.replace(`${baseUrl.replace(/\/$/, '')}/`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, HUB_POLL_MS));
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /** Start or restart, switching to the starting screen at once: no button lingers. */
  async function runStart(command) {
    const now = Date.now();
    page.commandRunning = true;
    page.startedHere = true;
    page.commandError = null;
    page.failedAfterSecs = null;
    restartClock(now);
    page.view = 'starting';
    render();
    try {
      await invoke(command);
    } catch (error) {
      page.commandError = errorText(error) || "The Hub didn't start.";
      page.failedAfterSecs = (Date.now() - page.waitStartedAt) / 1000;
    } finally {
      page.commandRunning = false;
      void pollProgress();
    }
  }

  async function installDocker() {
    const label = el.installDocker.textContent;
    el.installDocker.disabled = true;
    el.installDocker.textContent = 'Installing Docker…';
    page.installError = null;
    try {
      await invoke('install_docker_command');
    } catch (error) {
      page.installError = errorText(error) || 'Try again, or install Docker yourself.';
    } finally {
      el.installDocker.disabled = false;
      el.installDocker.textContent = label;
      void pollProgress();
    }
  }

  function copyWithTextarea(value) {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }

  async function copyText(value, button) {
    if (!value) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch {
      copied = copyWithTextarea(value);
    }
    if (!copied) return;
    button.dataset.label ??= button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = button.dataset.label;
    }, 2000);
  }

  el.startHub.addEventListener('click', () => void runStart('start_hub_command'));
  el.tryAgain.addEventListener('click', () => void runStart('start_hub_command'));
  el.restartHub.addEventListener('click', () => void runStart('restart_hub_command'));
  el.keepWaiting.addEventListener('click', () => {
    page.deadline = Date.now() + STUCK_AFTER_MS;
    render();
  });
  el.installDocker.addEventListener('click', () => void installDocker());
  el.copyError.addEventListener('click', () => void copyText(errorToCopy(page.progress), el.copyError));
  el.commandCopy.addEventListener('click', () => void copyText(el.commandText.textContent, el.commandCopy));
  el.openLogs.addEventListener('click', () => {
    void invoke('open_logs_dir_command').catch(() => undefined);
  });

  renderTitlebar();
  render();
  setInterval(render, 1000);
  void pollProgress();
  setInterval(() => void pollProgress(), PROGRESS_POLL_MS);
  void watchHub();
})();
