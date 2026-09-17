// Custom (::-webkit-scrollbar) thumbs only react to hovering the thumb itself;
// the track has no selector that can restyle the thumb. Mark the element whose
// scrollbar strip is under the pointer so CSS can show a faded thumb there.
const ATTRIBUTE = 'data-scrollbar-hover';

function isOverVerticalScrollbar(element: Element, event: PointerEvent) {
  const scrollbarWidth = element instanceof HTMLElement ? element.offsetWidth - element.clientWidth : 0;

  if (scrollbarWidth <= 0 || element.scrollHeight <= element.clientHeight) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const scrollbarLeft = rect.left + element.clientLeft + element.clientWidth;

  return event.clientX >= scrollbarLeft && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
}

/** Starts marking the scroller under the pointer; returns a function that stops. */
export function installScrollbarHover() {
  let hovered: Element | null = null;

  const set = (next: Element | null) => {
    if (next === hovered) {
      return;
    }

    hovered?.removeAttribute(ATTRIBUTE);
    next?.setAttribute(ATTRIBUTE, '');
    hovered = next;
  };

  // Over a scrollbar, the event target is the scroller that owns it.
  const onPointerMove = (event: PointerEvent) => {
    const target = event.target;
    set(target instanceof Element && isOverVerticalScrollbar(target, event) ? target : null);
  };
  const onPointerLeave = () => set(null);

  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onPointerLeave);

  return () => {
    document.removeEventListener('pointermove', onPointerMove);
    document.documentElement.removeEventListener('pointerleave', onPointerLeave);
    set(null);
  };
}
