import { fireEvent, render, screen, userEvent, waitFor } from '@/tests/test-utils';
import type { AvailableDomain } from '@ci-hub/common/types';
import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { CloudflareSubdomainField } from './cloudflare-subdomain-field';
import type { DomainListNote } from './domain-list-note';

// react-tooltip positions itself with floating-ui, which watches the anchor's size.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const SUFFIX = '-acme.ci0.pw';

const PICKER_DOMAINS: AvailableDomain[] = [
  { id: '1', domain: 'ci0.pw', isDefault: true, offered: true },
  { id: '2', domain: 'ci1.pw', isDefault: false, offered: true },
];

type Values = { localSubdomain: string; publicDomain: string };

function Field({
  note,
  onRetry = vi.fn(),
  availableDomains = [],
  onSubmit = vi.fn(),
}: {
  note: DomainListNote;
  onRetry?: () => void;
  availableDomains?: AvailableDomain[];
  onSubmit?: () => void;
}) {
  const { control, register, handleSubmit } = useForm<Values>({ defaultValues: { localSubdomain: '', publicDomain: 'ci0.pw' } });

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <CloudflareSubdomainField<Values>
        control={control}
        register={register}
        availableDomains={availableDomains}
        watchPublicDomain="ci0.pw"
        domain="ci0.pw"
        cloudflareSuffix="acme"
        placeholder="app"
        isCheckingDns={false}
        domainListNote={note}
        onRetryDomainList={onRetry}
        t={(key) => key}
      />
    </form>
  );
}

describe('CloudflareSubdomainField', () => {
  it('marks a domain list still loading with a spinner', () => {
    render(<Field note="loading" />);

    expect(screen.getByText(SUFFIX)).toHaveAttribute('title', SUFFIX);
    const mark = screen.getByRole('status', { name: 'APP_INSTALL_FORM_DOMAINS_LOADING' });
    expect(mark.querySelector('svg')).toHaveClass('animate-spin');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('explains the spinner in a tooltip on hover', async () => {
    render(<Field note="loading" />);

    await userEvent.hover(screen.getByRole('status', { name: 'APP_INSTALL_FORM_DOMAINS_LOADING' }));

    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('APP_INSTALL_FORM_DOMAINS_LOADING'));
  });

  it('offers a retry when the list could not be loaded, without submitting the form', async () => {
    const onRetry = vi.fn();
    const onSubmit = vi.fn();
    render(<Field note="unavailable" onRetry={onRetry} onSubmit={onSubmit} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'APP_INSTALL_FORM_DOMAINS_UNAVAILABLE' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('says so when the Portal answered with nothing else to offer', () => {
    render(<Field note="none-offered" />);

    expect(screen.getByRole('img', { name: 'APP_INSTALL_FORM_DOMAINS_NONE_OFFERED' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the plain domain alone when the list was never asked for', () => {
    render(<Field note={undefined} />);

    expect(screen.getByText(SUFFIX)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  /*
   * Radix's hidden native select answers a value the form sets with a change to
   * `''` when its options lag behind, which cleared the picker to its
   * placeholder while the form kept the domain.
   */
  it('keeps the domain when the hidden native select reports an empty change', () => {
    const { container } = render(<Field note={undefined} availableDomains={PICKER_DOMAINS} />);
    const native = container.querySelector('select') as HTMLSelectElement;

    fireEvent.change(native, { target: { value: '' } });

    expect(screen.getByRole('combobox', { name: 'COMMON_PUBLIC_DOMAIN' })).toHaveTextContent('ci0.pw');
  });

  it('shows the picker, and no mark, once there are domains to choose from', () => {
    render(<Field note="loading" availableDomains={[{ id: '1', domain: 'ci0.pw', isDefault: true, offered: true }]} />);

    expect(screen.getByRole('combobox', { name: 'COMMON_PUBLIC_DOMAIN' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(SUFFIX)).not.toBeInTheDocument();
  });
});
