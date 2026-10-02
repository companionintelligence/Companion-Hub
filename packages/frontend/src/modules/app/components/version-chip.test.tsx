import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VersionChip } from './version-chip';

describe('VersionChip', () => {
  it('uses readable foreground text on the current version', () => {
    render(<VersionChip>1.0.0</VersionChip>);

    const chip = screen.getByText('1.0.0');
    expect(chip).toHaveClass('bg-muted', 'text-foreground');
    expect(chip).not.toHaveClass('badge', 'text-white');
  });

  it('uses the success colors for the version being installed', () => {
    render(<VersionChip tone="next">2.0.0</VersionChip>);

    expect(screen.getByText('2.0.0')).toHaveClass('bg-success', 'text-success-foreground');
  });
});
