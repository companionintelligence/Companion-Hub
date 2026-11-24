import { locales } from '@/lib/i18n/locales';
import { fireEvent, render, screen } from '@/tests/test-utils';
import i18next from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageSelector } from './language-selector';

// Polyfill ResizeObserver for Radix UI
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const field = () => screen.getByRole('combobox');

describe('LanguageSelector', () => {
  beforeEach(() => {
    vi.spyOn(i18next, 'changeLanguage').mockResolvedValue((() => '') as never);
  });

  it('shows the saved language by its own name', () => {
    render(<LanguageSelector locale="de-DE" />);

    expect(field()).toHaveTextContent(locales['de-DE']);
  });

  it('falls back to a language of the same family when the saved one is a regional variant', () => {
    render(<LanguageSelector locale="de-AT" />);

    expect(field()).toHaveTextContent(locales['de-DE']);
  });

  it('switches the app language to the one picked and shows it', () => {
    render(<LanguageSelector locale="en-US" />);
    fireEvent.click(field());
    fireEvent.click(screen.getByRole('option', { name: locales['fr-FR'] }));

    expect(i18next.changeLanguage).toHaveBeenCalledWith('fr-FR');
    expect(field()).toHaveTextContent(locales['fr-FR']);
  });
});
