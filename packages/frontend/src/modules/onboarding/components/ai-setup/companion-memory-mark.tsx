import { Suspense, lazy, useMemo, type CSSProperties, type ComponentType } from 'react';

import { cn } from '@/lib/utils';

import brainMarkSvg from '@/assets/companion-memory-brain.svg';

/**
 * The player and the ~1.9 MB animation are fetched only when this card actually renders,
 * not on every onboarding route. `lottie-web` also reaches for a canvas 2D context at
 * import time, which jsdom doesn't provide — tests mock `lottie-react` rather than
 * relying on the lazy boundary to dodge it, since the mocked import resolves just as
 * eagerly as a real one would.
 */
const LottieMark = lazy(async () => {
  const [{ default: Lottie }, animation] = await Promise.all([import('lottie-react'), import('@/assets/companion-memory-brain.lottie.json')]);

  const Mark: ComponentType<{ style?: CSSProperties; className?: string }> = ({ style, className }) => (
    <Lottie animationData={animation.default} loop autoplay style={style} className={className} />
  );

  return { default: Mark };
});

function usePrefersReducedMotion() {
  return useMemo(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
}

/** The Companion Memory brand mark, animated where motion is welcome and safe. */
export function CompanionMemoryMark({ size = 48, className }: { size?: number; className?: string }) {
  const reducedMotion = usePrefersReducedMotion();
  const style = { width: size, height: size };
  const still = <img src={brainMarkSvg} alt="" style={style} className={cn('max-w-none shrink-0', className)} />;

  if (reducedMotion) {
    return still;
  }

  return (
    <Suspense fallback={still}>
      <LottieMark style={style} className={cn('max-w-none shrink-0', className)} />
    </Suspense>
  );
}
