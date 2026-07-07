import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { QueuedInstallsIndicator } from './queued-installs-indicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'INSTALL_QUEUE_WAITING_ONLY') return `${values?.count} installs waiting in queue`;
      if (key === 'INSTALL_QUEUE_ACTIVE_ONLY') return `Installing ${values?.name}`;
      if (key === 'INSTALL_QUEUE_WAITING_NAMES') return `Waiting: ${values?.names}`;
      return key;
    },
  }),
  Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, unknown> }) => (
    <span>
      {i18nKey}:{values?.activeName}:{values?.count}
    </span>
  ),
}));

describe('QueuedInstallsIndicator', () => {
  it('renders waiting-only queue before the pipeline starts', () => {
    render(
      <QueuedInstallsIndicator
        queue={{
          active: null,
          queued: [
            { urn: 'plane:ci-marketplace', name: 'Plane' },
            { urn: 'cloudreve:ci-marketplace', name: 'Cloudreve' },
          ],
        }}
      />,
    );

    expect(screen.getByTestId('queued-installs-indicator')).toBeInTheDocument();
    expect(screen.getByText('2 installs waiting in queue')).toBeInTheDocument();
    expect(screen.getByText('Waiting: Plane, Cloudreve')).toBeInTheDocument();
  });

  it('renders active install with queued followers', () => {
    render(
      <QueuedInstallsIndicator
        queue={{
          active: { urn: 'plane:ci-marketplace', name: 'Plane' },
          queued: [{ urn: 'cloudreve:ci-marketplace', name: 'Cloudreve' }],
        }}
      />,
    );

    expect(screen.getByText('INSTALL_QUEUE_ACTIVE_AND_WAITING:Plane:1')).toBeInTheDocument();
  });

  it('renders active-only state for a single install', () => {
    render(
      <QueuedInstallsIndicator
        queue={{
          active: { urn: 'plane:ci-marketplace', name: 'Plane' },
          queued: [],
        }}
      />,
    );

    expect(screen.getByText('Installing Plane')).toBeInTheDocument();
  });

  it('renders nothing when the queue is empty', () => {
    const { container } = render(<QueuedInstallsIndicator queue={{ active: null, queued: [] }} />);

    expect(container).toBeEmptyDOMElement();
  });
});
