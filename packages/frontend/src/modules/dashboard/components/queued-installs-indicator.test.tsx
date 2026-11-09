import { render, screen } from '@testing-library/react';
import en from '@ci-hub/common/i18n/translations/en.json';
import enUS from '@ci-hub/common/i18n/translations/en-US.json';
import es from '@ci-hub/common/i18n/translations/es-ES.json';
import i18next from 'i18next';
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
      {i18nKey}:{String(values?.activeName ?? '')}:{String(values?.count ?? '')}
    </span>
  ),
}));

describe('install queue wording', () => {
  // i18n-provider stores every fetched language as { ...en, ...fetched }, so a language file
  // has to carry the same plural keys as en.json or the English ones win.
  it.each([
    ['en', en, '1 install waiting in queue', '2 installs waiting in queue'],
    ['en-US', enUS, '1 install waiting in queue', '2 installs waiting in queue'],
    ['es-ES', es, '1 instalación esperando en la cola', '2 instalaciones esperando en la cola'],
  ])('counts one waiting install in the singular in %s', async (lng, fetched, one, two) => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation: { ...en, ...fetched } } } });

    expect(i18n.t('INSTALL_QUEUE_WAITING_ONLY', { count: 1 })).toBe(one);
    expect(i18n.t('INSTALL_QUEUE_WAITING_ONLY', { count: 2 })).toBe(two);
  });
});

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
        isLoading={false}
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
        isLoading={false}
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
        isLoading={false}
      />,
    );

    expect(screen.getByText('Installing Plane')).toBeInTheDocument();
  });

  it('renders nothing when the queue is empty', () => {
    const { container } = render(<QueuedInstallsIndicator queue={{ active: null, queued: [] }} isLoading={false} />);

    expect(container).toBeEmptyDOMElement();
  });
});
