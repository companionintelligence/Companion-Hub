import { render, screen } from '@/tests/test-utils';
import { describe, expect, it } from 'vitest';
import { InputGroup } from './InputGroup';

const LONG_SUFFIX = '-very-long-org-name-with-domain-that-should-wrap.example.com';

describe('InputGroup', () => {
  // Previously this suffix used `whitespace-normal break-all`, which kept it inside
  // the row but broke the domain mid-word onto a second line and made the suffix
  // taller than the h-9 input — visible as a layout bug in the install dialog.
  // It now truncates on one line, matching how CloudflareSubdomainField renders its
  // own element suffix, with the full value still exposed via `title`.
  it('keeps a long suffix on one line and constrains it inside the row', () => {
    render(<InputGroup name="localSubdomain" label="Subdomain" groupPrefix="https://" groupSuffix={LONG_SUFFIX} />);

    const suffix = screen.getByText(LONG_SUFFIX);
    expect(suffix).toHaveClass('truncate');

    const container = suffix.parentElement;
    expect(container).toHaveClass('max-w-[50%]');
    expect(container).toHaveClass('min-w-0');
    // Matches the input height so the row does not grow when the suffix is long.
    expect(container).toHaveClass('h-9');
  });

  it('exposes the full suffix via title so truncation never hides the domain', () => {
    render(<InputGroup name="localSubdomain" label="Subdomain" groupPrefix="https://" groupSuffix={LONG_SUFFIX} />);

    expect(screen.getByText(LONG_SUFFIX).parentElement).toHaveAttribute('title', LONG_SUFFIX);
  });

  it('keeps the default prefix the same height as the field', () => {
    render(<InputGroup name="localSubdomain" label="Subdomain" groupPrefix="https://" />);

    expect(screen.getByText('https://')).toHaveClass('h-9');
  });
  describe('accessible names', () => {
    it('names a field by its prefix when it has no label of its own', () => {
      render(<InputGroup name="maxLines" groupPrefix="Max lines" type="number" />);

      expect(screen.getByRole('spinbutton', { name: 'Max lines' })).toBeInTheDocument();
    });

    it('does not name a labelled field by its prefix as well', () => {
      render(<InputGroup name="localSubdomain" label="Subdomain" groupPrefix="https://" />);

      expect(screen.getByRole('textbox', { name: 'Subdomain' })).toBeInTheDocument();
    });
  });

  describe('errors', () => {
    it('marks the field invalid and ties the message to it', () => {
      render(<InputGroup name="port" label="Port" error="Port is taken" />);

      const input = screen.getByRole('textbox', { name: 'Port' });
      const message = screen.getByRole('alert');

      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(message).toHaveTextContent('Port is taken');
      expect(input.getAttribute('aria-describedby')).toContain(message.id);
    });

    it('keeps a describedby the caller supplied alongside the error', () => {
      render(<InputGroup name="port" label="Port" error="Port is taken" aria-describedby="port-hint" />);

      expect(screen.getByRole('textbox', { name: 'Port' }).getAttribute('aria-describedby')).toMatch(/^port-hint /);
    });

    it('is not invalid and has no alert when there is no error', () => {
      render(<InputGroup name="port" label="Port" />);

      expect(screen.getByRole('textbox', { name: 'Port' })).not.toHaveAttribute('aria-invalid');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('treats isInvalid as invalid without a message', () => {
      render(<InputGroup name="port" label="Port" isInvalid />);

      expect(screen.getByRole('textbox', { name: 'Port' })).toHaveAttribute('aria-invalid', 'true');
    });
  });
});
