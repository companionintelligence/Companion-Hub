import { render, screen } from '@testing-library/react';
import { Database } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { CompactSystemStat } from './compact-system-stat';

describe('CompactSystemStat', () => {
  it('renders title, metric, subtitle, and progress for stacked mobile layout', () => {
    render(<CompactSystemStat title="Disk space" metric="96%" subtitle="474 / 494 GB" icon={Database} progress={96} />);

    expect(screen.getByText('Disk space')).toBeInTheDocument();
    expect(screen.getByText('96%')).toBeInTheDocument();
    expect(screen.getByText('474 / 494 GB')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Disk space 96%' })).toBeInTheDocument();
  });
});
