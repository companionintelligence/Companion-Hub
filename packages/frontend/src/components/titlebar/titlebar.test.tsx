import en from '@ci-hub/common/i18n/translations/en.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/tests/test-utils';
import { Titlebar } from './titlebar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => (en as Record<string, string>)[key] ?? key }),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ isMaximized: async () => false, onResized: async () => () => {} }),
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
  });

  it('names the app as the desktop app, its update notices and the Desktop app card do', () => {
    render(<Titlebar />);

    expect(screen.getByText('Companion Hub')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Companion Hub' })).toBeInTheDocument();
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
});
