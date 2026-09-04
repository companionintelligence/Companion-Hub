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
});
