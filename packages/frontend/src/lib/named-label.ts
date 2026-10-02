import { Children, isValidElement, type ReactNode } from 'react';

/** Text stays the control's name. Extra nodes, such as a hint button, sit beside it. */
export function splitNamedLabel(label: ReactNode): { named: ReactNode; extra: ReactNode } {
  const children =
    isValidElement(label) && label.type === Symbol.for('react.fragment') ? Children.toArray(label.props.children) : Children.toArray(label);
  const named = children.filter((child) => typeof child === 'string' || typeof child === 'number');
  const extra = children.filter((child) => typeof child !== 'string' && typeof child !== 'number');
  if (named.length === 0) {
    return { named: label, extra: null };
  }
  return { named, extra };
}
