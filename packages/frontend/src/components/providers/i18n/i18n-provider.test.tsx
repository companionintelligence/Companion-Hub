import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from './i18n-provider';

describe('I18nProvider', () => {
  it('renders children immediately instead of a Loading… gate', () => {
    render(
      <I18nProvider>
        <span>ready-child</span>
      </I18nProvider>,
    );

    expect(screen.getByText('ready-child')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });
});
