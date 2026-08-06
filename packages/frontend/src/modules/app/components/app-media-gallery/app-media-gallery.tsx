import { Card, CardContent } from '@/components/ui/Card/Card';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { cn } from '@/lib/utils';
import { ChevronLeft, ChevronRight, Maximize2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type AppMediaGalleryProps = {
  appName: string;
  screenshots: string[];
  demoVideoUrl: string | null;
  isLoading: boolean;
};

export function AppMediaGallery({ appName, screenshots, demoVideoUrl, isLoading }: AppMediaGalleryProps) {
  const [activeShot, setActiveShot] = useState(0);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const currentShot = screenshots.length === 0 ? 0 : activeShot % screenshots.length;

  useEffect(() => {
    if (!isLightboxOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsLightboxOpen(false);
      } else if (event.key === 'ArrowLeft' && screenshots.length > 1) {
        setActiveShot((index) => (index - 1 + screenshots.length) % screenshots.length);
      } else if (event.key === 'ArrowRight' && screenshots.length > 1) {
        setActiveShot((index) => (index + 1) % screenshots.length);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isLightboxOpen, screenshots.length]);

  if (isLoading) {
    return (
      <Card className="overflow-hidden border-border/60 bg-card/80 shadow-sm">
        <CardContent className="space-y-3 p-3 sm:p-6">
          <Skeleton className="h-72 w-full rounded-xl sm:h-96" />
          <div className="flex justify-center gap-1.5">
            <Skeleton className="h-1.5 w-6 rounded-full" />
            <Skeleton className="h-1.5 w-1.5 rounded-full" />
            <Skeleton className="h-1.5 w-1.5 rounded-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (screenshots.length === 0 && !demoVideoUrl) {
    return null;
  }

  const showPrevShot = () => setActiveShot((index) => (index - 1 + screenshots.length) % screenshots.length);
  const showNextShot = () => setActiveShot((index) => (index + 1) % screenshots.length);

  // The lightbox is portalled to <body> on purpose. Rendered in place it sits inside the dashboard
  // layout's framer-motion page wrapper, whose transform + zIndex make it a containing block AND a
  // stacking context: `fixed inset-0` would then resolve against that wrapper instead of the
  // viewport (so the overlay was sized to the page, not the screen) and z-50 would be trapped below
  // the fixed header, which painted the navbar over the view and hid the close button behind it.
  //
  // It deliberately starts below the titlebar + header rather than covering them, so the window
  // controls and nav stay usable; z-40 keeps the header (z-50) on top if the two ever overlap.
  const lightbox = (
    <div
      className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-black/95 p-4"
      style={{ top: 'calc(var(--titlebar-height, 0px) + 3.5rem)' }}
      role="dialog"
      aria-modal="true"
      aria-label={`${appName} screenshots`}
    >
      <button
        type="button"
        onClick={() => setIsLightboxOpen(false)}
        aria-label="Close"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
      >
        <X className="h-6 w-6" />
      </button>

      <img
        src={screenshots[currentShot]}
        alt={`${appName} screenshot ${currentShot + 1}`}
        className="min-h-0 max-h-full max-w-[92vw] rounded-lg object-contain"
      />

      {screenshots.length > 1 && (
        <>
          <button
            type="button"
            onClick={showPrevShot}
            aria-label="Previous screenshot"
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white hover:bg-white/20 sm:left-6"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={showNextShot}
            aria-label="Next screenshot"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white hover:bg-white/20 sm:right-6"
          >
            <ChevronRight className="h-6 w-6" />
          </button>

          <div className="mt-4 flex items-center justify-center gap-1.5">
            {screenshots.map((src, index) => (
              <button
                key={`lightbox-${src}`}
                type="button"
                onClick={() => setActiveShot(index)}
                aria-label={`Show screenshot ${index + 1}`}
                className={cn('h-1.5 rounded-full transition-all', index === currentShot ? 'w-6 bg-white' : 'w-1.5 bg-white/30 hover:bg-white/50')}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      <Card className="overflow-hidden border-border/60 bg-card/80 shadow-sm">
        <CardContent className="space-y-4 p-3 sm:p-6">
          {screenshots.length > 0 ? (
            <div className="space-y-3">
              <div className="group relative">
                <button
                  type="button"
                  onClick={() => setIsLightboxOpen(true)}
                  aria-label="Open screenshot fullscreen"
                  className="block w-full overflow-hidden rounded-xl border border-border/60 bg-muted/20"
                >
                  <img
                    src={screenshots[currentShot]}
                    alt={`${appName} screenshot ${currentShot + 1}`}
                    className="h-72 w-full object-contain sm:h-96 md:h-[28rem]"
                    loading="eager"
                    decoding="async"
                  />
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/20">
                    <Maximize2 className="h-8 w-8 text-white opacity-0 transition-opacity group-hover:opacity-100" />
                  </span>
                </button>

                {screenshots.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={showPrevShot}
                      aria-label="Previous screenshot"
                      className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover:opacity-100"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      onClick={showNextShot}
                      aria-label="Next screenshot"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover:opacity-100"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </>
                )}
              </div>

              {screenshots.length > 1 && (
                <div className="flex items-center justify-center gap-1.5">
                  {screenshots.map((src, index) => (
                    <button
                      key={src}
                      type="button"
                      onClick={() => setActiveShot(index)}
                      aria-label={`Show screenshot ${index + 1}`}
                      className={cn(
                        'h-1.5 rounded-full transition-all',
                        index === currentShot ? 'w-6 bg-primary' : 'w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/50',
                      )}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {demoVideoUrl ? (
            <div className="overflow-hidden rounded-xl border border-border/60 bg-black/90">
              <video src={demoVideoUrl} controls className="max-h-[28rem] w-full" preload="metadata">
                <track kind="captions" />
              </video>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {isLightboxOpen && screenshots.length > 0 && typeof document !== 'undefined' ? createPortal(lightbox, document.body) : null}
    </>
  );
}
