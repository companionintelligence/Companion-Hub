import en from '@ci-hub/common/i18n/translations/en.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/Dialog';
import { render, screen, userEvent, waitFor } from '@/tests/test-utils';
import { Titlebar } from './titlebar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => (en as Record<string, string>)[key] ?? key }),
}));

const appWindow = vi.hoisted(() => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ ...appWindow, isMaximized: async () => false, onResized: async () => () => {} }),
}));

/** Every translation file's text, by path. */
const TRANSLATIONS = import.meta.glob<string>('../../../../common/i18n/translations/*.json', { eager: true, query: '?raw', import: 'default' });

describe('Titlebar', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    Object.defineProperty(window, '__TAURI_OS_PLUGIN_INTERNALS__', { value: { os_type: 'linux' }, configurable: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    Reflect.deleteProperty(window, '__TAURI_OS_PLUGIN_INTERNALS__');
    vi.clearAllMocks();
  });

  it('names the app as the desktop app, its update notices and the Desktop app card do', () => {
    render(<Titlebar />);

    expect(screen.getByText('Companion Hub')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Companion Hub' })).toBeInTheDocument();
  });

  it.each([
    ['Linux and Windows', 'linux', '40px'],
    ['macOS', 'macos', '28px'],
  ])('is drawn exactly as tall as --titlebar-height says on %s', async (_shell, osType, height) => {
    Object.defineProperty(window, '__TAURI_OS_PLUGIN_INTERNALS__', { value: { os_type: osType }, configurable: true });
    const { container } = render(<Titlebar />);

    // The header, dialogs and the page are placed by --titlebar-height. A bar sized by a rem class
    // (h-10, 42.5px at the 17px root) came out taller, and every page ran past the window.
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--titlebar-height')).toBe(height));
    const bar = container.firstElementChild as HTMLElement;
    expect(bar.style.height).toBe(height);
    expect(bar.className).not.toMatch(/\bh-\d/);
  });

  it('calls the app Companion Hub in every language, never CI Hub or CI-Hub', () => {
    const files = Object.entries(TRANSLATIONS);
    expect(files.length).toBeGreaterThan(1);

    for (const [file, text] of files) {
      const strings = JSON.parse(text) as Record<string, string>;
      expect({ file, appName: strings.APP_NAME }).toEqual({ file, appName: 'Companion Hub' });
      // Only what people read: the values. Commands like `cihub pool pair` keep their name.
      const oldName = Object.entries(strings).filter(([, value]) => /\bCI[ -]Hub\b/.test(value));
      expect({ file, oldName }).toEqual({ file, oldName: [] });
    }
  });

  describe('while a dialog is open', () => {
    /** The bar beside an open modal dialog, as in the app: Radix sets `pointer-events: none` on <body>. */
    async function renderWithOpenDialog() {
      const onOpenChange = vi.fn();
      render(
        <>
          <Titlebar />
          <Dialog open onOpenChange={onOpenChange}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Update wordpress config</DialogTitle>
            </DialogContent>
          </Dialog>
        </>,
      );
      // The window buttons wait for the window handle. The open dialog hides the rest of the page from
      // the accessibility tree, so look them up by label.
      await waitFor(() => expect(screen.getByLabelText('Minimize window')).toBeVisible());
      await waitFor(() => expect(document.body.style.pointerEvents).toBe('none'));
      return { onOpenChange };
    }

    it('still minimizes, maximizes and closes the window, and leaves the dialog open', async () => {
      const { onOpenChange } = await renderWithOpenDialog();

      // user-event refuses to press an element that has or inherits `pointer-events: none`.
      await userEvent.click(screen.getByLabelText('Minimize window'));
      await userEvent.click(screen.getByLabelText('Maximize window'));
      await userEvent.click(screen.getByLabelText('Close window'));

      expect(appWindow.minimize).toHaveBeenCalledOnce();
      expect(appWindow.toggleMaximize).toHaveBeenCalledOnce();
      expect(appWindow.close).toHaveBeenCalledOnce();
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('lets a press on the drag region reach the window drag and leaves the dialog open', async () => {
      const { onOpenChange } = await renderWithOpenDialog();
      // Tauri's injected drag script listens for `mousedown` on the document.
      const mousedowns: EventTarget[] = [];
      const onMouseDown = (event: MouseEvent) => mousedowns.push(event.target as EventTarget);
      document.addEventListener('mousedown', onMouseDown);
      const dragRegion = screen.getByText('Companion Hub').parentElement as HTMLElement;
      expect(dragRegion).toHaveAttribute('data-tauri-drag-region');

      await userEvent.pointer({ keys: '[MouseLeft]', target: dragRegion });
      document.removeEventListener('mousedown', onMouseDown);

      expect(mousedowns).toEqual([dragRegion]);
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('still closes the dialog on a press outside it that is not on the bar', async () => {
      const { onOpenChange } = await renderWithOpenDialog();
      const overlay = document.querySelector('[data-state="open"]:not([role="dialog"])') as HTMLElement;

      await userEvent.click(overlay);

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
