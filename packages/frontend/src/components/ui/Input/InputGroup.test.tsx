import { render, screen } from '@/tests/test-utils';
import { describe, expect, it } from 'vitest';
import { InputGroup } from './InputGroup';

describe('InputGroup', () => {
  it('wraps long suffix text instead of forcing nowrap', () => {
    render(
      <InputGroup
        name="localSubdomain"
        label="Subdomain"
        groupPrefix="https://"
        groupSuffix="-very-long-org-name-with-domain-that-should-wrap.example.com"
      />,
    );

    const suffix = screen.getByText('-very-long-org-name-with-domain-that-should-wrap.example.com');

    expect(suffix).toHaveClass('whitespace-normal');
    expect(suffix).toHaveClass('break-all');
    expect(suffix).toHaveClass('max-w-[50%]');
    expect(suffix).toHaveClass('min-w-0');
  });
});
