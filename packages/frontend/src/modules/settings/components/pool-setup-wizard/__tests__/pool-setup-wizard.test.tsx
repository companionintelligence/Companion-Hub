import { candidate, incomingPeer, poolPeer, poolStatus, poolWith, tailscaleStatus, waitingPeer } from '@/tests/pool-fixtures';
import { sdkFail, sdkOk } from '@/tests/sdk-mock-helpers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoverablePoolPeer, PoolStatus } from '../../../helpers/hub-pool-shared';
import { usePairingBatch } from '../pool-setup-hooks';
import type { TailscaleSetupStatus } from '../pool-setup-model';
import { PoolSetupWizard } from '../pool-setup-wizard';

const fixtures = vi.hoisted(() => ({
  pool: null as unknown as PoolStatus,
  poolFails: false,
  poolReads: 0,
  /** Pool reads after this many are held until `release` is called. `null` holds nothing. */
  holdPoolReadsAfter: null as number | null,
  release: null as null | (() => void),
  ts: null as unknown as TailscaleSetupStatus,
  tsFails: false,
  tsHangs: false,
  tsReads: 0,
  discoverable: [] as DiscoverablePoolPeer[],
  demo: false,
  appTailscaleAvailable: true,
  listDiscoverable: vi.fn(),
  pairPeer: vi.fn(),
  approvePeer: vi.fn(),
  rejectPeer: vi.fn(),
  removePeer: vi.fn(),
  updatePoolSettings: vi.fn(),
  startAuth: vi.fn(),
  openExternal: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: fixtures.toast }));
vi.mock('@/lib/hooks/use-demo-mode', () => ({ useDemoMode: () => fixtures.demo }));
vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({ tailscaleAvailable: fixtures.appTailscaleAvailable, userSettings: { demoMode: fixtures.demo } }),
}));
vi.mock('@/lib/helpers/open-external', () => ({ openExternal: (url: string) => fixtures.openExternal(url) }));
vi.mock('@/api-client/sdk.gen', () => ({
  listDiscoverable: (...args: unknown[]) => fixtures.listDiscoverable(...args),
  pairPeer: (...args: unknown[]) => fixtures.pairPeer(...args),
  approvePeer: (...args: unknown[]) => fixtures.approvePeer(...args),
  rejectPeer: (...args: unknown[]) => fixtures.rejectPeer(...args),
  removePeer: (...args: unknown[]) => fixtures.removePeer(...args),
  updatePoolSettings: (...args: unknown[]) => fixtures.updatePoolSettings(...args),
  startAuth: (...args: unknown[]) => fixtures.startAuth(...args),
  syncExposure: vi.fn().mockResolvedValue({ data: {}, response: { ok: true } }),
}));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  appContextQueryKey: () => ['app-context'],
  poolStatusQueryKey: () => ['pool-status'],
  poolStatusOptions: () => ({
    queryKey: ['pool-status'],
    queryFn: async () => {
      fixtures.poolReads += 1;
      if (fixtures.holdPoolReadsAfter !== null && fixtures.poolReads > fixtures.holdPoolReadsAfter) {
        await new Promise<void>((resolve) => {
          fixtures.release = resolve;
        });
      }
      if (fixtures.poolFails) throw new Error('pool status unreachable');
      return fixtures.pool;
    },
  }),
  // The Tailscale status route is reached through `named-status-routes`, which aliases getStatus3.
  getStatus3QueryKey: () => ['tailscale-status'],
  getStatus3Options: () => ({
    queryKey: ['tailscale-status'],
    queryFn: async () => {
      fixtures.tsReads += 1;
      if (fixtures.tsHangs) return new Promise(() => undefined);
      if (fixtures.tsFails) throw new Error('tailscale status unreachable');
      return fixtures.ts;
    },
  }),
}));

const HUB_B = 'hub-b.example-tailnet.ts.net';
const HUB_C = 'hub-c.example-tailnet.ts.net';

const renderWizard = ({ strict = false, startAt }: { strict?: boolean; startAt?: 'find' } = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const tree = (
    <QueryClientProvider client={client}>
      <PoolSetupWizard open onOpenChange={onOpenChange} startAt={startAt} />
    </QueryClientProvider>
  );
  const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { ...view, client, onOpenChange };
};

const heading = (name: string) => screen.findByRole('heading', { name });
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const sendButton = () => screen.getByRole('button', { name: /^Send \d+ requests?$/ });

type User = ReturnType<typeof userEvent.setup>;
/**
 * Nothing is ticked when the Find step opens: a request is an introduction made on the user's behalf, so a
 * test that wants a Hub in the batch has to choose it, by hostname, the way a user does. It clicks the Hub's
 * checkbox, so naming a Hub that is already ticked clears it.
 */
const choose = async (user: User, ...hostnames: string[]) => {
  for (const hostname of hostnames) {
    await user.click(await screen.findByRole('checkbox', { name: new RegExp(hostname) }));
  }
};
const chooseAll = async (user: User) => {
  await user.click(await screen.findByRole('checkbox', { name: 'Select all' }));
};
/** The Hub rows on the Find step in the order they are listed, without the Select all box. */
const listedHubs = () =>
  screen
    .getAllByRole('checkbox')
    .filter((box) => box.getAttribute('name') !== 'pool-setup-select-all')
    .map((box) => box.getAttribute('name')?.replace('pool-setup-hub-', ''));
/** Every Hub the scan found, ticked, then sent: the Find step to the Connect step. */
const toConnectStep = async (user: User) => {
  await chooseAll(user);
  await user.click(sendButton());
};
/** The visible part of a Hub card. A row also carries an sr-only copy of the name, for the buttons it describes, so the name is read from here. */
const summaryOf = (row: HTMLElement) => within(within(row).getByTestId('pool-hub-summary'));
/** A node's text with the zero-width spaces the guide puts after a fingerprint's colons taken out, which is what a user copies. */
const withoutZeroWidth = (node: HTMLElement) => (node.textContent ?? '').replaceAll('\u200b', '');
/** The text of the buttons in the step's footer, left to right: the primary action must be the last one. */
const footerButtons = () =>
  within(screen.getByTestId('pool-setup-footer'))
    .getAllByRole('button')
    .map((node) => node.textContent);

/**
 * Lets queued promises, effects and react-query notifications run under fake timers. The last round moves
 * the clock by 1 ms: a render caused by a fetch that settled exactly on an interval boundary does not
 * land until time moves at all, however many zero-length flushes come first.
 */
const flush = async () => {
  for (const ms of [0, 0, 1]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }
};
/**
 * A click for fake-timer tests. `userEvent` and `findBy*` wait on a real timer that never fires once timers
 * are faked outside Jest, so these tests click synchronously and flush instead.
 */
const click = async (element: HTMLElement) => {
  fireEvent.click(element);
  await flush();
};
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
};

/** A pool where pairing a Hub creates the waiting row the real backend creates. */
const pairingCreatesWaitingRow = () => {
  fixtures.pairPeer.mockImplementation(async ({ body }: { body: { nodeFqdn: string; displayName?: string } }) => {
    fixtures.pool = poolWith([
      ...fixtures.pool.peers,
      waitingPeer({ id: `peer-${body.nodeFqdn}`, nodeFqdn: body.nodeFqdn, displayName: body.displayName ?? null }),
    ]);
    return sdkOk({}, 201);
  });
};

beforeEach(() => {
  fixtures.pool = poolStatus();
  fixtures.poolFails = false;
  fixtures.poolReads = 0;
  fixtures.holdPoolReadsAfter = null;
  fixtures.release = null;
  fixtures.ts = tailscaleStatus();
  fixtures.tsFails = false;
  fixtures.tsHangs = false;
  fixtures.tsReads = 0;
  fixtures.discoverable = [candidate('hub-b'), candidate('hub-c')];
  fixtures.demo = false;
  fixtures.appTailscaleAvailable = true;
  for (const mock of [
    fixtures.listDiscoverable,
    fixtures.pairPeer,
    fixtures.approvePeer,
    fixtures.rejectPeer,
    fixtures.removePeer,
    fixtures.updatePoolSettings,
    fixtures.startAuth,
    fixtures.openExternal,
    fixtures.toast.success,
    fixtures.toast.error,
    fixtures.toast.info,
  ]) {
    mock.mockReset();
  }
  fixtures.listDiscoverable.mockImplementation(async () => sdkOk(fixtures.discoverable));
  fixtures.pairPeer.mockImplementation(async () => sdkOk({}, 201));
  fixtures.approvePeer.mockImplementation(async () => sdkOk({}));
  fixtures.rejectPeer.mockImplementation(async () => sdkOk({}));
  fixtures.removePeer.mockImplementation(async () => sdkOk({}));
  fixtures.updatePoolSettings.mockImplementation(async () => sdkOk({}));
  fixtures.startAuth.mockImplementation(async () => sdkOk({ success: true, authUrl: 'https://login.example.com/a/abc123' }));
  fixtures.openExternal.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resume', () => {
  it('opens on Find Hubs and calls listDiscoverable exactly once when the Hub is ready with no peers, including under StrictMode', async () => {
    renderWizard({ strict: true });

    expect(await heading('Find your Hubs')).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: /hub-b/ })).toBeInTheDocument();
    expect(fixtures.listDiscoverable).toHaveBeenCalledTimes(1);
  });

  it('opens on Check readiness when Tailscale is not connected, with Continue disabled', async () => {
    fixtures.ts = tailscaleStatus({ connected: false });
    renderWizard();

    expect(await heading('Is this Hub ready?')).toBeInTheDocument();
    expect(within(screen.getByTestId('pool-setup-check-tailscale')).getByText('Needs action')).toBeInTheDocument();
    expect(button('Continue')).toBeDisabled();
    expect(fixtures.listDiscoverable).not.toHaveBeenCalled();
  });

  it('opens on Approve on each Hub when a peer already exists and never calls listDiscoverable or pairPeer', async () => {
    fixtures.pool = poolWith([waitingPeer()]);
    renderWizard();

    expect(await heading('Approve on each Hub')).toBeInTheDocument();
    expect(screen.getByTestId('pool-setup-waiting')).toBeInTheDocument();
    expect(fixtures.listDiscoverable).not.toHaveBeenCalled();
    expect(fixtures.pairPeer).not.toHaveBeenCalled();
  });

  it('closing and reopening after a send shows the sent peer as waiting and does not call pairPeer again', async () => {
    pairingCreatesWaitingRow();
    const user = userEvent.setup();
    const first = renderWizard();
    await choose(user, 'hub-c');
    await user.click(sendButton());
    expect(await screen.findByText('1 of 1 request sent')).toBeInTheDocument();
    first.unmount();

    renderWizard();

    expect(await heading('Approve on each Hub')).toBeInTheDocument();
    expect(screen.getByTestId('pool-setup-waiting')).toBeInTheDocument();
    expect(fixtures.pairPeer).toHaveBeenCalledTimes(1);
    expect(fixtures.listDiscoverable).toHaveBeenCalledTimes(1);
  });

  it('does not wait for the Tailscale query to open on Approve when the pool already has peers', async () => {
    fixtures.tsHangs = true;
    fixtures.pool = poolWith([poolPeer()]);
    renderWizard();

    expect(await heading('Approve on each Hub')).toBeInTheDocument();
  });

  it('shows the load error with Retry when pool status fails, and recovers when it comes back', async () => {
    fixtures.poolFails = true;
    const user = userEvent.setup();
    renderWizard();

    expect(await screen.findByText(/Couldn't read pool status/)).toBeInTheDocument();
    fixtures.poolFails = false;
    await user.click(button('Retry'));

    expect(await heading('Find your Hubs')).toBeInTheDocument();
  });

  it('opens on Check readiness when the Tailscale status cannot be read, rather than assuming it is fine', async () => {
    fixtures.tsFails = true;
    renderWizard();

    expect(await heading('Is this Hub ready?')).toBeInTheDocument();
    expect(screen.getByText(/could not read Tailscale's status/)).toBeInTheDocument();
  });
});

describe('ready step', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('Connect Tailscale calls startAuth, opens the auth URL with openExternal, and enables Continue after the 5 s poll reports connected', async () => {
    fixtures.ts = tailscaleStatus({ connected: false });
    renderWizard();
    await flush();

    await click(button('Connect Tailscale'));

    expect(fixtures.startAuth).toHaveBeenCalledTimes(1);
    expect(fixtures.openExternal).toHaveBeenCalledWith('https://login.example.com/a/abc123');
    expect(screen.getByText(/Finish signing in in the browser tab/)).toBeInTheDocument();
    expect(button('Continue')).toBeDisabled();

    fixtures.ts = tailscaleStatus();
    await advance(5000);
    expect(button('Continue')).toBeEnabled();
    expect(within(screen.getByTestId('pool-setup-check-tailscale')).getByText('Ready')).toBeInTheDocument();
  });

  it('does not say to finish signing in in a tab that never opened', async () => {
    fixtures.ts = tailscaleStatus({ connected: false });
    fixtures.openExternal.mockResolvedValue(false);
    renderWizard();
    await flush();

    await click(button('Connect Tailscale'));

    expect(fixtures.startAuth).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Finish signing in in the browser tab/)).not.toBeInTheDocument();
    expect(fixtures.toast.error).toHaveBeenCalled();
  });

  it('Check again re-reads Tailscale straight away instead of waiting for the next poll', async () => {
    fixtures.ts = tailscaleStatus({ connected: false });
    renderWizard();
    await flush();
    expect(button('Continue')).toBeDisabled();

    fixtures.ts = tailscaleStatus();
    await click(button('Check again'));

    expect(button('Continue')).toBeEnabled();
  });

  it('warns for httpsAvailable false and offers Continue anyway rather than blocking', async () => {
    fixtures.ts = tailscaleStatus({ httpsAvailable: false });
    renderWizard();
    await flush();

    expect(screen.getByRole('heading', { name: 'Is this Hub ready?' })).toBeInTheDocument();
    expect(screen.getByTestId('pool-setup-check-https')).toHaveAttribute('data-state', 'warn');
    expect(button('Continue anyway')).toBeEnabled();
  });

  it('shows the Serve remedy command when Tailscale refused Serve', async () => {
    fixtures.ts = tailscaleStatus({ servePermission: { denied: true, remedy: 'sudo tailscale set --operator=$USER' } });
    renderWizard();
    await flush();

    expect(screen.getByTestId('pool-setup-serve-remedy')).toHaveTextContent('sudo tailscale set --operator=$USER');
    expect(button('Continue anyway')).toBeEnabled();
  });

  it('Turn on Hub Pool sends updatePoolSettings with poolEnabled true when disabled by setting', async () => {
    fixtures.pool = poolStatus({ enabled: false, disabledBy: 'setting', settings: { ...poolStatus().settings, poolEnabled: false } });
    renderWizard();
    await flush();

    await click(button('Turn on Hub Pool'));

    expect(fixtures.updatePoolSettings).toHaveBeenCalledWith({ body: { poolEnabled: true } });
    expect(fixtures.toast.success).toHaveBeenCalled();
  });

  it('shows no Turn on button when the .env file turns Hub Pool off, and says which variable to remove', async () => {
    fixtures.pool = poolStatus({ enabled: false, disabledBy: 'env' });
    renderWizard();
    await flush();

    expect(screen.queryByRole('button', { name: 'Turn on Hub Pool' })).not.toBeInTheDocument();
    expect(screen.getByText(/HUB_POOL_USER_DISABLED/)).toBeInTheDocument();
    expect(button('Continue')).toBeDisabled();
  });

  it('gates on the live Tailscale query, not on appContext tailscaleAvailable', async () => {
    fixtures.appTailscaleAvailable = false;
    renderWizard();
    await flush();

    expect(screen.getByRole('heading', { name: 'Find your Hubs' })).toBeInTheDocument();
  });
});

describe('find step', () => {
  it('lists verified candidates with nothing ticked, ticks one at a time, and Select all ticks and clears every row', async () => {
    const user = userEvent.setup();
    renderWizard();

    const hubB = await screen.findByRole('checkbox', { name: /hub-b/ });
    const hubC = screen.getByRole('checkbox', { name: /hub-c/ });
    const selectAll = screen.getByRole('checkbox', { name: 'Select all' });
    expect(hubB).not.toBeChecked();
    expect(hubC).not.toBeChecked();
    expect(selectAll).not.toBeChecked();
    expect(screen.getByTestId('pool-setup-found')).toHaveTextContent('2 Hubs found');
    expect(screen.getByText('0 of 2 selected')).toBeInTheDocument();

    await user.click(hubC);
    expect(hubC).toBeChecked();
    expect(hubB).not.toBeChecked();
    expect(screen.getByText('1 of 2 selected')).toBeInTheDocument();
    expect(selectAll).not.toBeChecked();

    await user.click(selectAll);
    expect(hubB).toBeChecked();
    expect(hubC).toBeChecked();
    expect(selectAll).toBeChecked();
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();

    await user.click(selectAll);
    expect(hubB).not.toBeChecked();
    expect(hubC).not.toBeChecked();
    expect(screen.getByText('0 of 2 selected')).toBeInTheDocument();
  });

  it('reads Choose Hubs, disabled, with nothing chosen, then Send 1 request, then Send N requests, never Send 0 requests', async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByRole('checkbox', { name: /hub-b/ });

    expect(button('Choose Hubs')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Send/ })).not.toBeInTheDocument();

    await choose(user, 'hub-b');
    expect(screen.queryByRole('button', { name: 'Choose Hubs' })).not.toBeInTheDocument();
    expect(button('Send 1 request')).toBeEnabled();

    await choose(user, 'hub-c');
    expect(button('Send 2 requests')).toBeEnabled();

    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(button('Choose Hubs')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Send \d+ requests?$/ })).not.toBeInTheDocument();
  });

  it('sends nothing while nothing is chosen, even if the disabled button is pressed anyway', async () => {
    renderWizard();
    await screen.findByRole('checkbox', { name: /hub-b/ });

    fireEvent.click(button('Choose Hubs'));

    expect(fixtures.pairPeer).not.toHaveBeenCalled();
    expect(screen.getByTestId('pool-setup-step-find')).toBeInTheDocument();
    expect(screen.queryByTestId('pool-setup-step-connect')).not.toBeInTheDocument();
  });

  it('lists the Hubs sorted by hostname and then tailnet name, whatever order the scan answered in, and keeps that order on a rescan', async () => {
    fixtures.discoverable = [
      candidate('hub-c'),
      candidate('dup', { nodeFqdn: 'dup-z.example-tailnet.ts.net' }),
      candidate('hub-a'),
      candidate('dup', { nodeFqdn: 'dup-a.example-tailnet.ts.net' }),
    ];
    const user = userEvent.setup();
    renderWizard();
    await screen.findByRole('checkbox', { name: /hub-c/ });
    const sorted = ['dup-a.example-tailnet.ts.net', 'dup-z.example-tailnet.ts.net', 'hub-a.example-tailnet.ts.net', 'hub-c.example-tailnet.ts.net'];
    expect(listedHubs()).toEqual(sorted);

    // The same Hubs, answering in the reverse order this time.
    fixtures.discoverable = [...fixtures.discoverable].reverse();
    await user.click(button('Rescan'));
    await waitFor(() => expect(fixtures.listDiscoverable).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button('Rescan')).toBeEnabled());

    expect(listedHubs()).toEqual(sorted);
  });

  it('a rescan keeps the Hubs the user chose, and newly found Hubs arrive unticked', async () => {
    const user = userEvent.setup();
    renderWizard();
    await choose(user, 'hub-b');
    fixtures.discoverable = [candidate('hub-b'), candidate('hub-c'), candidate('hub-d')];

    await user.click(button('Rescan'));

    expect(await screen.findByRole('checkbox', { name: /hub-d/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /hub-b/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /hub-c/ })).not.toBeChecked();
    expect(screen.getByText('1 of 3 selected')).toBeInTheDocument();
    expect(button('Send 1 request')).toBeEnabled();
    expect(fixtures.listDiscoverable).toHaveBeenCalledTimes(2);
  });

  it('a rescan does not send a Hub the user chose that is no longer listed', async () => {
    const user = userEvent.setup();
    renderWizard();
    await choose(user, 'hub-b', 'hub-c');
    fixtures.discoverable = [candidate('hub-c')];

    await user.click(button('Rescan'));
    await waitFor(() => expect(screen.getByTestId('pool-setup-found')).toHaveTextContent('1 Hub found'));

    expect(screen.getByText('1 of 1 selected')).toBeInTheDocument();
    await user.click(sendButton());
    await waitFor(() => expect(fixtures.pairPeer).toHaveBeenCalledTimes(1));
    expect(fixtures.pairPeer).toHaveBeenCalledWith({ body: { nodeFqdn: HUB_C, displayName: 'hub-c' } });
  });

  it('never renders a checkbox for mDNS or unverified rows and shows the unverified count line', async () => {
    fixtures.discoverable = [
      candidate('hub-b'),
      candidate('hub-x', { source: 'mdns', address: '192.0.2.7:443' }),
      candidate('hub-y', { verified: false }),
    ];
    renderWizard();

    await screen.findByRole('checkbox', { name: /hub-b/ });

    expect(screen.queryByRole('checkbox', { name: /hub-x/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /hub-y/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('pool-setup-unverified')).toHaveTextContent('2 more devices announced themselves on your LAN');
    expect(screen.getByTestId('pool-setup-found')).toHaveTextContent('1 Hub found');
  });

  it('hides a candidate the live pool already has a row for, even if the scan still lists it', async () => {
    fixtures.pool = poolWith([waitingPeer({ nodeFqdn: HUB_B })]);
    fixtures.discoverable = [candidate('hub-b'), candidate('hub-c')];
    const user = userEvent.setup();
    renderWizard();
    await heading('Approve on each Hub');

    await user.click(button('Add another Hub'));

    await screen.findByRole('checkbox', { name: /hub-c/ });
    expect(screen.queryByRole('checkbox', { name: /hub-b/ })).not.toBeInTheDocument();
  });

  it('Back returns to the readiness check', async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByRole('checkbox', { name: /hub-b/ });

    await user.click(button('Back'));

    expect(await heading('Is this Hub ready?')).toBeInTheDocument();
  });

  describe('scanning', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('Rescan calls listDiscoverable a second time, and advancing 60 s of fake time adds no further scans or status reads', async () => {
      renderWizard();
      await flush();
      expect(fixtures.listDiscoverable).toHaveBeenCalledTimes(1);
      const reads = fixtures.poolReads;

      await advance(60_000);
      expect(fixtures.listDiscoverable).toHaveBeenCalledTimes(1);
      expect(fixtures.poolReads).toBe(reads);

      await click(button('Rescan'));
      expect(fixtures.listDiscoverable).toHaveBeenCalledTimes(2);

      await advance(60_000);
      expect(fixtures.listDiscoverable).toHaveBeenCalledTimes(2);
    });
  });

  it('announces the scan while it runs, and says so when it fails, with Rescan as the way out', async () => {
    let finish: (value: unknown) => void = () => undefined;
    fixtures.listDiscoverable.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    renderWizard();

    expect(await screen.findByTestId('pool-setup-scanning')).toBeInTheDocument();
    expect(screen.getByTestId('pool-setup-find-announce')).toHaveTextContent('Scanning your tailnet…');
    expect(button('Rescan')).toBeDisabled();
    await act(async () => finish(sdkFail(500)));

    expect(await screen.findByRole('alert')).toHaveTextContent('Scan failed.');
    expect(button('Rescan')).toBeEnabled();

    await user.click(button('Rescan'));
    expect(await screen.findByRole('checkbox', { name: /hub-b/ })).toBeInTheDocument();
  });

  it('empty state lists the causes, the tailnet devices that did not answer as a Hub (excluding paired names), the docs link, and the cihub address and PIN command', async () => {
    fixtures.discoverable = [];
    fixtures.ts = tailscaleStatus({
      peers: [
        { nodeFqdn: 'nas.example-tailnet.ts.net', hostname: 'nas', ip: '100.64.0.3', online: true },
        { nodeFqdn: 'phone.example-tailnet.ts.net', hostname: 'phone', ip: '100.64.0.4', online: false },
      ],
    });
    renderWizard();

    const empty = await screen.findByTestId('pool-setup-empty');

    expect(within(empty).getByRole('heading', { name: 'No Hubs found' })).toBeInTheDocument();
    expect(within(empty).getByText("Companion Hub isn't installed or running on the other machine.")).toBeInTheDocument();
    expect(within(empty).getByText("It's on a different Tailscale account, or offline or asleep.")).toBeInTheDocument();
    expect(
      within(empty).getByText("HTTPS certificates are off for your tailnet, or the other Hub isn't published on Tailscale."),
    ).toBeInTheDocument();
    expect(within(empty).getByText('Your tailnet lists 2 other devices, but none are answering as a Hub:')).toBeInTheDocument();
    expect(within(empty).getByText('nas')).toBeInTheDocument();
    expect(within(empty).getByText('phone (offline)')).toBeInTheDocument();
    expect(within(empty).getByText(/run cihub pool doctor to see what's missing/)).toBeInTheDocument();
    const link = within(empty).getByRole('link', { name: 'Install Companion Hub on another machine' });
    expect(link).toHaveAttribute('href', 'https://docs.ci.computer');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(empty).getByRole('heading', { name: 'Know its address?' })).toBeInTheDocument();
    expect(within(empty).getByTestId('pool-setup-pair-command')).toHaveTextContent('cihub pool pair <address> --pin <digits>');
    expect(screen.queryByRole('button', { name: /^Send|^Choose Hubs$/ })).not.toBeInTheDocument();
    expect(button('Rescan')).toBeEnabled();
  });

  it('empty state uses the singular for one tailnet device that did not answer', async () => {
    fixtures.discoverable = [];
    fixtures.ts = tailscaleStatus({ peers: [{ nodeFqdn: 'nas.example-tailnet.ts.net', hostname: 'nas', ip: '100.64.0.3', online: true }] });
    renderWizard();

    expect(await screen.findByText("Your tailnet lists 1 other device, but it isn't answering as a Hub:")).toBeInTheDocument();
  });

  it('empty state with no tailnet devices says so', async () => {
    fixtures.discoverable = [];
    renderWizard();

    expect(await screen.findByText('Your tailnet lists no other devices. Connect the other machine to Tailscale first.')).toBeInTheDocument();
  });

  it('keeps the PIN field in a Have a PIN? disclosure that starts closed', async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByRole('checkbox', { name: /hub-b/ });

    const disclosure = screen.getByTestId('pool-setup-pin');
    expect(disclosure).not.toHaveAttribute('open');
    expect(within(disclosure).getByText('Have a PIN?')).toBeInTheDocument();

    await user.click(within(disclosure).getByText('Have a PIN?'));

    expect(disclosure).toHaveAttribute('open');
  });

  it('PIN field is disabled until exactly one Hub is chosen, and sends the pin with that one', async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByRole('checkbox', { name: /hub-b/ });

    const pin = screen.getByLabelText('PIN from the other Hub');
    expect(pin).toBeDisabled();
    expect(screen.getByText('A PIN works for one Hub at a time.')).toBeInTheDocument();

    await choose(user, 'hub-b', 'hub-c');
    expect(pin).toBeDisabled();
    expect(screen.getByText('A PIN works for one Hub at a time.')).toBeInTheDocument();

    await choose(user, 'hub-c');
    expect(pin).toBeEnabled();
    expect(screen.queryByText('A PIN works for one Hub at a time.')).not.toBeInTheDocument();
    await user.type(pin, '12a3456');
    expect(pin).toHaveValue('123456');
    await user.click(sendButton());

    await waitFor(() => expect(fixtures.pairPeer).toHaveBeenCalledTimes(1));
    expect(fixtures.pairPeer).toHaveBeenCalledWith({ body: { nodeFqdn: HUB_B, displayName: 'hub-b', pin: '123456' } });
  });

  it('does not carry a PIN typed for one Hub over to another Hub when the selection moves', async () => {
    const user = userEvent.setup();
    renderWizard();
    // Hub B alone: the PIN is for Hub B.
    await choose(user, 'hub-b');
    const pin = screen.getByLabelText('PIN from the other Hub');
    await user.type(pin, '123456');
    expect(pin).toHaveValue('123456');

    // Move the selection to Hub C alone: Hub B's digits must not follow it.
    await choose(user, 'hub-b', 'hub-c');
    expect(pin).toBeEnabled();
    expect(pin).toHaveValue('');
    await user.click(sendButton());

    await waitFor(() => expect(fixtures.pairPeer).toHaveBeenCalledTimes(1));
    expect(fixtures.pairPeer).toHaveBeenCalledWith({ body: { nodeFqdn: HUB_C, displayName: 'hub-c' } });
  });

  it('brings the PIN back when the selection returns to the Hub it was typed for', async () => {
    const user = userEvent.setup();
    renderWizard();
    await choose(user, 'hub-c');
    await user.type(screen.getByLabelText('PIN from the other Hub'), '123456');

    await choose(user, 'hub-c');
    expect(screen.getByLabelText('PIN from the other Hub')).toBeDisabled();
    await choose(user, 'hub-c');

    expect(screen.getByLabelText('PIN from the other Hub')).toHaveValue('123456');
  });

  it('a partial PIN blocks Send and shows the six-digit message', async () => {
    const user = userEvent.setup();
    renderWizard();
    await choose(user, 'hub-c');

    await user.type(screen.getByLabelText('PIN from the other Hub'), '123');
    await user.tab();

    expect(screen.getByText('Enter all six digits, or leave the PIN blank.')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it('a blocked readiness level shows the not-ready notice with a Check button that goes back to the readiness step', async () => {
    fixtures.pool = poolWith([poolPeer()]);
    fixtures.ts = tailscaleStatus({ connected: false });
    const user = userEvent.setup();
    renderWizard();
    await heading('Approve on each Hub');
    await user.click(button('Add another Hub'));

    const notice = await screen.findByTestId('pool-setup-find-not-ready');
    expect(notice).toHaveTextContent("This Hub isn't ready to pair, so a scan may find nothing.");
    await user.click(within(notice).getByRole('button', { name: 'Check' }));

    expect(await heading('Is this Hub ready?')).toBeInTheDocument();
  });

  it('says how many Hubs already have a request or a pairing, with a Review button that opens the approval step', async () => {
    fixtures.pool = poolWith([waitingPeer({ nodeFqdn: HUB_B })]);
    const user = userEvent.setup();
    renderWizard({ startAt: 'find' });
    await heading('Find your Hubs');

    const line = await screen.findByTestId('pool-setup-in-progress');
    expect(line).toHaveTextContent('1 Hub is already paired or pending.');
    await user.click(within(line).getByRole('button', { name: 'Review' }));

    expect(await heading('Approve on each Hub')).toBeInTheDocument();
  });
});

describe('connect step', () => {
  /** Every Hub the scan found, ticked, then sent. */
  const toConnect = async (user: User) => {
    await chooseAll(user);
    await user.click(sendButton());
  };

  it('sends one pairPeer per selected node with nodeFqdn and displayName and no pin when the field is blank', async () => {
    pairingCreatesWaitingRow();
    const user = userEvent.setup();
    renderWizard();

    await toConnect(user);

    expect(await screen.findByText('2 of 2 requests sent')).toBeInTheDocument();
    expect(fixtures.pairPeer).toHaveBeenCalledTimes(2);
    expect(fixtures.pairPeer).toHaveBeenCalledWith({ body: { nodeFqdn: HUB_B, displayName: 'hub-b' } });
    expect(fixtures.pairPeer).toHaveBeenCalledWith({ body: { nodeFqdn: HUB_C, displayName: 'hub-c' } });
    expect(screen.getByTestId(`pool-setup-row-${HUB_B}`)).toHaveAttribute('data-state', 'sent');
  });

  it('skips a node that already has a peer row in the live re-read and marks it already', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseAll(user);
    // Created elsewhere (the CLI, another browser) after the dialog read pool status.
    fixtures.pool = poolWith([waitingPeer({ nodeFqdn: HUB_B })]);

    await user.click(sendButton());

    await waitFor(() => expect(screen.getByTestId(`pool-setup-row-${HUB_B}`)).toHaveAttribute('data-state', 'already'));
    expect(fixtures.pairPeer).toHaveBeenCalledTimes(1);
    expect(fixtures.pairPeer).toHaveBeenCalledWith({ body: { nodeFqdn: HUB_C, displayName: 'hub-c' } });
  });

  it('never sends a request twice for a node, however many times send is called at once', async () => {
    const { result } = renderHook(() => usePairingBatch(), {
      wrapper: ({ children }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>,
    });
    let resolvePair: (value: unknown) => void = () => undefined;
    fixtures.pairPeer.mockImplementation(() => new Promise((resolve) => (resolvePair = resolve)));
    const target = { nodeFqdn: HUB_B, hostname: 'hub-b' };

    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.send([target]);
      second = result.current.send([target]);
    });
    await waitFor(() => expect(fixtures.pairPeer).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolvePair(sdkOk({}, 201));
      await Promise.all([first, second]);
    });

    expect(fixtures.pairPeer).toHaveBeenCalledTimes(1);
  });

  it('keeps the OS and the online flag on a row through Send, Retry and Retry failed, and sends neither to the other Hub', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => usePairingBatch(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    fixtures.pairPeer.mockImplementation(async () => sdkFail(500));
    const hubB = { nodeFqdn: HUB_B, hostname: 'hub-b', os: 'linux', online: true };
    const hubC = { nodeFqdn: HUB_C, hostname: 'hub-c', os: 'macOS', online: false };
    const hubD = { nodeFqdn: 'hub-d.example-tailnet.ts.net', hostname: 'hub-d' };
    const display = () => result.current.currentRows.map(({ nodeFqdn, os, online }) => ({ nodeFqdn, os, online }));
    const expected = [
      { nodeFqdn: HUB_B, os: 'linux', online: true },
      { nodeFqdn: HUB_C, os: 'macOS', online: false },
      { nodeFqdn: hubD.nodeFqdn, os: undefined, online: undefined },
    ];

    await act(async () => {
      await result.current.send([hubB, hubC, hubD]);
    });
    expect(result.current.currentRows.map((row) => row.status)).toEqual(['failed', 'failed', 'failed']);
    expect(display()).toEqual(expected);

    await act(async () => {
      await result.current.retry(HUB_C, 'hub-c');
    });
    expect(display()).toEqual(expected);

    fixtures.pairPeer.mockImplementation(async () => sdkOk({}, 201));
    await act(async () => {
      await result.current.retryFailed();
    });
    expect(result.current.currentRows.map((row) => row.status)).toEqual(['sent', 'sent', 'sent']);
    expect(display()).toEqual(expected);

    // Display only: whatever the tailnet said about a Hub is never put in the request to it.
    for (const [options] of fixtures.pairPeer.mock.calls as [{ body: Record<string, unknown> }][]) {
      expect(Object.keys(options.body).sort()).toEqual(['displayName', 'nodeFqdn']);
    }
  });

  it('rows go queued, then sending, then sent while a controlled promise is pending', async () => {
    let resolvePair: (value: unknown) => void = () => undefined;
    fixtures.pairPeer.mockImplementation(() => new Promise((resolve) => (resolvePair = resolve)));
    const user = userEvent.setup();
    renderWizard();
    await choose(user, 'hub-b');

    await user.click(sendButton());

    const row = await screen.findByTestId(`pool-setup-row-${HUB_B}`);
    await waitFor(() => expect(row).toHaveAttribute('data-state', 'sending'));
    expect(within(row).getByText('Sending…')).toBeInTheDocument();
    expect(button('Continue')).toBeDisabled();
    expect(button('Back')).toBeDisabled();

    await act(async () => resolvePair(sdkOk({}, 201)));

    await waitFor(() => expect(row).toHaveAttribute('data-state', 'sent'));
    expect(within(row).getByText('Request sent')).toBeInTheDocument();
    expect(button('Continue')).toBeEnabled();
  });

  it('409 shows already, 400 shows the invalid message, 500 shows could not reach, and the PIN hint appears only when a PIN was used', async () => {
    fixtures.discoverable = [candidate('hub-b'), candidate('hub-c'), candidate('hub-d')];
    fixtures.pairPeer.mockImplementation(async ({ body }: { body: { nodeFqdn: string } }) => {
      if (body.nodeFqdn.startsWith('hub-b')) return sdkFail(409);
      if (body.nodeFqdn.startsWith('hub-c')) return sdkFail(400);
      return sdkFail(500);
    });
    const user = userEvent.setup();
    renderWizard();

    await toConnect(user);

    const rowB = await screen.findByTestId(`pool-setup-row-${HUB_B}`);
    await waitFor(() => expect(rowB).toHaveAttribute('data-state', 'already'));
    expect(within(rowB).getByText('Already paired')).toBeInTheDocument();
    const rowC = screen.getByTestId(`pool-setup-row-${HUB_C}`);
    expect(within(rowC).getByRole('alert')).toHaveTextContent('Refused as invalid.');
    const rowD = screen.getByTestId('pool-setup-row-hub-d.example-tailnet.ts.net');
    expect(within(rowD).getByRole('alert')).toHaveTextContent("Couldn't reach hub-d, or it declined.");
    expect(screen.queryByText(/A PIN works once/)).not.toBeInTheDocument();
  });

  it('shows the PIN hint on a failed request that carried a PIN', async () => {
    fixtures.pairPeer.mockImplementation(async () => sdkFail(500));
    const user = userEvent.setup();
    renderWizard();
    await choose(user, 'hub-b');
    await user.type(screen.getByLabelText('PIN from the other Hub'), '123456');

    await user.click(sendButton());

    expect(await screen.findByText('A PIN works once and expires after 10 minutes.')).toBeInTheDocument();
  });

  it('Retry resends only that node, without the PIN, after a fresh status re-read', async () => {
    fixtures.pairPeer.mockImplementationOnce(async () => sdkFail(500));
    const user = userEvent.setup();
    renderWizard();
    await choose(user, 'hub-b');
    await user.type(screen.getByLabelText('PIN from the other Hub'), '123456');
    await user.click(sendButton());
    await user.click(await screen.findByRole('button', { name: 'Retry hub-b' }));

    await waitFor(() => expect(screen.getByTestId(`pool-setup-row-${HUB_B}`)).toHaveAttribute('data-state', 'sent'));
    expect(fixtures.pairPeer).toHaveBeenCalledTimes(2);
    expect(fixtures.pairPeer).toHaveBeenLastCalledWith({ body: { nodeFqdn: HUB_B, displayName: 'hub-b' } });
  });

  it('Retry failed requests resends every failed row and none that worked', async () => {
    fixtures.pairPeer.mockImplementation(async ({ body }: { body: { nodeFqdn: string } }) =>
      body.nodeFqdn.startsWith('hub-b') ? sdkFail(500) : sdkOk({}, 201),
    );
    const user = userEvent.setup();
    renderWizard();
    await toConnect(user);
    await screen.findByRole('button', { name: 'Retry hub-b' });
    fixtures.pairPeer.mockClear();
    fixtures.pairPeer.mockImplementation(async () => sdkOk({}, 201));

    await user.click(button('Retry failed requests'));

    await waitFor(() => expect(fixtures.pairPeer).toHaveBeenCalledTimes(1));
    expect(fixtures.pairPeer).toHaveBeenCalledWith({ body: { nodeFqdn: HUB_B, displayName: 'hub-b' } });
    await waitFor(() => expect(screen.getByTestId(`pool-setup-row-${HUB_B}`)).toHaveAttribute('data-state', 'sent'));
  });

  it('invalidates pool status and never the discoverable key after the batch settles', async () => {
    pairingCreatesWaitingRow();
    const user = userEvent.setup();
    const { client } = renderWizard();
    const invalidated: unknown[] = [];
    const original = client.invalidateQueries.bind(client);
    vi.spyOn(client, 'invalidateQueries').mockImplementation((filters, options) => {
      invalidated.push(filters?.queryKey);
      return original(filters, options);
    });

    await toConnect(user);
    await screen.findByText('2 of 2 requests sent');

    expect(invalidated).toContainEqual(['pool-status']);
    expect(invalidated.every((key) => JSON.stringify(key) === JSON.stringify(['pool-status']))).toBe(true);
  });

  it('Back returns to Find with a fresh scan and a fresh choice, without the Hubs that were just asked', async () => {
    fixtures.discoverable = [candidate('hub-b'), candidate('hub-c'), candidate('hub-d')];
    pairingCreatesWaitingRow();
    const user = userEvent.setup();
    renderWizard();
    await screen.findByRole('checkbox', { name: /hub-b/ });
    await choose(user, 'hub-b', 'hub-c');
    await user.click(sendButton());
    await screen.findByText('2 of 2 requests sent');

    await user.click(button('Back'));

    expect(await heading('Find your Hubs')).toBeInTheDocument();
    await waitFor(() => expect(fixtures.listDiscoverable).toHaveBeenCalledTimes(2));
    // Hub B and Hub C now have a waiting row, so the scan no longer offers them; Hub D was never chosen.
    expect(await screen.findByRole('checkbox', { name: /hub-d/ })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /hub-b/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /hub-c/ })).not.toBeInTheDocument();
    expect(button('Choose Hubs')).toBeDisabled();
  });
});

describe('approve step', () => {
  it('an outbound pending row shows Waiting for the node to approve and the instruction to approve on the other Hub', async () => {
    fixtures.pool = poolWith([waitingPeer()]);
    renderWizard();

    const waiting = await screen.findByTestId('pool-setup-waiting');

    const row = within(waiting).getByTestId('pool-setup-waiting-peer-wait');
    expect(within(row).getByText('hub-b')).toBeInTheDocument();
    expect(within(row).getByTitle(HUB_B)).toBeInTheDocument();
    expect(within(row).getByText('Awaiting approval')).toBeInTheDocument();
    // The Cancel button is described by the sentence that names whose approval is awaited.
    expect(within(row).getByRole('button', { name: 'Cancel request' })).toHaveAccessibleDescription('Waiting for hub-b to approve');
    expect(screen.getByText(/Open Companion Hub on each machine and approve the request/)).toBeInTheDocument();
  });

  it('Cancel request calls removePeer with the row id and refreshes status', async () => {
    fixtures.pool = poolWith([waitingPeer({ id: 'peer-wait' })]);
    fixtures.removePeer.mockImplementation(async () => {
      fixtures.pool = poolStatus();
      return sdkOk({});
    });
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('button', { name: 'Cancel request' }));

    await waitFor(() => expect(fixtures.removePeer).toHaveBeenCalledWith({ path: { id: 'peer-wait' } }));
    expect(await screen.findByTestId('pool-setup-approve-empty')).toBeInTheDocument();
    expect(fixtures.toast.success).toHaveBeenCalled();
  });

  describe('polling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('polls status every 3 s while a request is pending and shows Connected, reading its models until lastSeenAt and capabilities arrive, then Verified with the model count', async () => {
      fixtures.pool = poolWith([waitingPeer()]);
      renderWizard();
      await flush();
      expect(screen.getByTestId('pool-setup-waiting')).toBeInTheDocument();

      const reads = fixtures.poolReads;
      await advance(2900);
      expect(fixtures.poolReads).toBe(reads);
      await advance(100);
      expect(fixtures.poolReads).toBe(reads + 1);

      fixtures.pool = poolWith([poolPeer({ lastSeenAt: null, lastCapabilities: null })]);
      await advance(3000);
      // Connected, but its models are not read yet: not verified, and no success panel.
      expect(screen.getByTestId('pool-setup-connected-peer-1')).toHaveAttribute('data-state', 'verifying');
      expect(screen.queryByText('Verified')).not.toBeInTheDocument();
      expect(screen.queryByTestId('pool-setup-success')).not.toBeInTheDocument();

      fixtures.pool = poolWith([poolPeer()]);
      await advance(3000);
      const row = screen.getByTestId('pool-setup-connected-peer-1');
      expect(row).toHaveAttribute('data-state', 'verified');
      expect(within(row).getByText('Verified')).toBeInTheDocument();
      expect(within(row).getByText('2 models')).toBeInTheDocument();
      expect(screen.getByTestId('pool-setup-success')).toBeInTheDocument();
    });

    it('polling stops once every peer is verified, with no further status calls after 10 s of fake time', async () => {
      fixtures.pool = poolWith([poolPeer()]);
      renderWizard();
      await flush();
      expect(screen.getByTestId('pool-setup-connected-peer-1')).toHaveAttribute('data-state', 'verified');
      expect(screen.getByText('Verified')).toBeInTheDocument();
      const reads = fixtures.poolReads;

      await advance(10_000);

      expect(fixtures.poolReads).toBe(reads);
    });

    it('polling stops at the 10 minute cap, shows the stopped message, and Check again refetches and re-arms', async () => {
      fixtures.pool = poolWith([waitingPeer()]);
      renderWizard();
      await flush();

      await advance(600_001);
      expect(screen.getByText('Stopped checking after 10 minutes.')).toBeInTheDocument();
      const stopped = fixtures.poolReads;
      await advance(30_000);
      expect(fixtures.poolReads).toBe(stopped);

      await click(button('Check again'));
      expect(fixtures.poolReads).toBe(stopped + 1);
      expect(screen.queryByText(/Stopped checking after/)).not.toBeInTheDocument();

      await advance(3000);
      expect(fixtures.poolReads).toBe(stopped + 2);
    });

    it('shows the still-waiting hint after 2 minutes, and not before', async () => {
      fixtures.pool = poolWith([waitingPeer()]);
      renderWizard();
      await flush();

      await advance(119_000);
      expect(screen.queryByTestId('pool-setup-waiting-long')).not.toBeInTheDocument();
      await advance(1_500);

      expect(screen.getByTestId('pool-setup-waiting-long')).toHaveTextContent('Still waiting for hub-b. The request stays open for 24 hours');
    });
  });

  describe('a request sent in this session', () => {
    const sendAndContinue = async (user: User) => {
      await choose(user, 'hub-b');
      await user.click(sendButton());
      await screen.findByText('1 of 1 request sent');
    };

    it('that disappears from status shows the request-is-gone notice with Pair again', async () => {
      // The pairing call succeeds but no row ever shows up (rejected or removed on the other Hub).
      const user = userEvent.setup();
      renderWizard();
      await sendAndContinue(user);

      await user.click(button('Continue'));

      const notice = await screen.findByTestId('pool-setup-vanished');
      expect(notice).toHaveTextContent('The request to hub-b is gone');
      pairingCreatesWaitingRow();
      await user.click(within(notice).getByRole('button', { name: 'Pair again' }));

      expect(await screen.findByText('1 of 1 request sent')).toBeInTheDocument();
      expect(fixtures.pairPeer).toHaveBeenCalledTimes(2);
    });

    it('that the user cancelled here does not produce the vanished notice', async () => {
      pairingCreatesWaitingRow();
      fixtures.removePeer.mockImplementation(async () => {
        fixtures.pool = poolStatus();
        return sdkOk({});
      });
      const user = userEvent.setup();
      renderWizard();
      await sendAndContinue(user);
      await user.click(button('Continue'));

      await user.click(await screen.findByRole('button', { name: 'Cancel request' }));

      expect(await screen.findByTestId('pool-setup-approve-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('pool-setup-vanished')).not.toBeInTheDocument();
    });

    it('is not called gone by a status fetched before the batch settled', async () => {
      pairingCreatesWaitingRow();
      const user = userEvent.setup();
      renderWizard();
      await screen.findByRole('checkbox', { name: /hub-b/ });
      // Let the send's own re-read through and hold the refresh that follows it, so the Approve step
      // is on screen with a status older than the send.
      fixtures.holdPoolReadsAfter = fixtures.poolReads + 1;
      await sendAndContinue(user);
      await user.click(button('Continue'));

      expect(await screen.findByTestId('pool-setup-step-approve')).toBeInTheDocument();
      expect(screen.queryByTestId('pool-setup-vanished')).not.toBeInTheDocument();

      await act(async () => fixtures.release?.());
      expect(await screen.findByTestId('pool-setup-waiting')).toBeInTheDocument();
      expect(screen.queryByTestId('pool-setup-vanished')).not.toBeInTheDocument();
    });
  });

  it('an inbound pending row shows the tailnet name, the key fingerprint or the unverified-claim line, and this Hub’s own fingerprint', async () => {
    fixtures.pool = poolWith([
      incomingPeer({ id: 'in-1', peerKeyFingerprint: 'aa:bb:cc:dd:ee:ff:00:11' }),
      incomingPeer({ id: 'in-2', nodeFqdn: 'hub-e.example-tailnet.ts.net', displayName: 'Not who it says' }),
    ]);
    renderWizard();

    const first = await screen.findByTestId('pool-setup-incoming-in-1');
    const second = screen.getByTestId('pool-setup-incoming-in-2');

    // The title is the host part of the tailnet name and the address is the whole of it, never the requester's own display name.
    expect(within(first).getByText('hub-c')).toBeInTheDocument();
    expect(within(first).getByTitle(HUB_C)).toBeInTheDocument();
    expect(within(first).getByText('Wants to join')).toBeInTheDocument();
    expect(withoutZeroWidth(within(first).getByTestId('pool-setup-incoming-fingerprint'))).toBe('Key fingerprint aa:bb:cc:dd:ee:ff:00:11');
    expect(within(first).queryByTestId('pool-setup-incoming-unverified')).not.toBeInTheDocument();

    expect(within(second).getByText('hub-e')).toBeInTheDocument();
    expect(within(second).getByTitle('hub-e.example-tailnet.ts.net')).toBeInTheDocument();
    expect(within(second).getByTestId('pool-setup-incoming-unverified')).toHaveTextContent(/this request arrived without a pairing PIN/);
    expect(within(second).queryByTestId('pool-setup-incoming-fingerprint')).not.toBeInTheDocument();
    expect(within(second).queryByText('Not who it says')).not.toBeInTheDocument();

    expect(withoutZeroWidth(screen.getByTestId('pool-setup-local-fingerprint'))).toContain('11:22:33:44:55:66:77:88');
    expect(screen.queryByText(/Open Companion Hub on each machine and approve the request/)).not.toBeInTheDocument();
  });

  it('breaks a key fingerprint after each colon with a zero-width space, so it wraps between byte pairs and copies back unchanged', async () => {
    fixtures.pool = poolWith([incomingPeer({ id: 'in-1', peerKeyFingerprint: 'aa:bb:cc:dd' })]);
    renderWizard();

    const line = await screen.findByTestId('pool-setup-incoming-fingerprint');

    expect(line.textContent).toContain('aa:\u200bbb:\u200bcc:\u200bdd');
    expect(withoutZeroWidth(line)).toContain('aa:bb:cc:dd');
  });

  it('Approve and Reject call approvePeer and rejectPeer with the row id', async () => {
    fixtures.pool = poolWith([incomingPeer({ id: 'in-1' }), incomingPeer({ id: 'in-2', nodeFqdn: 'hub-e.example-tailnet.ts.net' })]);
    const user = userEvent.setup();
    renderWizard();

    const first = await screen.findByTestId('pool-setup-incoming-in-1');
    await user.click(within(first).getByRole('button', { name: 'Approve' }));
    await user.click(within(screen.getByTestId('pool-setup-incoming-in-2')).getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(fixtures.approvePeer).toHaveBeenCalledWith({ path: { id: 'in-1' } }));
    await waitFor(() => expect(fixtures.rejectPeer).toHaveBeenCalledWith({ path: { id: 'in-2' } }));
  });

  it('a 404 from approve shows the request-is-gone toast and not an error toast', async () => {
    fixtures.pool = poolWith([incomingPeer({ id: 'in-1' })]);
    fixtures.approvePeer.mockImplementation(async () => sdkFail(404));
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(fixtures.toast.info).toHaveBeenCalledWith('That request is gone.'));
    expect(fixtures.toast.error).not.toHaveBeenCalled();
  });

  it('any other approve failure shows the usual error toast', async () => {
    fixtures.pool = poolWith([incomingPeer({ id: 'in-1' })]);
    fixtures.approvePeer.mockImplementation(async () => sdkFail(500));
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(fixtures.toast.error).toHaveBeenCalledWith('Failed to approve pairing.'));
  });

  describe('rows that waiting never clears', () => {
    const brokenPool = () =>
      poolWith([
        poolPeer({
          id: 'p-repair',
          displayName: 'repair-hub',
          status: 'unreachable',
          probeFailure: { kind: 'identity_changed', action: 'Unpair it.' },
        }),
        poolPeer({
          id: 'p-creds',
          nodeFqdn: 'hub-k.example-tailnet.ts.net',
          displayName: 'creds-hub',
          status: 'unreachable',
          probeFailure: { kind: 'unauthorized', action: 'Re-pair.', httpStatus: 401 },
        }),
        poolPeer({
          id: 'p-half',
          nodeFqdn: 'hub-h.example-tailnet.ts.net',
          displayName: 'half-hub',
          direction: 'inbound',
          status: 'unreachable',
          probeFailure: { kind: 'unreachable', action: null, httpStatus: 403 },
        }),
        poolPeer({ id: 'p-plain', nodeFqdn: 'hub-p.example-tailnet.ts.net', displayName: 'plain-hub', status: 'unreachable' }),
      ]);

    it('says what to do for identity_changed, unauthorized, and an inbound 403, and says a plain unreachable row heals itself', async () => {
      fixtures.pool = brokenPool();
      renderWizard();

      expect(await screen.findByText('repair-hub no longer recognizes this Hub. Unpair it, then pair again.')).toBeInTheDocument();
      expect(
        within(screen.getByTestId('pool-setup-connected-p-creds')).getByText(
          /creds-hub refuses this Hub's credentials\. It probably removed this Hub/,
        ),
      ).toBeInTheDocument();
      expect(within(screen.getByTestId('pool-setup-connected-p-creds')).getByText(/both clocks are within 5 minutes/)).toBeInTheDocument();
      expect(within(screen.getByTestId('pool-setup-connected-p-plain')).getByText('Not answering. It rejoins automatically.')).toBeInTheDocument();
      expect(screen.queryByTestId('pool-setup-success')).not.toBeInTheDocument();
    });

    it('half paired tells the operator to unpair here first, then clean up the other Hub, in that order', async () => {
      fixtures.pool = brokenPool();
      renderWizard();

      const text = (await within(await screen.findByTestId('pool-setup-connected-p-half')).findByText(/You approved half-hub/)).textContent ?? '';

      expect(text).toContain('the approval never reached it');
      expect(text.indexOf('Unpair it here')).toBeGreaterThan(-1);
      expect(text.indexOf('Unpair it here')).toBeLessThan(text.indexOf('cancel it there'));
      expect(text).toContain('run cihub pool doctor on half-hub to check it is published over HTTPS');
    });

    it('offers Unpair on the three rows that need it, and not on one that rejoins by itself', async () => {
      fixtures.pool = brokenPool();
      renderWizard();

      for (const id of ['p-repair', 'p-creds', 'p-half']) {
        expect(within(await screen.findByTestId(`pool-setup-connected-${id}`)).getByRole('button', { name: 'Unpair' })).toBeInTheDocument();
      }
      expect(within(screen.getByTestId('pool-setup-connected-p-plain')).queryByRole('button', { name: 'Unpair' })).not.toBeInTheDocument();
    });

    it('Unpair removes that row with removePeer, refreshes the pool, and toasts', async () => {
      fixtures.pool = brokenPool();
      fixtures.removePeer.mockImplementation(async ({ path }: { path: { id: string } }) => {
        fixtures.pool = poolWith(fixtures.pool.peers.filter((peer) => peer.id !== path.id));
        return sdkOk({});
      });
      const user = userEvent.setup();
      renderWizard();

      await user.click(within(await screen.findByTestId('pool-setup-connected-p-half')).getByRole('button', { name: 'Unpair' }));

      await waitFor(() => expect(fixtures.removePeer).toHaveBeenCalledWith({ path: { id: 'p-half' } }));
      await waitFor(() => expect(screen.queryByTestId('pool-setup-connected-p-half')).not.toBeInTheDocument());
      expect(fixtures.toast.success).toHaveBeenCalledWith('Peer removed.');
      expect(screen.getByTestId('pool-setup-connected-p-repair')).toBeInTheDocument();
    });

    it('a failed Unpair shows the usual error toast and keeps the row', async () => {
      fixtures.pool = brokenPool();
      fixtures.removePeer.mockImplementation(async () => sdkFail(500));
      const user = userEvent.setup();
      renderWizard();

      await user.click(within(await screen.findByTestId('pool-setup-connected-p-creds')).getByRole('button', { name: 'Unpair' }));

      await waitFor(() => expect(fixtures.toast.error).toHaveBeenCalledWith('Failed to remove peer.'));
      expect(screen.getByTestId('pool-setup-connected-p-creds')).toBeInTheDocument();
    });

    it('disables Unpair in demo mode', async () => {
      fixtures.demo = true;
      fixtures.pool = brokenPool();
      renderWizard();

      expect(within(await screen.findByTestId('pool-setup-connected-p-half')).getByRole('button', { name: 'Unpair' })).toBeDisabled();
    });

    it('unpairing a Hub this session sent a request to does not report the request as gone', async () => {
      pairingCreatesWaitingRow();
      fixtures.removePeer.mockImplementation(async ({ path }: { path: { id: string } }) => {
        fixtures.pool = poolWith(fixtures.pool.peers.filter((peer) => peer.id !== path.id));
        return sdkOk({});
      });
      const user = userEvent.setup();
      const { client } = renderWizard();
      await choose(user, 'hub-b');
      await user.click(sendButton());
      await screen.findByText('1 of 1 request sent');
      await user.click(button('Continue'));
      await screen.findByTestId('pool-setup-waiting');

      // The request is later approved there, then the approval's callback to this Hub is refused: the row turns half paired.
      fixtures.pool = poolWith([
        poolPeer({
          id: `peer-${HUB_B}`,
          nodeFqdn: HUB_B,
          displayName: 'hub-b',
          direction: 'inbound',
          status: 'unreachable',
          probeFailure: { kind: 'unauthorized', action: 'Re-pair.', httpStatus: 401 },
        }),
      ]);
      await act(async () => {
        await client.invalidateQueries();
      });
      await user.click(await screen.findByRole('button', { name: 'Unpair' }));

      expect(await screen.findByTestId('pool-setup-approve-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('pool-setup-vanished')).not.toBeInTheDocument();
    });

    it('announces a Hub that needs attention in the persistent status region', async () => {
      fixtures.pool = brokenPool();
      renderWizard();

      expect(await screen.findByTestId('pool-setup-announce')).toHaveTextContent('4 Hubs need attention.');
    });

    it('does not announce a settled, healthy pool as needing attention', async () => {
      fixtures.pool = poolWith([poolPeer()]);
      renderWizard();

      const announce = await screen.findByTestId('pool-setup-announce');
      expect(announce).toHaveTextContent('Your pool is ready');
      expect(announce).not.toHaveTextContent('need attention');
    });

    it('calls a never-read inbound row half paired after its second 403 without waiting for the third strike', async () => {
      fixtures.pool = poolWith([
        poolPeer({
          id: 'p-early',
          nodeFqdn: 'hub-h.example-tailnet.ts.net',
          displayName: 'early-hub',
          direction: 'inbound',
          status: 'connected',
          lastSeenAt: null,
          lastCapabilities: null,
          consecutiveFailures: 2,
          probeFailure: { kind: 'unreachable', action: null, httpStatus: 403 },
        }),
      ]);
      renderWizard();

      const row = await screen.findByTestId('pool-setup-connected-p-early');
      expect(row).toHaveAttribute('data-state', 'half_paired');
      expect(within(row).getByRole('button', { name: 'Unpair' })).toBeInTheDocument();
    });
  });

  it('a disabled peer says it is switched off for routing', async () => {
    fixtures.pool = poolWith([poolPeer({ enabled: false })]);
    renderWizard();

    expect(await screen.findByText('Switched off for routing.')).toBeInTheDocument();
    expect(screen.queryByTestId('pool-setup-success')).not.toBeInTheDocument();
  });

  it('the success panel shows connected Hub and model counts, and Add another Hub returns to Find and scans', async () => {
    fixtures.pool = poolWith([
      poolPeer({ id: 'p1' }),
      poolPeer({
        id: 'p2',
        nodeFqdn: 'hub-d.example-tailnet.ts.net',
        displayName: 'hub-d',
        lastCapabilities: { hardwareTier: 'server', updatedAt: 'x', backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['gemma4:12b'] }] },
      }),
    ]);
    const user = userEvent.setup();
    renderWizard();

    expect(await screen.findByTestId('pool-setup-success-hubs')).toHaveTextContent('2');
    // llama3.2:3b (local and p1), qwen3:8b (p1), gemma4:12b (p2).
    expect(screen.getByTestId('pool-setup-success-models')).toHaveTextContent('3');
    expect(screen.getByRole('heading', { name: 'Your pool is ready' })).toBeInTheDocument();
    expect(screen.getByTestId('pool-setup-announce')).toHaveTextContent('Your pool is ready');
    expect(screen.getAllByRole('button', { name: 'Done' })).toHaveLength(1);

    await user.click(button('Add another Hub'));

    expect(await heading('Find your Hubs')).toBeInTheDocument();
    await waitFor(() => expect(fixtures.listDiscoverable).toHaveBeenCalledTimes(1));
  });

  it('does not say apps route across the pool when this Hub does not send work to its peers', async () => {
    fixtures.pool = poolWith([poolPeer()], {
      directions: { outbound: { enabled: false, disabledBy: 'setting' }, inbound: { enabled: true, disabledBy: null } },
    });
    renderWizard();

    const success = await screen.findByTestId('pool-setup-success');

    expect(within(success).queryByText(/Apps on this Hub now use the whole pool/)).not.toBeInTheDocument();
    expect(within(success).getByText(/Sending to other Hubs is off/)).toBeInTheDocument();
  });

  it('says apps route across the pool when this Hub does send work to its peers', async () => {
    fixtures.pool = poolWith([poolPeer()]);
    renderWizard();

    expect(await screen.findByText('Apps on this Hub now use the whole pool, with failover.')).toBeInTheDocument();
  });

  it('Done closes the dialog', async () => {
    fixtures.pool = poolWith([poolPeer()]);
    const user = userEvent.setup();
    const { onOpenChange } = renderWizard();

    await user.click(await screen.findByRole('button', { name: 'Done' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('offers Add another Hub and Done while a request waits and nothing is verified yet', async () => {
    fixtures.pool = poolWith([waitingPeer()]);
    renderWizard();

    expect(await screen.findByRole('button', { name: 'Add another Hub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('with nothing sent shows the empty message and Find Hubs', async () => {
    fixtures.pool = poolWith([incomingPeer({ id: 'in-1' })]);
    fixtures.rejectPeer.mockImplementation(async () => {
      fixtures.pool = poolStatus();
      return sdkOk({});
    });
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('button', { name: 'Reject' }));

    expect(await screen.findByText('No requests yet. Find a Hub to send one.')).toBeInTheDocument();
    await user.click(button('Find Hubs'));
    expect(await heading('Find your Hubs')).toBeInTheDocument();
  });
});

describe('demo mode', () => {
  beforeEach(() => {
    fixtures.demo = true;
  });

  it('disables Send and the PIN field, even with exactly one Hub chosen', async () => {
    const user = userEvent.setup();
    renderWizard();
    await choose(user, 'hub-b');

    expect(sendButton()).toBeDisabled();
    expect(screen.getByLabelText('PIN from the other Hub')).toBeDisabled();
  });

  it('disables Approve, Reject and Cancel request', async () => {
    fixtures.pool = poolWith([incomingPeer({ id: 'in-1' }), waitingPeer()]);
    renderWizard();

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeDisabled();
  });

  it('disables Turn on Hub Pool and Connect Tailscale', async () => {
    fixtures.pool = poolStatus({ enabled: false, disabledBy: 'setting', settings: { ...poolStatus().settings, poolEnabled: false } });
    fixtures.ts = tailscaleStatus({ connected: false });
    renderWizard();

    expect(await screen.findByRole('button', { name: 'Turn on Hub Pool' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connect Tailscale' })).toBeDisabled();
  });
});

describe('accessibility', () => {
  it('the stepper is an ordered list with aria-current step on the active item', async () => {
    const user = userEvent.setup();
    renderWizard();
    await choose(user, 'hub-b');

    const list = screen.getByRole('list', { name: 'Setup progress' });
    const items = within(list).getAllByRole('listitem');
    expect(list.tagName).toBe('OL');
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([null, 'step', null, null]);
    expect(within(items[0] as HTMLElement).getByText('Completed')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('Current step')).toBeInTheDocument();

    await user.click(sendButton());
    await screen.findByTestId('pool-setup-step-connect');

    expect(within(screen.getByRole('list', { name: 'Setup progress' })).getAllByRole('listitem')[2]).toHaveAttribute('aria-current', 'step');
  });

  it('focus moves to the new step heading on step change', async () => {
    fixtures.ts = tailscaleStatus({ httpsAvailable: false });
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('button', { name: 'Continue anyway' }));

    expect(await heading('Find your Hubs')).toHaveFocus();
  });

  it('Select all and each candidate checkbox are reachable by accessible name and operable by keyboard', async () => {
    const user = userEvent.setup();
    renderWizard();
    const hubB = await screen.findByRole('checkbox', { name: /hub-b/ });
    const hubC = screen.getByRole('checkbox', { name: /hub-c/ });
    const selectAll = screen.getByRole('checkbox', { name: 'Select all' });

    hubB.focus();
    await user.keyboard(' ');
    expect(hubB).toBeChecked();
    expect(hubC).not.toBeChecked();
    expect(selectAll).not.toBeChecked();

    selectAll.focus();
    await user.keyboard(' ');
    expect(hubB).toBeChecked();
    expect(hubC).toBeChecked();
    expect(selectAll).toBeChecked();
    expect(screen.getByRole('group', { name: 'Hubs to pair with' })).toBeInTheDocument();
  });

  it('progress and results are announced in role status regions and per-row failures use role alert', async () => {
    fixtures.pairPeer.mockImplementation(async () => sdkFail(500));
    const user = userEvent.setup();
    renderWizard();
    await screen.findByRole('checkbox', { name: /hub-b/ });
    expect(screen.getByTestId('pool-setup-find-announce')).toHaveTextContent('2 Hubs found');
    await chooseAll(user);

    await user.click(sendButton());

    expect(await screen.findByText('0 of 2 requests sent')).toHaveAttribute('role', 'status');
    expect(within(screen.getByTestId(`pool-setup-row-${HUB_B}`)).getByRole('alert')).toBeInTheDocument();
  });

  describe('the Find step announcer', () => {
    it('is one region that exists before the scan finishes, so its text change is announced and not just its arrival', async () => {
      let finish: (value: unknown) => void = () => undefined;
      fixtures.listDiscoverable.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
      renderWizard();

      const region = await screen.findByTestId('pool-setup-find-announce');
      expect(region).toHaveAttribute('role', 'status');
      expect(region).toHaveAttribute('aria-live', 'polite');
      expect(region).toHaveTextContent('Scanning your tailnet…');

      await act(async () => finish(sdkOk(fixtures.discoverable)));

      // The same node, not a new one.
      expect(await screen.findByTestId('pool-setup-find-announce')).toBe(region);
      expect(region).toHaveTextContent('2 Hubs found');
    });

    it('says so when the scan finds nothing, because the empty panel carries no live region of its own', async () => {
      fixtures.discoverable = [];
      renderWizard();

      expect(await screen.findByTestId('pool-setup-empty')).toBeInTheDocument();
      expect(screen.getByTestId('pool-setup-find-announce')).toHaveTextContent('No Hubs found');
    });

    it('goes back to announcing the scan when Rescan runs', async () => {
      const user = userEvent.setup();
      renderWizard();
      await screen.findByRole('checkbox', { name: /hub-b/ });
      let finish: (value: unknown) => void = () => undefined;
      fixtures.listDiscoverable.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));

      await user.click(button('Rescan'));

      expect(screen.getByTestId('pool-setup-find-announce')).toHaveTextContent('Scanning your tailnet…');
      await act(async () => finish(sdkOk([candidate('hub-b')])));
      await waitFor(() => expect(screen.getByTestId('pool-setup-found')).toHaveTextContent('1 Hub found'));
      expect(screen.getByTestId('pool-setup-find-announce')).toHaveTextContent('1 Hub found');
    });
  });

  it('Escape calls onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderWizard();
    await screen.findByRole('checkbox', { name: /hub-b/ });

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('names the dialog and describes it', async () => {
    renderWizard();

    const dialog = await screen.findByRole('dialog', { name: 'Set up your Hub Pool' });

    expect(dialog).toHaveAccessibleDescription('Share models across your Hubs.');
  });
});

describe('startAt', () => {
  it('opens on Find, not Approve, when asked to add a Hub and the pool already has a peer, and offers only the Hubs without a row', async () => {
    fixtures.pool = poolWith([waitingPeer({ nodeFqdn: HUB_B })]);
    fixtures.discoverable = [candidate('hub-b'), candidate('hub-c')];
    renderWizard({ startAt: 'find' });

    expect(await heading('Find your Hubs')).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: /hub-c/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /hub-b/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('pool-setup-step-approve')).not.toBeInTheDocument();
    expect(fixtures.listDiscoverable).toHaveBeenCalledTimes(1);
    expect(fixtures.pairPeer).not.toHaveBeenCalled();
  });

  it('keeps resuming on Approve for the same pool when startAt is not given, and never scans', async () => {
    fixtures.pool = poolWith([waitingPeer({ nodeFqdn: HUB_B })]);
    renderWizard();

    expect(await heading('Approve on each Hub')).toBeInTheDocument();
    expect(screen.queryByTestId('pool-setup-step-find')).not.toBeInTheDocument();
    expect(fixtures.listDiscoverable).not.toHaveBeenCalled();
  });

  it('opens on Find with startAt when the pool is empty and the Hub is ready, exactly as it does without it', async () => {
    renderWizard({ startAt: 'find' });

    expect(await heading('Find your Hubs')).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: /hub-b/ })).toBeInTheDocument();
    expect(fixtures.listDiscoverable).toHaveBeenCalledTimes(1);
  });

  it('opens on the readiness check instead, with a Hub that cannot pair yet, rather than scanning from a Hub that cannot answer', async () => {
    fixtures.pool = poolWith([poolPeer()]);
    fixtures.ts = tailscaleStatus({ connected: false });
    renderWizard({ startAt: 'find' });

    expect(await heading('Is this Hub ready?')).toBeInTheDocument();
    expect(button('Continue')).toBeDisabled();
    expect(fixtures.listDiscoverable).not.toHaveBeenCalled();
  });

  it('still lets the user reach the existing pairings from Find, with the Review button', async () => {
    fixtures.pool = poolWith([poolPeer()]);
    const user = userEvent.setup();
    renderWizard({ startAt: 'find' });

    await user.click(await screen.findByRole('button', { name: 'Review' }));

    expect(await heading('Approve on each Hub')).toBeInTheDocument();
    expect(screen.getByTestId('pool-setup-connected-peer-1')).toBeInTheDocument();
  });
});

describe('Hub cards in the steps', () => {
  describe('on the Find step', () => {
    it('shows what the tailnet said about each Hub, its OS and whether it is online, and nothing it has not said', async () => {
      fixtures.discoverable = [
        candidate('hub-b', { os: 'linux', online: true }),
        candidate('hub-c', { os: 'macOS', online: false }),
        candidate('hub-d'),
      ];
      renderWizard();

      const labelOf = async (hostname: string) =>
        (await screen.findByRole('checkbox', { name: new RegExp(hostname) })).closest('label') as HTMLElement;
      const hubB = await labelOf('hub-b');
      const hubC = await labelOf('hub-c');
      const hubD = await labelOf('hub-d');

      expect(within(hubB).getByText('hub-b')).toBeInTheDocument();
      expect(within(hubB).getByTitle(HUB_B)).toBeInTheDocument();
      expect(within(hubB).getByText('Linux')).toBeInTheDocument();
      expect(within(hubB).getByText('Online')).toBeInTheDocument();
      expect(within(hubC).getByText('macOS')).toBeInTheDocument();
      expect(within(hubC).getByText('Offline')).toBeInTheDocument();
      expect(hubD).not.toHaveTextContent(/Linux|macOS|Windows|Other|Online|Offline/);
    });

    it('does not show a tier, models, load or engines before a Hub has been paired and has said so itself', async () => {
      fixtures.discoverable = [candidate('hub-b', { os: 'linux', online: true })];
      renderWizard();

      const label = (await screen.findByRole('checkbox', { name: /hub-b/ })).closest('label') as HTMLElement;

      expect(label).not.toHaveTextContent(/High-end|Mid-range|CPU only|models?\b|running|No engine running|Signed identity|Token pairing/);
    });
  });

  describe('on the Connect step', () => {
    const osFixtures = () => {
      fixtures.discoverable = [candidate('hub-b', { os: 'linux', online: true }), candidate('hub-c', { os: 'windows', online: false })];
    };

    it('keeps the OS and the online flag after Send, sends neither to the other Hub, and keeps a Hub that reported nothing bare', async () => {
      osFixtures();
      fixtures.discoverable = [...fixtures.discoverable, candidate('hub-d')];
      pairingCreatesWaitingRow();
      const user = userEvent.setup();
      renderWizard();
      await toConnectStep(user);

      const rowB = await screen.findByTestId(`pool-setup-row-${HUB_B}`);
      const rowC = screen.getByTestId(`pool-setup-row-${HUB_C}`);
      const rowD = screen.getByTestId('pool-setup-row-hub-d.example-tailnet.ts.net');
      await waitFor(() => expect(rowB).toHaveAttribute('data-state', 'sent'));

      expect(within(rowB).getByText('Linux')).toBeInTheDocument();
      expect(within(rowB).getByText('Online')).toBeInTheDocument();
      expect(within(rowB).getByText('Request sent')).toBeInTheDocument();
      expect(within(rowC).getByText('Windows')).toBeInTheDocument();
      expect(within(rowC).getByText('Offline')).toBeInTheDocument();
      expect(rowD).not.toHaveTextContent(/Linux|macOS|Windows|Other|Online|Offline/);
      // Display only: the request names the Hub and what this Hub calls it, and nothing the tailnet reported.
      expect(fixtures.pairPeer).toHaveBeenCalledWith({ body: { nodeFqdn: HUB_B, displayName: 'hub-b' } });
      expect(fixtures.pairPeer).toHaveBeenCalledWith({ body: { nodeFqdn: HUB_C, displayName: 'hub-c' } });
    });

    it('keeps the OS and the online flag on a Hub whose request failed and was retried', async () => {
      osFixtures();
      let hubBFailedOnce = false;
      fixtures.pairPeer.mockImplementation(async ({ body }: { body: { nodeFqdn: string } }) => {
        if (body.nodeFqdn === HUB_B && !hubBFailedOnce) {
          hubBFailedOnce = true;
          return sdkFail(500);
        }
        return sdkOk({}, 201);
      });
      const user = userEvent.setup();
      renderWizard();
      await toConnectStep(user);

      const rowB = await screen.findByTestId(`pool-setup-row-${HUB_B}`);
      await waitFor(() => expect(rowB).toHaveAttribute('data-state', 'failed'));
      expect(within(rowB).getByText('Linux')).toBeInTheDocument();
      expect(within(rowB).getByText('Online')).toBeInTheDocument();

      await user.click(within(rowB).getByRole('button', { name: 'Retry hub-b' }));

      await waitFor(() => expect(screen.getByTestId(`pool-setup-row-${HUB_B}`)).toHaveAttribute('data-state', 'sent'));
      const retried = screen.getByTestId(`pool-setup-row-${HUB_B}`);
      expect(within(retried).getByText('Linux')).toBeInTheDocument();
      expect(within(retried).getByText('Online')).toBeInTheDocument();
    });

    it('keeps the OS and the online flag on every Hub after Retry failed requests', async () => {
      osFixtures();
      let failing = true;
      fixtures.pairPeer.mockImplementation(async () => (failing ? sdkFail(500) : sdkOk({}, 201)));
      const user = userEvent.setup();
      renderWizard();
      await toConnectStep(user);
      await screen.findByRole('button', { name: 'Retry failed requests' });
      failing = false;

      await user.click(button('Retry failed requests'));

      await waitFor(() => expect(screen.getByTestId(`pool-setup-row-${HUB_C}`)).toHaveAttribute('data-state', 'sent'));
      expect(within(screen.getByTestId(`pool-setup-row-${HUB_B}`)).getByText('Linux')).toBeInTheDocument();
      expect(within(screen.getByTestId(`pool-setup-row-${HUB_C}`)).getByText('Windows')).toBeInTheDocument();
      expect(within(screen.getByTestId(`pool-setup-row-${HUB_C}`)).getByText('Offline')).toBeInTheDocument();
    });

    it('keeps the OS and the online flag when a vanished request is paired again from the Approve step', async () => {
      osFixtures();
      const user = userEvent.setup();
      renderWizard();
      await choose(user, 'hub-b');
      await user.click(sendButton());
      await screen.findByText('1 of 1 request sent');
      await user.click(button('Continue'));
      const notice = await screen.findByTestId('pool-setup-vanished');

      pairingCreatesWaitingRow();
      await user.click(within(notice).getByRole('button', { name: 'Pair again' }));

      const row = await screen.findByTestId(`pool-setup-row-${HUB_B}`);
      expect(within(row).getByText('Linux')).toBeInTheDocument();
      expect(within(row).getByText('Online')).toBeInTheDocument();
    });
  });

  describe('on the Approve step', () => {
    const studio = (overrides: Partial<ReturnType<typeof poolPeer>> = {}) =>
      poolPeer({
        id: 'p-studio',
        nodeFqdn: 'studio-1.example-tailnet.ts.net',
        displayName: 'studio',
        authMode: 'signed',
        inFlightRequests: 3,
        lastCapabilities: {
          hardwareTier: 'high',
          updatedAt: '2026-10-01T10:00:00.000Z',
          backends: [
            { type: 'ollama', healthy: true, modelsLoaded: ['a', 'b'] },
            { type: 'vllm', healthy: false, modelsLoaded: ['c'] },
            { type: 'lemonade', healthy: true, modelsLoaded: ['a', 'd'] },
          ],
        },
        ...overrides,
      });

    it('shows a verified Hub with its name, address, tier, model count, load, identity and only the engines that are running', async () => {
      fixtures.pool = poolWith([studio()]);
      renderWizard();

      const row = await screen.findByTestId('pool-setup-connected-p-studio');

      expect(row).toHaveAttribute('data-state', 'verified');
      expect(summaryOf(row).getByText('studio')).toBeInTheDocument();
      expect(summaryOf(row).getByTitle('studio-1.example-tailnet.ts.net')).toBeInTheDocument();
      expect(summaryOf(row).getByText('Verified')).toBeInTheDocument();
      expect(within(row).getByText('High-end')).toBeInTheDocument();
      // a, b and d: the unhealthy engine's model does not count.
      expect(within(row).getByText('3 models')).toBeInTheDocument();
      expect(within(row).getByText('3 running')).toBeInTheDocument();
      expect(within(row).getByText('Signed identity')).toBeInTheDocument();
      expect(within(row).getByText('lemonade')).toBeInTheDocument();
      expect(within(row).getByText('ollama')).toBeInTheDocument();
      expect(within(row).queryByText('vllm')).not.toBeInTheDocument();
      expect(within(row).queryByText('No engine running')).not.toBeInTheDocument();
      // Healthy engines in a stable order: by name.
      expect((row.textContent ?? '').indexOf('lemonade')).toBeLessThan((row.textContent ?? '').indexOf('ollama'));
    });

    it('shows a single No engine running tag, and no engine names, when the Hub reported engines and none is running', async () => {
      fixtures.pool = poolWith([
        studio({
          lastCapabilities: {
            hardwareTier: 'medium',
            updatedAt: '2026-10-01T10:00:00.000Z',
            backends: [
              { type: 'ollama', healthy: false, modelsLoaded: ['a'] },
              { type: 'vllm', healthy: false, modelsLoaded: [] },
            ],
          },
        }),
      ]);
      renderWizard();

      const row = await screen.findByTestId('pool-setup-connected-p-studio');

      expect(within(row).getAllByText('No engine running')).toHaveLength(1);
      expect(within(row).queryByText('ollama')).not.toBeInTheDocument();
      expect(within(row).queryByText('vllm')).not.toBeInTheDocument();
      expect(within(row).getByText('0 models')).toBeInTheDocument();
      expect(within(row).getByText('Mid-range')).toBeInTheDocument();
      expect(within(row).getByText('Verified')).toBeInTheDocument();
    });

    it('shows no engine tag at all, not even No engine running, when the Hub reported no engines', async () => {
      fixtures.pool = poolWith([studio({ lastCapabilities: { hardwareTier: 'cpu-only', updatedAt: '2026-10-01T10:00:00.000Z', backends: [] } })]);
      renderWizard();

      const row = await screen.findByTestId('pool-setup-connected-p-studio');

      expect(within(row).queryByText('No engine running')).not.toBeInTheDocument();
      expect(within(row).getByText('CPU only')).toBeInTheDocument();
      expect(within(row).getByText('0 models')).toBeInTheDocument();
    });

    it('shows a tier only for a valid one, so a value from a newer build never appears as a raw string', async () => {
      fixtures.pool = poolWith([studio({ lastCapabilities: { hardwareTier: 'quantum', updatedAt: '2026-10-01T10:00:00.000Z', backends: [] } })]);
      renderWizard();

      const row = await screen.findByTestId('pool-setup-connected-p-studio');

      expect(row).not.toHaveTextContent(/quantum|High-end|Mid-range|CPU only/);
    });

    it('does not say how many requests a Hub is serving while it is idle', async () => {
      fixtures.pool = poolWith([studio({ inFlightRequests: 0 })]);
      renderWizard();

      expect(await screen.findByTestId('pool-setup-connected-p-studio')).not.toHaveTextContent(/running/);
    });

    it('shows Token pairing for a bearer peer, and no identity at all when the peer does not say', async () => {
      fixtures.pool = poolWith([
        studio({ authMode: 'bearer' }),
        studio({ id: 'p-bare', nodeFqdn: 'bare-1.example-tailnet.ts.net', displayName: 'bare', authMode: undefined }),
      ]);
      renderWizard();

      expect(within(await screen.findByTestId('pool-setup-connected-p-studio')).getByText('Token pairing')).toBeInTheDocument();
      expect(screen.getByTestId('pool-setup-connected-p-bare')).not.toHaveTextContent(/Signed identity|Token pairing/);
    });

    it('shows Reading… and none of the Hub’s own report while its models have not been read yet', async () => {
      fixtures.pool = poolWith([studio({ lastSeenAt: null })]);
      renderWizard();

      const row = await screen.findByTestId('pool-setup-connected-p-studio');

      expect(row).toHaveAttribute('data-state', 'verifying');
      expect(within(row).getByText('Reading…')).toBeInTheDocument();
      expect(within(row).queryByText('Verified')).not.toBeInTheDocument();
      expect(row).not.toHaveTextContent(/High-end|models?\b|running|lemonade|ollama|No engine running/);
      expect(screen.queryByTestId('pool-setup-success')).not.toBeInTheDocument();
    });

    it('shows Needs attention and none of the stale capabilities for a Hub that stopped answering', async () => {
      fixtures.pool = poolWith([studio({ status: 'unreachable' })]);
      renderWizard();

      const row = await screen.findByTestId('pool-setup-connected-p-studio');

      expect(within(row).getByText('Needs attention')).toBeInTheDocument();
      expect(within(row).getByText(/Not answering/)).toBeInTheDocument();
      expect(row).not.toHaveTextContent(/High-end|models?\b|running|lemonade|ollama/);
    });

    it('shows Off for a Hub switched off for routing', async () => {
      fixtures.pool = poolWith([studio({ enabled: false })]);
      renderWizard();

      const row = await screen.findByTestId('pool-setup-connected-p-studio');

      expect(within(row).getByText('Off')).toBeInTheDocument();
      expect(row).not.toHaveTextContent(/Verified|Needs attention/);
    });

    it('shows Awaiting approval for a request this Hub sent, and Wants to join for one it received', async () => {
      fixtures.pool = poolWith([waitingPeer(), incomingPeer()]);
      renderWizard();

      expect(within(await screen.findByTestId('pool-setup-waiting-peer-wait')).getByText('Awaiting approval')).toBeInTheDocument();
      expect(within(screen.getByTestId('pool-setup-incoming-peer-in')).getByText('Wants to join')).toBeInTheDocument();
    });

    it('titles a card by the display name, else by the host part of the tailnet name, with the whole tailnet name as the address either way', async () => {
      fixtures.pool = poolWith([
        poolPeer({ id: 'p-named', nodeFqdn: 'core-3.example-tailnet.ts.net', displayName: 'Studio Hub' }),
        poolPeer({ id: 'p-bare', nodeFqdn: 'core-4.example-tailnet.ts.net', displayName: null }),
        waitingPeer({ id: 'w-bare', nodeFqdn: 'core-5.example-tailnet.ts.net', displayName: null }),
        waitingPeer({ id: 'w-named', nodeFqdn: 'core-6.example-tailnet.ts.net', displayName: 'Loft Hub' }),
      ]);
      renderWizard();

      const named = await screen.findByTestId('pool-setup-connected-p-named');
      const bare = screen.getByTestId('pool-setup-connected-p-bare');
      const waitingBare = screen.getByTestId('pool-setup-waiting-w-bare');
      const waitingNamed = screen.getByTestId('pool-setup-waiting-w-named');

      expect(summaryOf(named).getByText('Studio Hub')).toBeInTheDocument();
      expect(summaryOf(named).getByTitle('core-3.example-tailnet.ts.net')).toBeInTheDocument();
      expect(summaryOf(bare).getByText('core-4')).toBeInTheDocument();
      expect(summaryOf(bare).getByTitle('core-4.example-tailnet.ts.net')).toBeInTheDocument();
      expect(summaryOf(waitingBare).getByText('core-5')).toBeInTheDocument();
      expect(summaryOf(waitingBare).getByTitle('core-5.example-tailnet.ts.net')).toBeInTheDocument();
      expect(summaryOf(waitingNamed).getByText('Loft Hub')).toBeInTheDocument();
      expect(summaryOf(waitingNamed).getByTitle('core-6.example-tailnet.ts.net')).toBeInTheDocument();
    });

    describe('order', () => {
      const hub = (id: string, displayName: string | null, overrides: Partial<ReturnType<typeof poolPeer>> = {}) =>
        poolPeer({ id, displayName, nodeFqdn: `${id.replace(/^p-/, '')}.example-tailnet.ts.net`, ...overrides });
      const alpha = hub('p-alpha', 'alpha');
      const core2 = hub('p-core-2', 'core-2');
      // Not Verified: a Hub that needs a look sits among the others by its name, not after them.
      const core10 = hub('p-core-10', 'Core-10', { status: 'unreachable' });
      // No display name, so it is titled by the host part of its tailnet name.
      const delta1 = hub('p-delta-1', null);
      const twinA = hub('p-twin-a', 'Twin');
      const twinB = hub('p-twin-b', 'Twin');
      /** The cards in the order they must appear: numbers count as numbers and case does not matter, so core-2 comes before Core-10, and equal names fall back to the id. */
      const EXPECTED = [alpha, core2, core10, delta1, twinA, twinB].map((peer) => peer.id);
      /** The ids of the connected cards, top to bottom. */
      const connectedOrder = () =>
        within(screen.getByTestId('pool-setup-connected'))
          .getAllByTestId(/^pool-setup-connected-/)
          .map((card) => card.getAttribute('data-testid')?.replace('pool-setup-connected-', ''));

      it('lists the connected Hubs by the name on their card, however the server orders them', async () => {
        fixtures.pool = poolWith([twinB, core10, delta1, alpha, twinA, core2]);
        renderWizard();

        await screen.findByTestId('pool-setup-connected');

        expect(connectedOrder()).toEqual(EXPECTED);
        // The order follows the title on the card, so check the cards carry the titles it was worked out from.
        const titled = [
          [alpha, 'alpha'],
          [core2, 'core-2'],
          [core10, 'Core-10'],
          [delta1, 'delta-1'],
          [twinA, 'Twin'],
          [twinB, 'Twin'],
        ] as const;
        for (const [peer, title] of titled) {
          expect(summaryOf(screen.getByTestId(`pool-setup-connected-${peer.id}`)).getByText(title)).toBeInTheDocument();
        }
      });

      it('keeps that order when a later poll returns the same Hubs in another order', async () => {
        fixtures.pool = poolWith([core2, twinB, alpha, delta1, core10, twinA]);
        const { client } = renderWizard();
        await screen.findByTestId('pool-setup-connected');
        expect(connectedOrder()).toEqual(EXPECTED);

        const reads = fixtures.poolReads;
        fixtures.pool = poolWith([twinA, delta1, core10, twinB, core2, { ...alpha, inFlightRequests: 2 }]);
        await act(async () => {
          await client.invalidateQueries();
        });

        // The new status was read and drawn (alpha now shows its load), and no card moved.
        expect(fixtures.poolReads).toBeGreaterThan(reads);
        expect(await within(screen.getByTestId('pool-setup-connected-p-alpha')).findByText('2 running')).toBeInTheDocument();
        expect(connectedOrder()).toEqual(EXPECTED);
      });
    });
  });
});

describe('the action bar of each step', () => {
  it('keeps the primary action last in the footer of the readiness step', async () => {
    fixtures.ts = tailscaleStatus({ httpsAvailable: false });
    renderWizard();
    await heading('Is this Hub ready?');

    expect(footerButtons()).toEqual(['Check again', 'Continue anyway']);
  });

  it('keeps the primary action last on the Find step, and still shows it as Choose Hubs while nothing is chosen', async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByRole('checkbox', { name: /hub-b/ });
    expect(footerButtons()).toEqual(['Back', 'Rescan', 'Choose Hubs']);

    await choose(user, 'hub-b');

    expect(footerButtons()).toEqual(['Back', 'Rescan', 'Send 1 request']);
  });

  it('leaves Rescan as the last button on the Find step when the scan found nothing to send to', async () => {
    fixtures.discoverable = [];
    renderWizard();
    await screen.findByTestId('pool-setup-empty');

    expect(footerButtons()).toEqual(['Back', 'Rescan']);
  });

  it('keeps the primary action last on the Connect step, with Retry failed requests before it only while something failed', async () => {
    fixtures.pairPeer.mockImplementation(async () => sdkFail(500));
    const user = userEvent.setup();
    renderWizard();
    await toConnectStep(user);
    await screen.findByRole('button', { name: 'Retry failed requests' });

    expect(footerButtons()).toEqual(['Back', 'Retry failed requests', 'Continue']);
  });

  it('keeps the primary action last on the Connect step when nothing failed', async () => {
    pairingCreatesWaitingRow();
    const user = userEvent.setup();
    renderWizard();
    await toConnectStep(user);
    await screen.findByText('2 of 2 requests sent');

    expect(footerButtons()).toEqual(['Back', 'Continue']);
  });

  it('keeps Done last on the Approve step, and alone when there is nothing to add to', async () => {
    fixtures.pool = poolWith([poolPeer()]);
    const first = renderWizard();
    await heading('Approve on each Hub');
    expect(footerButtons()).toEqual(['Add another Hub', 'Done']);
    first.unmount();

    fixtures.pool = poolWith([incomingPeer()]);
    fixtures.rejectPeer.mockImplementation(async () => {
      fixtures.pool = poolStatus();
      return sdkOk({});
    });
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    await screen.findByTestId('pool-setup-approve-empty');

    expect(footerButtons()).toEqual(['Done']);
  });
});
