import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SetupPageShell } from '../setup-page-shell';

describe('SetupPageShell', () => {
  // The desktop window shows these screens while the Hub that serves the page is down, so a logo
  // loaded from the Hub (`/hub.png`) was a broken image there (CI-Hub#1935).
  it('shows a logo that comes with the page instead of one loaded from the Hub', () => {
    render(
      <SetupPageShell title="CI Hub">
        <div />
      </SetupPageShell>,
    );

    expect(screen.getByRole('img', { name: 'CI Hub logo' }).getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });
});
