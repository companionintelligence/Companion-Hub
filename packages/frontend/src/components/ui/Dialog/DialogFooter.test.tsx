import { render } from '@/tests/test-utils';
import { describe, expect, it } from 'vitest';
import { DialogFooter } from './Dialog';

describe('DialogFooter', () => {
  it('leaves a gap between stacked buttons below the sm breakpoint', () => {
    const { container } = render(
      <DialogFooter>
        <button type="button">Cancel</button>
        <button type="button">Delete</button>
      </DialogFooter>,
    );

    expect(container.firstElementChild).toHaveClass('flex-col-reverse', 'gap-2', 'sm:flex-row', 'sm:gap-0', 'sm:space-x-2');
  });
});
