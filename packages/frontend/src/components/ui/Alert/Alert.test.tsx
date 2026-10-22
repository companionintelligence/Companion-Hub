import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from './Alert';

/*
 * No stylesheet defines the `alert*` class names, so every box, colour and icon size has to come from
 * the Tailwind classes the component sets. These are the classes `TunnelStatusBanner` draws its box with.
 */
describe('Alert', () => {
  it.each([
    ['warning', ['border-warning/30', 'bg-warning/10', '[--alert-accent:var(--color-warning)]']],
    ['danger', ['border-destructive/30', 'bg-destructive/10', '[--alert-accent:var(--color-destructive)]']],
    ['info', ['border-info/30', 'bg-info/10', '[--alert-accent:var(--color-info)]']],
    ['success', ['border-success/30', 'bg-success/10', '[--alert-accent:var(--color-success)]']],
    ['default', ['border-border/60', 'bg-muted/40']],
  ] as const)('draws a %s box', (variant, colours) => {
    render(<Alert variant={variant}>Text</Alert>);

    const box = screen.getByRole('alert');
    expect(box).toHaveClass('flex', 'items-start', 'gap-2.5', 'rounded-lg', 'border', 'px-4', 'py-3', 'text-sm', 'shadow-sm', ...colours);
  });

  it('draws the default box when no variant is given', () => {
    render(<Alert>Text</Alert>);

    expect(screen.getByRole('alert')).toHaveClass('border-border/60', 'bg-muted/40');
  });

  it('colours the icon and the heading with the variant, sizes the icon to the text and mutes the text under a heading', () => {
    render(
      <Alert variant="warning">
        <AlertIcon data-testid="icon">
          <svg />
        </AlertIcon>
        <div>
          <AlertHeading>Heading</AlertHeading>
          <AlertDescription>Under the heading</AlertDescription>
        </div>
      </Alert>,
    );

    expect(screen.getByTestId('icon')).toHaveClass('shrink-0', 'text-[color:var(--alert-accent)]', '[&>svg]:h-4', '[&>svg]:w-4');
    expect(screen.getByRole('heading', { name: 'Heading' })).toHaveClass('font-semibold', 'text-[color:var(--alert-heading)]');
    expect(screen.getByText('Under the heading')).toHaveClass('[.alert-heading+&]:text-muted-foreground');
  });

  // The accent alone is too faint for a heading in places: the red on a dark card is 4.2:1.
  it('mixes the heading colour toward the text colour in both themes', () => {
    render(<Alert variant="danger">Text</Alert>);

    const box = screen.getByRole('alert');
    expect(box).toHaveClass('[--alert-heading:color-mix(in_srgb,var(--alert-accent)_75%,var(--color-foreground))]');
    expect(box.className).not.toMatch(/dark:\[--alert-heading/);
  });

  it('leaves room for a close button when dismissible', () => {
    render(<Alert dismissible>Text</Alert>);

    expect(screen.getByRole('alert')).toHaveClass('alert-dismissible', 'pr-10');
  });

  it('lets a caller replace the layout, so a hidden alert is not also flex', () => {
    render(
      <>
        <Alert data-testid="hidden" className="hidden">
          Hidden
        </Alert>
        <Alert data-testid="centred" className="items-center gap-3">
          Centred
        </Alert>
      </>,
    );

    expect(screen.getByTestId('hidden')).toHaveClass('hidden');
    expect(screen.getByTestId('hidden')).not.toHaveClass('flex');
    expect(screen.getByTestId('centred')).toHaveClass('items-center', 'gap-3');
    expect(screen.getByTestId('centred')).not.toHaveClass('items-start', 'gap-2.5');
  });
});
