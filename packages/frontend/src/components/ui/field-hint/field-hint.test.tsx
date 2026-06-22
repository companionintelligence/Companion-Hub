import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HintText, LabelWithHint } from './field-hint';

describe('HintText', () => {
  it('renders children as the hover target', () => {
    render(
      <HintText id="test-hint" hint="Short explainer">
        Device ID
      </HintText>,
    );
    expect(screen.getByText('Device ID')).toBeInTheDocument();
    expect(screen.getByText('Device ID')).toHaveClass('field-hint-test-hint');
  });

  it('LabelWithHint renders label text as the hover target', () => {
    render(<LabelWithHint label="Pairing Code" hint="Copy me" hintId="pairing-code" />);
    expect(screen.getByText('Pairing Code')).toBeInTheDocument();
  });

  it('sanitizes id with spaces into a single anchor class', () => {
    render(
      <HintText id="My Feature Title" hint="help">
        Label
      </HintText>,
    );
    const anchor = screen.getByText('Label');
    expect(anchor).toHaveClass('field-hint-My-Feature-Title');
    expect(anchor.className.split(/\s+/).filter((c) => c.startsWith('field-hint-'))).toHaveLength(1);
  });
});
