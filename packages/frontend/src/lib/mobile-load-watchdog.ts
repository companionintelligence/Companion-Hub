import { clearHubConnection, usesCloudConnect } from '@/lib/mobile-connection';

const OVERLAY_ID = 'ci-hub-mobile-load-error';
const BUDGET_MS = 6_000;

function looksLikeInteractiveUi(): boolean {
  return Boolean(
    document.querySelector('form') ||
      document.querySelector('input') ||
      document.querySelector('[data-testid="oidc-login-btn"]') ||
      document.querySelector('[data-testid="mobile-load-retry"]') ||
      document.querySelector('[data-testid="startup-switch-hub-btn"]') ||
      document.querySelector('[data-testid="login-switch-hub-btn"]'),
  );
}

/** The shell is on screen. A spinner after that is a request, not a page that never loaded. */
function appHasPainted(): boolean {
  return Boolean(document.querySelector('[data-testid="app-header"]') || document.querySelector('[data-testid="dashboard-page"]'));
}

function looksStuck(): boolean {
  if (looksLikeInteractiveUi()) return false;
  if (document.getElementById(OVERLAY_ID)) return false;
  if (appHasPainted()) return false;
  const main = document.getElementById('root');
  const text = (main?.innerText || '').trim();
  const firstLine = text.split('\n')[0] ?? '';
  if (!text || /^(loading|connecting)/i.test(firstLine)) return true;
  return Boolean(document.querySelector('[aria-busy="true"] .animate-spin, .animate-spin'));
}

function showOverlay(): void {
  if (document.getElementById(OVERLAY_ID) || looksLikeInteractiveUi()) return;

  const el = document.createElement('div');
  el.id = OVERLAY_ID;
  el.setAttribute('role', 'alert');
  Object.assign(el.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483646',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    padding: '24px',
    background: document.documentElement.classList.contains('dark') ? '#18181b' : '#f4f4f5',
    color: document.documentElement.classList.contains('dark') ? '#fafafa' : '#18181b',
    textAlign: 'center',
    font: '16px/1.4 -apple-system, sans-serif',
  });

  const title = document.createElement('p');
  title.style.fontWeight = '600';
  title.textContent = "This Hub isn't responding.";

  const hint = document.createElement('p');
  hint.style.fontSize = '14px';
  hint.style.color = '#52525b';
  hint.textContent = 'Check that the Hub is online, or switch to a different Hub.';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.dataset.testid = 'mobile-load-retry';
  retry.textContent = 'Retry';
  Object.assign(retry.style, {
    minHeight: '44px',
    minWidth: '200px',
    border: '0',
    borderRadius: '8px',
    backgroundColor: 'var(--primary)',
    color: 'var(--primary-foreground)',
    font: '16px/1.2 -apple-system, sans-serif',
    fontWeight: '600',
  });
  retry.addEventListener('click', () => window.location.reload());

  const switchHub = document.createElement('button');
  switchHub.type = 'button';
  switchHub.dataset.testid = 'mobile-load-switch-hub';
  switchHub.textContent = 'Switch Hub';
  Object.assign(switchHub.style, {
    minHeight: '44px',
    border: '0',
    background: 'transparent',
    color: '#52525b',
    textDecoration: 'underline',
    font: '14px/1.2 -apple-system, sans-serif',
  });
  switchHub.addEventListener('click', () => {
    void clearHubConnection().finally(() => window.location.assign('/connect'));
  });

  el.append(title, hint, retry, switchHub);
  document.body.appendChild(el);
}

/** Last-resort: if the phone is still on a spinner after 6s, offer Retry / Switch Hub. */
export function installMobileLoadWatchdog(): void {
  if (typeof window === 'undefined') return;
  if (!usesCloudConnect()) return;
  if ((window as Window & { __ciHubLoadWatchdog?: boolean }).__ciHubLoadWatchdog) return;
  (window as Window & { __ciHubLoadWatchdog?: boolean }).__ciHubLoadWatchdog = true;

  let sawApp = false;
  const tick = () => {
    if (sawApp) return;
    if (appHasPainted() || looksLikeInteractiveUi()) {
      sawApp = true;
      return;
    }
    if (looksStuck()) showOverlay();
  };
  globalThis.setTimeout(tick, BUDGET_MS);
  globalThis.setTimeout(tick, BUDGET_MS * 2);
}
