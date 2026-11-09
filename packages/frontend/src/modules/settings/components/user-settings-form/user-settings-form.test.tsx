import { render, screen, userEvent, waitFor } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { type SettingsFormValues, UserSettingsForm } from './user-settings-form';

// Polyfill ResizeObserver for Radix UI
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/** Settings as a new Hub reports them: nobody set a Local domain, so the Hub filled in `localhost`. */
const newHubSettings: SettingsFormValues = {
  advancedSettings: false,
  localDomain: 'localhost',
  guestDashboard: false,
  allowAutoThemes: true,
  allowErrorMonitoring: true,
  timeZone: 'Etc/GMT',
  domain: 'example.com',
  internalIp: '192.168.1.10',
  port: 80,
  sslPort: 443,
  eventsTimeout: 5,
  maxBackups: 5,
  persistTraefikConfig: false,
  appDataPath: '/app-data',
  forwardAuthUrl: 'http://ci-hub:3000/api/auth/traefik',
  logLevel: 'info',
  themeBase: 'gray',
};

const localDomainField = () => screen.getByLabelText(/^local domain/i);

async function typeLocalDomain(value: string) {
  await userEvent.clear(localDomainField());
  await userEvent.type(localDomainField(), value);
}

const submit = () => userEvent.click(screen.getByRole('button', { name: 'Update settings' }));

it('lets a keyboard user focus a setting hint', () => {
  render(<UserSettingsForm initialValues={newHubSettings} onSubmit={vi.fn()} />);

  const hint = screen.getByRole('button', {
    name: 'This will allow non-authenticated users to see a limited dashboard and easily access the running apps on your instance.',
  });
  expect(hint).toHaveTextContent('?');
  hint.focus();
  expect(hint).toHaveFocus();
});

// The theme and every setting below it apply to the whole Hub, an owner's or admin's to change.
it("shows a member only their own language, and nothing that changes the Hub's settings", () => {
  render(<UserSettingsForm initialValues={newHubSettings} onSubmit={vi.fn()} manageHub={false} />);

  expect(screen.getByText('User settings')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: /language/i })).toBeInTheDocument();
  expect(screen.queryByText('General settings')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Update settings' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('combobox')).toHaveLength(1);
});

/** The Timezone box. Its label is not tied to it, so find it by its name. */
const timezoneField = () => screen.getAllByRole('combobox').find((box) => box.getAttribute('name') === 'timezone');

describe('UserSettingsForm Local domain check', () => {
  it('saves a change on a new Hub, where the read-only Local domain is the localhost the Hub filled in', async () => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={newHubSettings} onSubmit={onSubmit} />);

    expect(localDomainField()).toHaveAttribute('readonly');
    await userEvent.click(screen.getByRole('switch', { name: 'Enable guest dashboard' }));
    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ guestDashboard: true, localDomain: 'localhost' }));
    expect(screen.queryByText('Invalid domain')).not.toBeInTheDocument();
  });

  it.each(['localhost', 'hub.localhost'])('saves %s typed as the Local domain', async (localDomain) => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={{ ...newHubSettings, advancedSettings: true, localDomain: 'ci.lan' }} onSubmit={onSubmit} />);

    await typeLocalDomain(localDomain);
    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ localDomain }));
    expect(screen.queryByText('Invalid domain')).not.toBeInTheDocument();
  });

  it('does not block a save on a Local domain the Hub already had and the person left alone', async () => {
    // A Local domain can also come from the LOCAL_DOMAIN environment variable, for example the
    // single-label `lan` many home routers hand out. The field is read-only here, so checking it
    // could only lock the page.
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={{ ...newHubSettings, localDomain: 'lan' }} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole('switch', { name: 'Enable guest dashboard' }));
    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ guestDashboard: true, localDomain: 'lan' }));
  });

  it('still rejects a typed Local domain that is not a domain name', async () => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={{ ...newHubSettings, advancedSettings: true, localDomain: 'ci.lan' }} onSubmit={onSubmit} />);

    await typeLocalDomain('bad domain');
    await submit();

    expect(await screen.findByText('Invalid domain')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('UserSettingsForm Advanced settings messages', () => {
  const advancedSettings = { ...newHubSettings, advancedSettings: true };
  const forwardAuthField = () => screen.getByLabelText(/^forward auth url/i);

  async function retype(field: HTMLElement, value: string) {
    await userEvent.clear(field);
    if (value) {
      await userEvent.type(field, value);
    }
  }

  it.each([
    ['text that is not a URL', 'not a url'],
    ['nothing', ''],
  ])('shows a message under a Forward auth URL of %s, goes to the field and sends nothing', async (_kind, value) => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={advancedSettings} onSubmit={onSubmit} />);

    await retype(forwardAuthField(), value);
    await submit();

    expect(await screen.findByText('Invalid URL')).toBeInTheDocument();
    expect(forwardAuthField()).toHaveAttribute('aria-invalid', 'true');
    expect(forwardAuthField()).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('saves a valid Forward auth URL, including after correcting one that was refused', async () => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={advancedSettings} onSubmit={onSubmit} />);

    await retype(forwardAuthField(), 'not a url');
    await submit();
    expect(await screen.findByText('Invalid URL')).toBeInTheDocument();

    await retype(forwardAuthField(), 'https://auth.example.com/verify');
    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ forwardAuthUrl: 'https://auth.example.com/verify' }));
    expect(screen.queryByText('Invalid URL')).not.toBeInTheDocument();
  });

  it.each([
    ['Port', /^port(?! \(ssl)/i],
    ['Port (SSL)', /^port \(ssl\)/i],
    ['Events timeout', /^events timeout/i],
    ['Maximum backups to keep', /^maximum backups/i],
  ])('shows a message under an emptied %s and sends nothing', async (_name, label) => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={advancedSettings} onSubmit={onSubmit} />);
    const field = screen.getByLabelText(label);

    await retype(field, '');
    await submit();

    expect(await screen.findByText('Invalid value')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('UserSettingsForm values the Hub already had', () => {
  const brokenForwardAuth = { ...newHubSettings, forwardAuthUrl: 'not-a-url' };

  it('saves with Advanced settings off when the Hub reports a Forward auth URL the form refuses', async () => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={brokenForwardAuth} onSubmit={onSubmit} />);

    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('forwardAuthUrl');
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ port: 80, maxBackups: 5 }));
  });

  it('saves with Advanced settings on while the refused value is left as it was', async () => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={{ ...brokenForwardAuth, advancedSettings: true }} onSubmit={onSubmit} />);

    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('forwardAuthUrl');
  });

  it('still refuses that field once the person changes it to something else that is not a URL', async () => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={{ ...brokenForwardAuth, advancedSettings: true }} onSubmit={onSubmit} />);
    const field = screen.getByLabelText(/^forward auth url/i);

    await userEvent.clear(field);
    await userEvent.type(field, 'still not a url');
    await submit();

    expect(await screen.findByText('Invalid URL')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('UserSettingsForm Internal IP check', () => {
  const advancedSettings = { ...newHubSettings, advancedSettings: true };
  const internalIpField = () => screen.getByLabelText(/^internal ip/i);

  async function typeInternalIp(value: string) {
    await userEvent.clear(internalIpField());
    if (value) {
      await userEvent.type(internalIpField(), value);
    }
  }

  // INTERNAL_IP is read as it was set, so the Hub can report something that is not an IPv4 address.
  it.each([
    ['empty', ''],
    ['an IPv6 address', '::'],
    ['a name', 'hub.lan'],
  ])('saves a change when the Hub reported an Internal IP that is %s, and leaves it out of the request', async (_kind, internalIp) => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={{ ...newHubSettings, internalIp }} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole('switch', { name: 'Enable guest dashboard' }));
    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ guestDashboard: true }));
    expect(onSubmit).toHaveBeenCalledWith(expect.not.objectContaining({ internalIp: expect.anything() }));
  });

  it('saves with the field shown and left alone, whatever the Hub reported in it', async () => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={{ ...advancedSettings, internalIp: '::' }} onSubmit={onSubmit} />);

    expect(internalIpField()).toHaveValue('::');
    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Invalid IP address')).not.toBeInTheDocument();
  });

  it('sends an Internal IP the Hub reported as it is when it is an IPv4 address', async () => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={newHubSettings} onSubmit={onSubmit} />);

    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ internalIp: '192.168.1.10' }));
  });

  it('saves an Internal IP typed with stray spaces, without them', async () => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={advancedSettings} onSubmit={onSubmit} />);

    await typeInternalIp('  10.0.0.5 ');
    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ internalIp: '10.0.0.5' }));
  });

  it.each([
    ['a name', 'hub.lan'],
    ['an IPv6 address', 'fd00::1'],
    ['an address with a part too many', '10.0.0.5.1'],
    ['nothing, which the Hub cannot take in place of its address', ''],
  ])('rejects a typed Internal IP that is %s', async (_kind, typed) => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={advancedSettings} onSubmit={onSubmit} />);

    await typeInternalIp(typed);
    await submit();

    expect(await screen.findByText('Invalid IP address')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('UserSettingsForm Default app CPU limit', () => {
  it('sends an emptied field, so the saved default is cleared rather than kept', async () => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={{ ...newHubSettings, defaultAppCpuLimit: '0.5' }} onSubmit={onSubmit} />);

    await userEvent.clear(screen.getByLabelText(/^default app cpu limit/i));
    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ defaultAppCpuLimit: '' }));
  });
});

describe('UserSettingsForm Listen IP', () => {
  // The Hub still reports a Listen IP with its settings, whether or not the page shows one.
  const withStoredListenIp = { ...newHubSettings, advancedSettings: true, listenIp: '10.0.0.5' };

  it('has no Listen IP field, even with Advanced settings on', () => {
    render(<UserSettingsForm initialValues={withStoredListenIp} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText(/^internal ip/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/listen ip/i)).not.toBeInTheDocument();
    // By name as well, so the check doesn't hang on the label's string.
    expect(document.querySelector('[name="listenIp"]')).toBeNull();
  });

  it('saves every other value as it was, and leaves a stored Listen IP out of the request', async () => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={withStoredListenIp} onSubmit={onSubmit} />);

    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const { listenIp: _notSent, ...shown } = withStoredListenIp;
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining(shown));
    expect(onSubmit).toHaveBeenCalledWith(expect.not.objectContaining({ listenIp: expect.anything() }));
  });
});

describe('UserSettingsForm Timezone', () => {
  it.each([
    ['Asia/Karachi', '(GMT+5:00) Islamabad, Karachi, Tashkent (PKT)'],
    // Not a zone the list knows: it shows the entry that names it, which belongs to Europe/Amsterdam.
    ['Europe/Berlin', 'Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna'],
  ])('shows %s and saves it unchanged when the field is left alone', async (timeZone, label) => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={{ ...newHubSettings, timeZone }} onSubmit={onSubmit} />);

    // The field loads lazily, behind a placeholder box.
    await waitFor(() => expect(timezoneField()).toHaveTextContent(label), { timeout: 5000 });
    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ timeZone }));
  });
});
