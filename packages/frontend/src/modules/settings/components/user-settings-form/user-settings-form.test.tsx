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
  listenIp: '0.0.0.0',
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

/** The Timezone box. Its label is not tied to it, so find it by its name. */
const timezoneField = () => screen.getAllByRole('combobox').find((box) => box.getAttribute('name') === 'timezone');

describe('UserSettingsForm Local domain check', () => {
  it('saves a change on a new Hub, where the read-only Local domain is the localhost the Hub filled in', async () => {
    const onSubmit = vi.fn();
    render(<UserSettingsForm initialValues={newHubSettings} onSubmit={onSubmit} />);

    expect(localDomainField()).toHaveAttribute('readonly');
    await userEvent.click(screen.getByRole('switch', { name: 'guestDashboard' }));
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

    await userEvent.click(screen.getByRole('switch', { name: 'guestDashboard' }));
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
